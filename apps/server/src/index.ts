import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import {
  RELIQUARY_ITEMS,
  RELIQUARY_RARITIES,
  RELIQUARY_SLOTS,
  type ReliquaryItemId,
} from "@swarms/content";
import { FileZoneStore } from "@swarms/persistence";
import type { CommsChannel, ContractStatus, FactionId, ServerMessage } from "@swarms/protocol";
import { parseClientMessage, SCHEMA_VERSION, SPARK_USD_RATE } from "@swarms/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import {
  boundedIntFromEnv,
  isOriginAllowed,
  KeyedTokenBuckets,
  TokenBucket,
} from "./rate-limit.ts";
import {
  buildOpenTaskDiscovery,
  buildTapAgentGuide,
  createForgeProposal,
  type ForgeProposalCategory,
  listForgeProposals,
  verifyTapHttpOrSandbox,
} from "./tap-forge.ts";
import {
  buildOpenApiSpec,
  buildVisaActionsDescriptor,
  buildVisaDescriptorBundle,
  handleVisaActionsAct,
  handleVisaActionsBatch,
  handleVisaActionsDiscover,
  handleVisaActionsRead,
  listVisaActionReceipts,
} from "./visa-actions.ts";
import { type SessionRecord, ZoneRuntime } from "./zone.ts";

const port = Number(process.env.PORT ?? 18787);
const host = process.env.HOST ?? "127.0.0.1";
const dataDir =
  process.env.SWARMS_DATA_DIR ?? new URL("../../../data/zone-1", import.meta.url).pathname;
const store = new FileZoneStore(dataDir);
const runtime = new ZoneRuntime(store, Number(process.env.SWARMS_SEED ?? 1337));
runtime.ensureBots(Number(process.env.SWARMS_BOTS ?? 2));

const maxClients = boundedIntFromEnv(process.env.SWARMS_MAX_CLIENTS, 64, 1, 1000);
const helloTimeoutMs = boundedIntFromEnv(process.env.SWARMS_HELLO_TIMEOUT_MS, 5000, 100, 60_000);
const maxInvalidFrames = boundedIntFromEnv(process.env.SWARMS_MAX_INVALID_FRAMES, 10, 1, 100);
const commandsPerSecond = boundedIntFromEnv(process.env.SWARMS_COMMANDS_PER_SECOND, 60, 1, 300);
const contractOpsPerMinute = boundedIntFromEnv(
  process.env.SWARMS_CONTRACT_OPS_PER_MINUTE,
  12,
  1,
  600,
);
const hellosPerMinutePerIp = boundedIntFromEnv(
  process.env.SWARMS_HELLOS_PER_MINUTE_PER_IP,
  10,
  1,
  600,
);
const allowedOrigins = new Set([
  "http://127.0.0.1:15173",
  "http://localhost:15173",
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  ...(process.env.SWARMS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean),
]);
const helloBuckets = new KeyedTokenBuckets(hellosPerMinutePerIp, hellosPerMinutePerIp / 60, 10_000);
const httpBuckets = new KeyedTokenBuckets(120, 2, 10_000);

interface ClientState {
  session: SessionRecord;
  worldSent: boolean;
  commands: TokenBucket;
  contracts: TokenBucket;
  worldRequests: TokenBucket;
  messages: TokenBucket;
}

interface SocketMeta {
  remoteAddress: string;
  invalidFrames: number;
  helloTimer: ReturnType<typeof setTimeout>;
}

const clients = new Map<WebSocket, ClientState>();
const sockets = new Map<WebSocket, SocketMeta>();
const MAX_BUFFERED_SNAPSHOT_BYTES = 256 * 1024;

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function sendSnapshot(ws: WebSocket, state: ClientState): boolean {
  if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED_SNAPSHOT_BYTES) return false;
  const includeWorld = !state.worldSent;
  const payload = JSON.stringify({
    type: "snapshot",
    snapshot: runtime.snapshot(state.session, { includeWorld }),
  });
  ws.send(payload);
  state.worldSent = true;
  return true;
}

