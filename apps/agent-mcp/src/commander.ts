import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { SwarmClient } from "@swarms/agent-sdk";
import {
  type CommanderIntent,
  HttpChatPlanner,
  JevPlannerProvider,
  journalRecord,
  type MapInfo,
  type PlannerProvider,
  POST_TEMPLATES,
  planWithFallback,
  SPELL_COOLDOWN_TICKS,
  type SpellReadyAt,
  tactical,
} from "@swarms/commander";
import type { ZoneSnapshot } from "@swarms/protocol";
import { generateDungeon } from "@swarms/worldgen";

const url = process.env.SWARMS_WS_URL ?? "ws://127.0.0.1:18787/ws";
const seed = Number(process.env.SWARMS_SEED ?? 1337);
const dungeon = generateDungeon(seed);
const map: MapInfo = { rooms: dungeon.rooms, tileSize: dungeon.tileSize };
const baseName = process.env.COMMANDER_NAME ?? "Sable";
const plannerMs = Number(process.env.COMMANDER_PLANNER_MS ?? 4000);
const timeoutMs = Number(process.env.COMMANDER_TIMEOUT_MS ?? 15_000);
const maxPostReward = Number(process.env.COMMANDER_MAX_POST_REWARD ?? 150);
const maxOpenOwn = Number(process.env.COMMANDER_MAX_OPEN_CONTRACTS ?? 1);
const journalPath = resolve(process.env.COMMANDER_JOURNAL_PATH ?? "data/commander/journal.jsonl");
const resumePath = resolve(process.env.COMMANDER_RESUME_FILE ?? "data/commander/resume.token");