const webDistDir = resolve(new URL("../../web/dist", import.meta.url).pathname);
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function isSameHostOrigin(origin: string | undefined, reqHost: string | undefined): boolean {
  if (!origin || !reqHost) return false;
  const normalized = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return normalized === `http://${reqHost}` || normalized === `https://${reqHost}`;
}

function isRequestOriginAllowed(origin: string | undefined, reqHost: string | undefined): boolean {
  return isOriginAllowed(origin, allowedOrigins) || isSameHostOrigin(origin, reqHost);
}

function corsOrigin(origin: string | undefined, reqHost?: string): string {
  if (!origin) return "*";
  const normalized = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return allowedOrigins.has(normalized) || isSameHostOrigin(origin, reqHost) ? normalized : "null";
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
  reqHost?: string,
  extraHeaders?: Record<string, string>,
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "access-control-allow-origin": corsOrigin(origin, reqHost),
    "access-control-expose-headers": "www-authenticate,x-payment-required",
    ...(extraHeaders ?? {}),
  });
  response.end(text);
}

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const origin = request.headers.origin;
  const reqHost = request.headers.host;
  if (!isRequestOriginAllowed(origin, reqHost)) {
    return json(response, 403, { error: "origin_forbidden" }, origin, reqHost);
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": corsOrigin(origin, reqHost),
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers":
        "content-type,idempotency-key,authorization,x-payment,signature-input,signature,content-digest,signature-agent,x-tap-key-id",
      "access-control-expose-headers": "www-authenticate,x-payment-required",
    });
    response.end();
    return;
  }
  const publicOrigin = reqHost ? `http://${reqHost}` : `http://${host}:${port}`;
  if (url.pathname === "/.well-known/opentask") {
    return json(response, 200, buildOpenTaskDiscovery(publicOrigin), origin, reqHost);
  }
  if (url.pathname === "/.well-known/visa-actions") {
    return json(response, 200, buildVisaActionsDescriptor(publicOrigin), origin, reqHost);
  }
  if (url.pathname === "/.well-known/visa-actions/bundle") {
    return json(response, 200, buildVisaDescriptorBundle(publicOrigin), origin, reqHost);
  }
  if (url.pathname === "/openapi.json") {
    return json(response, 200, buildOpenApiSpec(publicOrigin), origin, reqHost);
  }
  if (url.pathname === "/v1/actions/discover" && request.method === "GET") {
    const q = url.searchParams.get("q") ?? undefined;
    const pageRaw = url.searchParams.get("page");
    const result = handleVisaActionsDiscover(publicOrigin, {
      ...(q ? { q } : {}),
      ...(pageRaw ? { page: Number(pageRaw) } : {}),
    });
    return json(response, result.status, result.body, origin, reqHost);
  }
  if (url.pathname === "/v1/actions/receipts" && request.method === "GET") {
    return json(response, 200, { ok: true, receipts: listVisaActionReceipts(12) }, origin, reqHost);
  }
  if (url.pathname === "/v1/actions/batch" && request.method === "POST") {
    let bodyText = "";
    request.on("data", (chunk) => {
      if (bodyText.length < 32_768) bodyText += String(chunk);
    });
    request.on("end", async () => {
      try {
        const parsed = JSON.parse(bodyText || "{}");
        const result = await handleVisaActionsBatch(runtime, {
          headers: request.headers as Record<string, string | string[] | undefined>,
          body: parsed,
          baseUrl: publicOrigin,
        });
        return json(response, result.status, result.body, origin, reqHost);
      } catch (err) {
        return json(
          response,
          400,
          {
            ok: false,
            code: "invalid_json",
            message: err instanceof Error ? err.message : "Invalid JSON body",
            do_not_relay_to_owner: true,
          },
          origin,
          reqHost,
        );
      }
    });
    return;
  }
  if (url.pathname === "/v1/actions/read" && request.method === "GET") {
    const query: { action?: string; commander_id?: string; receipt_id?: string } = {};
    const qAction = url.searchParams.get("action");
    const qCommander = url.searchParams.get("commander_id");
    const qReceipt = url.searchParams.get("receipt_id");
    if (qAction) query.action = qAction;
    if (qCommander) query.commander_id = qCommander;
    if (qReceipt) query.receipt_id = qReceipt;
    const result = handleVisaActionsRead(runtime, query);
    return json(response, result.status, result.body, origin, reqHost);
  }
  if (url.pathname.startsWith("/v1/actions/receipts/") && request.method === "GET") {
    const receiptId = url.pathname.slice("/v1/actions/receipts/".length);
    const result = handleVisaActionsRead(runtime, {
      action: "get_receipt",
      receipt_id: receiptId,
    });
    return json(response, result.status, result.body, origin, reqHost);
  }
  if (url.pathname === "/v1/actions/act" && request.method === "POST") {
    let bodyText = "";
    request.on("data", (chunk) => {
      if (bodyText.length < 32_768) bodyText += String(chunk);
    });
    request.on("end", async () => {
      try {
        const parsed = JSON.parse(bodyText || "{}");
        const result = await handleVisaActionsAct(runtime, {
          headers: request.headers as Record<string, string | string[] | undefined>,
          body: parsed,
          baseUrl: publicOrigin,
        });
        return json(response, result.status, result.body, origin, reqHost, result.headers);
      } catch (err) {
        return json(
          response,
          400,
          {
            ok: false,
            code: "invalid_json",
            message: err instanceof Error ? err.message : "Invalid JSON body",
            do_not_relay_to_owner: true,
          },
          origin,
          reqHost,
        );
      }
    });
    return;
  }
  if (url.pathname === "/v1/actions/testnet" && request.method === "GET") {
    const desc = buildVisaActionsDescriptor(publicOrigin);
    return json(
      response,
      200,
      {
        ok: true,
        environment: "testnet",
        testnet: desc.testnet,
        standards: desc.standards,
        sampleMppHeader: 'Authorization: Payment token="mpp_test_ousd_42429"',
        sampleX402Header: 'X-PAYMENT: {"scheme":"x402/1","txHash":"0xtest402"}',
      },
      origin,
      reqHost,
    );
  }
  if (url.pathname === "/v1/actions/testnet/faucet" && request.method === "POST") {
    const session = runtime.join({
      name: "VisaTestnetAgent",
      kind: "agent",
      faction: "wardens",
      character: "boneknight",
      tier: "tap",
      tapKeyId: "tap_testnet_faucet",
    });
    return json(
      response,
      201,
      {
        ok: true,
        environment: "testnet",
        commanderId: session.commanderId,
        accountId: session.accountId,
        resumeToken: session.token,
        sparksGranted: runtime.ledger.balance(session.accountId),
        testMppToken: `mpp_test_${session.commanderId}_ousd`,
        testX402Proof: `x402_test_${session.commanderId}_ousd`,
      },
      origin,
      reqHost,
    );
  }
  if (url.pathname === "/v1/guides/tap") {
    return json(response, 200, buildTapAgentGuide(publicOrigin), origin, reqHost);
  }
  if (url.pathname === "/v1/leaderboard") {
    return json(
      response,
      200,
      {
        updatedAtTick: runtime.world.tick,
        factions: runtime.factionWarStatus(),
        leaders: runtime.leaderboard(),
      },
      origin,
      reqHost,
    );
  }
  if (url.pathname === "/v1/forge/proposals") {
    if (request.method === "GET") {
      return json(response, 200, { proposals: listForgeProposals() }, origin, reqHost);
    }
    if (request.method === "POST") {
      let bodyText = "";
      request.on("data", (chunk) => {
        if (bodyText.length < 32_768) bodyText += String(chunk);
      });
      request.on("end", () => {
        try {
          const payload = JSON.parse(bodyText || "{}") as {
            title?: string;
            summary?: string;
            category?: ForgeProposalCategory;
            authorName?: string;
            authorTier?: "tap" | "self" | "unverified";
            rewardUsd?: number;
          };
          const repoRoot = resolve(new URL("../../../", import.meta.url).pathname);
          const created = createForgeProposal(
            {
              title: String(payload.title ?? ""),
              summary: String(payload.summary ?? ""),
              ...(payload.category ? { category: payload.category } : {}),
              ...(payload.authorName ? { authorName: payload.authorName } : {}),
              ...(payload.authorTier ? { authorTier: payload.authorTier } : {}),
              ...(payload.rewardUsd !== undefined ? { rewardUsd: Number(payload.rewardUsd) } : {}),
            },
            repoRoot,
          );
          runtime.pushFeed(
            runtime.world.tick,
            "forge_proposal",
            `Meta-Forge Wish [${created.id}]: "${created.title}" ($${created.rewardUsd} bounty queued)`,
          );
          return json(response, 201, { ok: true, proposal: created }, origin, reqHost);
        } catch (err) {
          return json(
            response,
            400,
            { ok: false, error: err instanceof Error ? err.message : "invalid_proposal" },
            origin,
            reqHost,
          );
        }
      });
      return;
    }
  }
  if (url.pathname === "/v1/tap/verify" && request.method === "POST") {
    let bodyText = "";
    request.on("data", (chunk) => {
      if (bodyText.length < 65_536) bodyText += String(chunk);
    });
    request.on("end", async () => {
      const headersRecord: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(request.headers)) headersRecord[k.toLowerCase()] = v;
      try {
        const parsedBody = bodyText ? (JSON.parse(bodyText) as { keyId?: string }) : {};
        if (!headersRecord["x-tap-key-id"] && parsedBody.keyId) {
          headersRecord["x-tap-key-id"] = parsedBody.keyId;
        }
      } catch {
        // Ignore non-JSON body
      }
      const verified = await verifyTapHttpOrSandbox({
        headers: headersRecord,
        body: bodyText,
        allowSandbox: true,
      });
      if (!verified.ok) {
        return json(response, verified.status, verified, origin, reqHost);
      }
      return json(response, 200, verified, origin, reqHost);
    });
    return;
  }
  if (url.pathname === "/v1/comms") {
    if (request.method === "GET") {
      const factionParam = url.searchParams.get("faction") as FactionId | null;
      const channelParam = url.searchParams.get("channel") as CommsChannel | null;
      return json(
        response,
        200,
        {
          messages: runtime.commsHistory({
            ...(factionParam ? { faction: factionParam } : {}),
            ...(channelParam ? { channel: channelParam } : {}),
          }),
        },
        origin,
        reqHost,
      );
    }
    if (request.method === "POST") {
      let bodyText = "";
      request.on("data", (chunk) => {
        if (bodyText.length < 16_384) bodyText += String(chunk);
      });
      request.on("end", () => {
        try {
          const payload = JSON.parse(bodyText || "{}") as {
            resumeToken?: string;
            commanderId?: string;
            channel?: CommsChannel;
            text?: string;
          };
          const session = runtime.sessionFor({
            ...(payload.resumeToken ? { resumeToken: payload.resumeToken } : {}),
            ...(payload.commanderId ? { commanderId: payload.commanderId } : {}),
          });
          if (!session) {
            return json(response, 404, { ok: false, error: "session_not_found" }, origin, reqHost);
          }
          const ch: CommsChannel =
            payload.channel === "global" || payload.channel === "forge"
              ? payload.channel
              : "faction";
          const created = runtime.sendComms(session, ch, String(payload.text ?? ""));
          return json(
            response,
            201,
            { ok: true, message: created, messages: runtime.commsHistory() },
            origin,
            reqHost,
          );
        } catch (err) {
          return json(
            response,
            400,
            { ok: false, error: err instanceof Error ? err.message : "invalid_comms" },
            origin,
            reqHost,
          );
        }
      });
      return;
    }
  }
  if (url.pathname === "/v1/reputation/vouch" && request.method === "POST") {
    let bodyText = "";
    request.on("data", (chunk) => {
      if (bodyText.length < 16_384) bodyText += String(chunk);
    });
    request.on("end", () => {
      try {
        const payload = JSON.parse(bodyText || "{}") as {
          resumeToken?: string;
          commanderId?: string;
          targetCommanderId?: string;
          reason?: string;
        };
        const session = runtime.sessionFor({
          ...(payload.resumeToken ? { resumeToken: payload.resumeToken } : {}),
          ...(payload.commanderId ? { commanderId: payload.commanderId } : {}),
        });
        if (!session) {
          return json(response, 404, { ok: false, error: "session_not_found" }, origin, reqHost);
        }
        const result = runtime.vouch(
          session,
          String(payload.targetCommanderId ?? ""),
          payload.reason,
        );
        return json(response, 200, { ok: true, vouch: result }, origin, reqHost);
      } catch (err) {
        return json(
          response,
          400,
          { ok: false, error: err instanceof Error ? err.message : "invalid_vouch" },
          origin,
          reqHost,
        );
      }
    });
    return;
  }
  if (url.pathname === "/v1/web/links" && request.method === "POST") {
    let bodyText = "";
    request.on("data", (chunk) => {
      if (bodyText.length < 16_384) bodyText += String(chunk);
    });
    request.on("end", () => {
      try {
        const payload = JSON.parse(bodyText || "{}") as {
          resumeToken?: string;
          commanderId?: string;
        };
        const session = runtime.sessionFor({
          ...(payload.resumeToken ? { resumeToken: payload.resumeToken } : {}),
          ...(payload.commanderId ? { commanderId: payload.commanderId } : {}),
        });
        if (!session) {
          return json(response, 404, { ok: false, error: "session_not_found" }, origin, reqHost);
        }
        const link = runtime.createPairingLink(session);
        return json(response, 201, { ok: true, ...link }, origin, reqHost);
      } catch (err) {
        return json(
          response,
          400,
          { ok: false, error: err instanceof Error ? err.message : "invalid_link_request" },
          origin,
          reqHost,
        );
      }
    });
    return;
  }
  if (url.pathname === "/v1/web/claim" && request.method === "POST") {
    let bodyText = "";
    request.on("data", (chunk) => {
      if (bodyText.length < 16_384) bodyText += String(chunk);
    });
    request.on("end", () => {
      try {
        const payload = JSON.parse(bodyText || "{}") as { pairCode?: string };
        const claimed = runtime.claimPairingLink(String(payload.pairCode ?? ""));
        if (!claimed) {
          return json(
            response,
            404,
            { ok: false, error: "invalid_or_expired_pair_code" },
            origin,
            reqHost,
          );
        }
        return json(response, 200, claimed, origin, reqHost);
      } catch (err) {
        return json(
          response,
          400,
          { ok: false, error: err instanceof Error ? err.message : "invalid_claim_request" },
          origin,
          reqHost,
        );
      }
    });
    return;
  }
  if (url.pathname === "/v1/reliquary" && request.method === "GET") {
    return json(
      response,
      200,
      {
        slots: RELIQUARY_SLOTS,
        rarities: RELIQUARY_RARITIES,
        items: RELIQUARY_ITEMS,
      },
      origin,
      reqHost,
    );
  }
  if (url.pathname === "/v1/reliquary/equip" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}") as {
          resumeToken?: string;
          commanderId?: string;
          itemId?: ReliquaryItemId;
        };
        const session = runtime.sessionFor({
          ...(parsed.resumeToken ? { resumeToken: parsed.resumeToken } : {}),
          ...(parsed.commanderId ? { commanderId: parsed.commanderId } : {}),
        });
        if (!session || !parsed.itemId) {
          return json(
            response,
            400,
            { ok: false, error: "valid_session_and_item_required" },
            origin,
            reqHost,
          );
        }
        const equipped = runtime.equipItem(session, parsed.itemId);
        return json(response, 200, { ok: true, ...equipped }, origin, reqHost);
      } catch (err) {
        return json(
          response,
          400,
          { ok: false, error: err instanceof Error ? err.message : "equip_failed" },
          origin,
          reqHost,
        );
      }
    });
    return;
  }
  if (url.pathname === "/v1/reliquary/salvage" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}") as {
          resumeToken?: string;
          commanderId?: string;
          itemId?: ReliquaryItemId;
        };
        const session = runtime.sessionFor({
          ...(parsed.resumeToken ? { resumeToken: parsed.resumeToken } : {}),
          ...(parsed.commanderId ? { commanderId: parsed.commanderId } : {}),
        });
        if (!session || !parsed.itemId) {
          return json(
            response,
            400,
            { ok: false, error: "valid_session_and_item_required" },
            origin,
            reqHost,
          );
        }
        const salvaged = runtime.salvageItem(session, parsed.itemId);
        return json(response, 200, { ok: true, ...salvaged }, origin, reqHost);
      } catch (err) {
        return json(
          response,
          400,
          { ok: false, error: err instanceof Error ? err.message : "salvage_failed" },
          origin,
          reqHost,
        );
      }
    });
    return;
  }
  if (url.pathname === "/health") return json(response, 200, runtime.health(), origin, reqHost);
  if (
    (url.pathname === "/v1/contracts" || url.pathname === "/v1/ledger") &&
    !httpBuckets.tryTake(request.socket.remoteAddress ?? "unknown")
  ) {
    return json(response, 429, { error: "rate_limited" }, origin, reqHost);
  }
  if (url.pathname === "/v1/contracts") {
    const statuses = new Set<ContractStatus>([
      "open",
      "accepted",
      "satisfied",
      "settled",
      "expired",
      "refunded",
      "cancelled",
    ]);
    const statusParam = url.searchParams.get("status");
    if (statusParam && !statuses.has(statusParam as ContractStatus)) {
      return json(response, 400, { error: "invalid_status" });
    }
    const limitRaw = Number(url.searchParams.get("limit") ?? 100);
    const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isFinite(limitRaw) || !Number.isFinite(offsetRaw) || offsetRaw < 0) {
      return json(response, 400, { error: "invalid_pagination" });
    }
    const limit = Math.min(200, Math.max(1, Math.floor(limitRaw)));
    const offset = Math.floor(offsetRaw);
    const all = runtime.contracts
      .snapshots()
      .filter((contract) => !statusParam || contract.status === statusParam);
    return json(response, 200, {
      contracts: all.slice(offset, offset + limit),
      total: all.length,
      scope: "retained",
      retainedContracts: runtime.contracts.totalContractCount,
      hotContracts: runtime.contracts.contracts.size,
      archivedContracts: runtime.contracts.archivedCount,
      limit,
      offset,
    });
  }
  if (url.pathname === "/v1/ledger") {
    return json(response, 200, runtime.ledger.reconcile(), origin, reqHost);
  }
  if (url.pathname === "/v1/taskmarket") {
    const planPath = resolve(
      new URL("../../../.plan/milestone-1-faction-wars.yaml", import.meta.url).pathname,
    );
    const planYaml = existsSync(planPath) ? readFileSync(planPath, "utf8") : "";
    const openBounties = runtime.contracts
      .snapshots()
      .filter((c) => c.status === "open" || c.status === "accepted")
      .slice(-12)
      .map((c) => ({
        id: c.id,
        title: c.title,
        predicate: c.predicate,
        rewardSparks: c.reward,
        rewardUsd: Number((c.reward * SPARK_USD_RATE).toFixed(3)),
        status: c.status,
      }));
    return json(
      response,
      200,
      {
        microRate: { unit: "Spark", usdPerSpark: SPARK_USD_RATE },
        factions: runtime.factionWarStatus(),
        openBounties,
        planFile: ".plan/milestone-1-faction-wars.yaml",
        planYaml,
      },
      origin,
      reqHost,
    );
  }
  if ((request.method === "GET" || request.method === "HEAD") && existsSync(webDistDir)) {
    const relPath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const candidate = resolve(webDistDir, relPath);
    if (candidate.startsWith(webDistDir) && existsSync(candidate) && statSync(candidate).isFile()) {
      const content = readFileSync(candidate);
      const mime = MIME_BY_EXT[extname(candidate)] ?? "application/octet-stream";
      response.writeHead(200, {
        "content-type": mime,
        "content-length": content.byteLength,
      });
      response.end(request.method === "HEAD" ? undefined : content);
      return;
    }
  }
  return json(response, 404, { error: "not_found" });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (
    url.pathname !== "/ws" ||
    !isRequestOriginAllowed(request.headers.origin, request.headers.host)
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (sockets.size >= maxClients) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

wss.on("connection", (ws, request) => {
  const meta: SocketMeta = {
    remoteAddress: request.socket.remoteAddress ?? "unknown",
    invalidFrames: 0,
    helloTimer: setTimeout(() => {
      if (!clients.has(ws)) ws.close(1008, "hello_timeout");
    }, helloTimeoutMs),
  };
  meta.helloTimer.unref();
  sockets.set(ws, meta);
  ws.on("message", (raw) => {
    let parsed = false;
    try {
      const message = parseClientMessage(String(raw));
      parsed = true;
      if (message.type === "hello") {
        if (clients.has(ws)) throw new Error("hello_already_completed");
        if (!helloBuckets.tryTake(meta.remoteAddress)) throw new Error("hello_budget_exceeded");
        const session = runtime.join({
          name: message.name,
          kind: message.kind,
          ...(message.resumeToken ? { resumeToken: message.resumeToken } : {}),
          ...(message.character ? { character: message.character } : {}),
          ...(message.faction ? { faction: message.faction } : {}),
          ...(message.tier ? { tier: message.tier } : {}),
          ...(message.tapKeyId ? { tapKeyId: message.tapKeyId } : {}),
        });
        const state: ClientState = {
          session,
          worldSent: false,
          commands: new TokenBucket(
            Math.max(10, Math.ceil(commandsPerSecond * 1.5)),
            commandsPerSecond,
          ),
          contracts: new TokenBucket(contractOpsPerMinute, contractOpsPerMinute / 60),
          worldRequests: new TokenBucket(2, 0.2),
          messages: new TokenBucket(180, 120),
        };
        clients.set(ws, state);
        clearTimeout(meta.helloTimer);
        for (const [otherWs, otherState] of [...clients.entries()]) {
          if (otherWs !== ws && otherState.session.token === session.token) {
            clients.delete(otherWs);
            otherWs.close(4001, "superseded");
          }
        }
        send(ws, {
          type: "welcome",
          schemaVersion: SCHEMA_VERSION,
          sessionId: session.sessionId,
          commanderId: session.commanderId,
          accountId: session.accountId,
          resumeToken: session.token,
        });
        sendSnapshot(ws, state);
        return;
      }
      const state = clients.get(ws);
      if (!state) throw new Error("hello_required");
      if (!state.messages.tryTake()) throw new Error("message_budget_exceeded");
      const session = state.session;
      if (message.type === "command") {
        if (!state.commands.tryTake()) throw new Error("command_budget_exceeded");
        runtime.command(session, message.seq, message.command);
        send(ws, { type: "ack", seq: message.seq, ok: true });
      } else if (message.type === "postContract") {
        if (!state.contracts.tryTake()) throw new Error("contract_budget_exceeded");
        runtime.postContract(session, message.idempotencyKey, message.draft);
        send(ws, { type: "ack", idempotencyKey: message.idempotencyKey, ok: true });
        sendSnapshot(ws, state);
      } else if (message.type === "acceptContract") {
        if (!state.contracts.tryTake()) throw new Error("contract_budget_exceeded");
        runtime.acceptContract(session, message.idempotencyKey, message.contractId);
        send(ws, { type: "ack", idempotencyKey: message.idempotencyKey, ok: true });
        sendSnapshot(ws, state);
      } else if (message.type === "cancelContract") {
        if (!state.contracts.tryTake()) throw new Error("contract_budget_exceeded");
        runtime.cancelContract(session, message.idempotencyKey, message.contractId);
        send(ws, { type: "ack", idempotencyKey: message.idempotencyKey, ok: true });
        sendSnapshot(ws, state);
      } else if (message.type === "buyService") {
        if (!state.contracts.tryTake()) throw new Error("contract_budget_exceeded");
        const result = runtime.buyService(session, message.idempotencyKey, message.service);
        send(ws, {
          type: "serviceResult",
          idempotencyKey: message.idempotencyKey,
          service: result.service,
          cost: result.cost,
          paidWith: result.paidWith,
          detail: result.detail,
        });
        sendSnapshot(ws, state);
      } else if (message.type === "setCopilot") {
        runtime.setCopilot(session, message.enabled, message.directive);
        send(ws, { type: "ack", ok: true });
        sendSnapshot(ws, state);
      } else if (message.type === "sendComms") {
        runtime.sendComms(session, message.channel, message.text);
        send(ws, { type: "ack", ok: true });
        for (const [clientWs, clientState] of clients) {
          sendSnapshot(clientWs, clientState);
        }
      } else if (message.type === "vouch") {
        runtime.vouch(session, message.targetCommanderId, message.reason);
        send(ws, { type: "ack", ok: true });
        for (const [clientWs, clientState] of clients) {
          sendSnapshot(clientWs, clientState);
        }
      } else if (message.type === "equipItem") {
        runtime.equipItem(session, message.itemId);
        send(ws, { type: "ack", ok: true });
        sendSnapshot(ws, state);
      } else if (message.type === "salvageItem") {
        runtime.salvageItem(session, message.itemId);
        send(ws, { type: "ack", ok: true });
        sendSnapshot(ws, state);
      } else if (message.type === "requestWorld") {
        if (!state.worldRequests.tryTake()) throw new Error("world_request_budget_exceeded");
        state.worldSent = false;
        sendSnapshot(ws, state);
      } else if (message.type === "abandon") {
        runtime.abandon(session);
        clients.delete(ws);
      } else if (message.type === "ping") {
        send(ws, {
          type: "pong",
          ...(message.at !== undefined ? { at: message.at } : {}),
          serverTick: runtime.world.tick,
        });
      }
    } catch (error) {
      if (!parsed) meta.invalidFrames++;
      send(ws, {
        type: "error",
        code: "rejected",
        message: error instanceof Error ? error.message : String(error),
      });
      if (!parsed && meta.invalidFrames >= maxInvalidFrames) {
        ws.close(1008, "invalid_frame_budget_exceeded");
      }
    }
  });
  ws.on("close", () => {
    clearTimeout(meta.helloTimer);
    sockets.delete(ws);
    const state = clients.get(ws);
    clients.delete(ws);
    if (!state) return;
    const session = state.session;
    const stillConnected = [...clients.values()].some((s) => s.session.token === session.token);
    if (!stillConnected) runtime.leave(session.token);
  });
});

let snapshotCounter = 0;
const tickTimer = setInterval(() => {
  try {
    runtime.step();
    if (++snapshotCounter % 3 !== 0) return;
    for (const [ws, state] of clients) {
      sendSnapshot(ws, state);
    }
  } catch (error) {
    console.error("SWARMS tick failed", error);
  }
}, 1000 / 30);

httpServer.listen(port, host, () => {
  console.log(`SWARMS zone listening on http://${host}:${port} (ws://${host}:${port}/ws)`);
  console.log(`Data: ${dataDir}`);
});

function shutdown(): void {
  clearInterval(tickTimer);
  for (const meta of sockets.values()) clearTimeout(meta.helloTimer);
  runtime.checkpoint();
  runtime.close();
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