function buildProvider(): PlannerProvider | null {
  const requestedModel = process.env.COMMANDER_MODEL?.trim();
  if (requestedModel === "none" || requestedModel === "scripted") {
    return null;
  }
  if (requestedModel === "jev-v1" || requestedModel === "jev") {
    return new JevPlannerProvider(map, { maxPostReward });
  }
  const explicitKeyEnv = process.env.COMMANDER_API_KEY_ENV;
  if (explicitKeyEnv) {
    const apiKey = process.env[explicitKeyEnv];
    if (!apiKey) return new JevPlannerProvider(map, { maxPostReward });
    return new HttpChatPlanner(requestedModel ?? "gpt-4o-mini", {
      baseUrl: process.env.COMMANDER_BASE_URL ?? "https://api.openai.com/v1/chat/completions",
      apiKey,
      timeoutMs,
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    return new HttpChatPlanner(requestedModel ?? "openai/gpt-4o-mini", {
      baseUrl: process.env.COMMANDER_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions",
      apiKey: process.env.OPENROUTER_API_KEY,
      timeoutMs,
    });
  }
  if (process.env.OPENAI_API_KEY) {
    return new HttpChatPlanner(requestedModel ?? "gpt-4o-mini", {
      baseUrl: process.env.COMMANDER_BASE_URL ?? "https://api.openai.com/v1/chat/completions",
      apiKey: process.env.OPENAI_API_KEY,
      timeoutMs,
    });
  }
  return new JevPlannerProvider(map, { maxPostReward });
}

const provider = buildProvider();
const displayName = (provider ? `AI ${baseName}` : `Bot ${baseName}`).slice(0, 24);

mkdirSync(dirname(journalPath), { recursive: true });
let journalSeq = 0;
let prevHash = "genesis";
function journal(kind: string, tick: number, data: Record<string, unknown>): void {
  const record = journalRecord(++journalSeq, prevHash, tick, kind, data);
  prevHash = record.hash;
  const fd = openSync(journalPath, "a");
  writeSync(fd, `${JSON.stringify(record)}\n`);
  fsyncSync(fd);
  closeSync(fd);
}

const client = new SwarmClient(url);
let intent: CommanderIntent | null = null;
let intentSource: "model" | "fallback" = "fallback";
let planning = false;
let lastTacticalAt = 0;
let lastSentKey = "";
let lastSentAt = 0;
let commandSeqMirror = 0;
const spellReadyAt: SpellReadyAt = {};
let lastPostAtTick = -1_000_000;
const acceptedContracts = new Set<string>();

client.onMessage((message) => {
  const tick = client.lastSnapshot?.tick ?? 0;
  if (message.type === "ack") {
    journal("ack", tick, { seq: message.seq, idempotencyKey: message.idempotencyKey });
  } else if (message.type === "error") {
    journal("error", tick, { code: message.code, message: message.message, seq: message.seq });
  }
});

function handleContractAction(snapshot: ZoneSnapshot, chosen: CommanderIntent): void {
  const selfId = snapshot.selfCommanderId;
  if (chosen.contractId && !acceptedContracts.has(chosen.contractId)) {
    const contract = snapshot.contracts.find((c) => c.id === chosen.contractId);
    if (
      contract &&
      (contract.status === "open" || contract.status === "accepted") &&
      contract.issuerId !== selfId &&
      !contract.participants.includes(selfId)
    ) {
      client.acceptContract(`commander-accept:${selfId}:${contract.id}`, contract.id);
      acceptedContracts.add(contract.id);
      journal("contract:accept", snapshot.tick, { contractId: contract.id, source: intentSource });
    }
  }
  if (chosen.postTemplate && snapshot.tick - lastPostAtTick > 900) {
    const ownOpen =
      snapshot.wallet.openContracts ??
      snapshot.contracts.filter(
        (c) => c.issuerId === selfId && (c.status === "open" || c.status === "accepted"),
      ).length;
    const template = POST_TEMPLATES[chosen.postTemplate]!;
    if (ownOpen < maxOpenOwn && snapshot.wallet.sparks > template.reward + 100) {
      client.postContract(`commander-post:${selfId}:${snapshot.tick}`, template.draft);
      lastPostAtTick = snapshot.tick;
      journal("contract:post", snapshot.tick, {
        template: chosen.postTemplate,
        reward: template.reward,
        source: intentSource,
      });
    }
  }
}

async function runPlanner(snapshot: ZoneSnapshot): Promise<void> {
  if (planning) return;
  const self = snapshot.commanders.find((c) => c.id === snapshot.selfCommanderId);
  if (!self?.alive) return;
  planning = true;
  try {
    const outcome = await planWithFallback(provider, snapshot, map, { maxPostReward });
    const nowTick = client.lastSnapshot?.tick ?? snapshot.tick;
    if (outcome.intent.expiresAtTick < nowTick + 450) outcome.intent.expiresAtTick = nowTick + 450;
    intent = outcome.intent;
    intentSource = outcome.source;
    journal("planner", snapshot.tick, {
      provider: provider?.name ?? "none",
      model: provider?.model ?? "none",
      source: outcome.source,
      latencyMs: outcome.latencyMs,
      errorCode: outcome.errorCode,
      rawPreview: outcome.rawPreview,
      digest: outcome.digest,
      intent: outcome.intent,
      self: outcome.summary.self,
      threats: outcome.summary.threats,
    });
    try {
      handleContractAction(client.lastSnapshot ?? snapshot, outcome.intent);
    } catch (error) {
      journal("error", snapshot.tick, {
        code: "contract_action_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    planning = false;
  }
}

client.onSnapshot((snapshot) => {
  const now = Date.now();
  if (now - lastTacticalAt < 550) return;
  lastTacticalAt = now;
  const result = tactical(snapshot, intent, map, spellReadyAt);
  if (!result.command) return;
  const key = `${result.key}:${JSON.stringify(result.command)}`;
  if (key === lastSentKey && now - lastSentAt < 2000) return;
  lastSentKey = key;
  lastSentAt = now;
  const seq = commandSeqMirror++;
  const effectiveSource =
    intent && intent.expiresAtTick > snapshot.tick ? intentSource : "fallback";
  try {
    client.command(result.command);
  } catch (error) {
    journal("error", snapshot.tick, {
      code: "command_send_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (result.command.type === "cast") {
    spellReadyAt[result.command.spell] = snapshot.tick + SPELL_COOLDOWN_TICKS[result.command.spell];
  }
  journal("tactical", snapshot.tick, {
    seq,
    key: result.key,
    note: result.note,
    safetyOverride: result.safetyOverride,
    command: result.command,
    intentSource: effectiveSource,
  });
});

async function main(): Promise<void> {
  const resumeToken = existsSync(resumePath)
    ? readFileSync(resumePath, "utf8").trim() || undefined
    : undefined;
  const welcome = await client.connect({
    name: displayName,
    kind: "agent",
    ...(resumeToken ? { resumeToken } : {}),
  });
  mkdirSync(dirname(resumePath), { recursive: true });
  writeFileSync(resumePath, welcome.resumeToken, { mode: 0o600 });
  journal("session", client.lastSnapshot?.tick ?? 0, {
    commanderId: welcome.commanderId,
    name: displayName,
    provider: provider?.model ?? "none",
  });
  console.log(
    `commander online: ${displayName} (${welcome.commanderId}) provider=${provider ? provider.model : "none (scripted)"} journal=${journalPath}`,
  );
  const timer = setInterval(() => {
    if (client.lastSnapshot) void runPlanner(client.lastSnapshot);
  }, plannerMs);
  const shutdown = () => {
    clearInterval(timer);
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
