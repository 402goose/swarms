import { SPELLS } from "@swarms/content";
import type { ContractDraft, GameCommand, SpellId, Vec2, ZoneSnapshot } from "@swarms/protocol";
import { distance } from "@swarms/protocol";
import type { DungeonMap } from "@swarms/worldgen";
import { z } from "zod";

export interface MapInfo {
  rooms: DungeonMap["rooms"];
  tileSize: number;
}

export function roomCenter(map: MapInfo, roomId: string): Vec2 | undefined {
  const room = map.rooms.find((r) => r.id === roomId);
  if (!room) return undefined;
  return {
    x: (room.x + room.w / 2) * map.tileSize,
    y: (room.y + room.h / 2) * map.tileSize,
  };
}

export function roomOf(map: MapInfo, pos: Vec2): string | null {
  for (const room of map.rooms) {
    if (
      pos.x >= room.x * map.tileSize &&
      pos.x < (room.x + room.w) * map.tileSize &&
      pos.y >= room.y * map.tileSize &&
      pos.y < (room.y + room.h) * map.tileSize
    ) {
      return room.id;
    }
  }
  return null;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface ObservationSummary {
  tick: number;
  self: {
    hp: number;
    maxHp: number;
    command: number;
    units: number;
    essence: number;
    carryingRelic: boolean;
    roomId: string | null;
    faction?: "wardens" | "reapers";
  };
  threats: {
    monstersClose: number;
    monstersMid: number;
    enemyUnitsClose: number;
    enemyCommanders: Array<{ name: string; dist: number; hp: number; units: number }>;
  };
  nearest: {
    monsterDist: number | undefined;
    bossDist: number | undefined;
    bossHp: number | undefined;
    relicDist: number | undefined;
    pickupDist: number | undefined;
  };
  objectives: {
    shrineDist: number | undefined;
    extractionDist: number | undefined;
    boneChoirDist: number | undefined;
  };
  contracts: Array<{
    id: string;
    reward: number;
    mode: string;
    predicate: unknown;
    progress: number;
    myProgress: number;
    expiresInTicks: number;
    mine: boolean;
    acceptedByMe: boolean;
  }>;
  wallet: { sparks: number; escrowed: number };
  recentFeedKinds: string[];
  wave?: {
    number: number;
    title: string;
    activeHunters: number;
    nextInTicks: number;
    huntingMe: boolean;
  };
}

export function summarize(snapshot: ZoneSnapshot, map: MapInfo): ObservationSummary {
  const self = snapshot.commanders.find((c) => c.id === snapshot.selfCommanderId);
  const selfPos: Vec2 = self ?? { x: 0, y: 0 };
  const monsters = snapshot.entities.filter((e) => e.kind === "monster");
  const distTo = (p: Vec2) => Math.round(distance(selfPos, p));
  const nearestOf = (list: Vec2[]): number | undefined =>
    list.length ? Math.min(...list.map(distTo)) : undefined;
  const boss = monsters.find((e) => e.id === "boss-bone-choir");
  const shrine = roomCenter(map, "shrine");
  const extraction = roomCenter(map, "extraction");
  const boneChoir = roomCenter(map, "bone-choir");
  return {
    tick: snapshot.tick,
    self: {
      hp: self?.hp ?? 0,
      maxHp: self?.maxHp ?? 0,
      command: Math.round(self?.command ?? 0),
      units: self?.unitCount ?? 0,
      essence: self?.essence ?? 0,
      carryingRelic: Boolean(self?.carryingItemId),
      roomId: self ? roomOf(map, self) : null,
      ...(self?.faction ? { faction: self.faction } : {}),
    },
    threats: {
      monstersClose: monsters.filter((e) => distance(selfPos, e) <= 160).length,
      monstersMid: monsters.filter((e) => distance(selfPos, e) <= 320).length,
      enemyUnitsClose: snapshot.entities.filter(
        (e) =>
          e.kind === "unit" &&
          e.ownerId !== snapshot.selfCommanderId &&
          distance(selfPos, e) <= 220,
      ).length,
      enemyCommanders: snapshot.commanders
        .filter((c) => c.id !== snapshot.selfCommanderId && c.alive)
        .map((c) => ({ name: c.name, dist: distTo(c), hp: Math.round(c.hp), units: c.unitCount }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3),
    },
    nearest: {
      monsterDist: nearestOf(monsters.filter((e) => e.id !== "boss-bone-choir")),
      bossDist: boss ? distTo(boss) : undefined,
      bossHp: boss?.hp,
      relicDist: nearestOf(snapshot.pickups.filter((p) => p.templateId === "relic")),
      pickupDist: nearestOf(snapshot.pickups),
    },
    objectives: {
      shrineDist: shrine ? distTo(shrine) : undefined,
      extractionDist: extraction ? distTo(extraction) : undefined,
      boneChoirDist: boneChoir ? distTo(boneChoir) : undefined,
    },
    contracts: snapshot.contracts
      .filter((c) => c.status === "open" || c.status === "accepted")
      .sort((a, b) => b.reward - a.reward)
      .slice(0, 6)
      .map((c) => ({
        id: c.id,
        reward: c.reward,
        mode: c.mode,
        predicate: c.predicate,
        progress: c.progress,
        myProgress: c.progressByCommander[snapshot.selfCommanderId] ?? 0,
        expiresInTicks: Math.max(0, c.expiresAtTick - snapshot.tick),
        mine: c.issuerId === snapshot.selfCommanderId,
        acceptedByMe: c.participants.includes(snapshot.selfCommanderId),
      })),
    wallet: { ...snapshot.wallet },
    recentFeedKinds: snapshot.feed.slice(-5).map((f) => f.kind),
    ...(snapshot.wave
      ? {
          wave: {
            number: snapshot.wave.number,
            title: snapshot.wave.title,
            activeHunters: snapshot.wave.activeHunters,
            nextInTicks: Math.max(0, snapshot.wave.nextAtTick - snapshot.tick),
            huntingMe: snapshot.wave.targetCommanderId === snapshot.selfCommanderId,
          },
        }
      : {}),
  };
}

export function digestSummary(summary: ObservationSummary): string {
  return fnv1a(JSON.stringify(summary));
}

export const ObjectiveSchema = z.enum([
  "hunt",
  "boss",
  "relic",
  "extract",
  "retreat",
  "hold",
  "patrol",
]);

export const CommanderIntentSchema = z
  .object({
    v: z.literal(1),
    basedOnTick: z.number().int().nonnegative(),
    expiresAtTick: z.number().int().nonnegative(),
    objective: ObjectiveSchema,
    roomId: z.string().min(1).max(48).optional(),
    contractId: z.string().min(1).max(128).optional(),
    stance: z.enum(["attack", "defend", "follow"]).default("attack"),
    novaMinNeighbors: z.number().int().min(1).max(12).default(3),
    allowVolley: z.boolean().default(true),
    allowShell: z.boolean().default(true),
    postTemplate: z.enum(["cull5", "relic125"]).optional(),
    rationale: z.string().max(200).default(""),
  })
  .strict();
export type CommanderIntent = z.infer<typeof CommanderIntentSchema>;

export const POST_TEMPLATES: Record<string, { reward: number; draft: ContractDraft }> = {
  cull5: {
    reward: 75,
    draft: {
      title: "Cull 5 skeletons",
      description: "Agent-posted swarm bounty. First verified swarm collects.",
      predicate: { kind: "kill_count", targetTag: "skeleton", count: 5 },
      reward: 75,
      mode: "bounty",
      ttlTicks: 30 * 60 * 5,
    },
  },
  relic125: {
    reward: 125,
    draft: {
      title: "Return the Moon Relic",
      description: "Agent-posted relic run to the north shrine.",
      predicate: { kind: "deliver_item", itemTemplateId: "relic", destination: "shrine" },
      reward: 125,
      mode: "bounty",
      ttlTicks: 30 * 60 * 5,
    },
  },
};

export type IntentValidation = { intent: CommanderIntent } | { error: string };

export function normalizeIntentRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  const blankish = (v: unknown): boolean =>
    v === null ||
    v === undefined ||
    (typeof v === "string" && ["", "null", "none"].includes(v.trim().toLowerCase()));
  if (blankish(obj.roomId)) delete obj.roomId;
  if (blankish(obj.contractId)) delete obj.contractId;
  if (blankish(obj.postTemplate)) delete obj.postTemplate;
  if (typeof obj.objective === "string") {
    const first = obj.objective.trim().toLowerCase().split(/[|/,]/)[0]?.trim();
    if (first) obj.objective = first === "extraction" ? "extract" : first;
  }
  if (typeof obj.rationale === "string" && obj.rationale.length > 200) {
    obj.rationale = obj.rationale.slice(0, 200);
  }
  if (obj.stance === "retreat" || obj.stance === "move") obj.stance = "attack";
  return obj;
}

export function validateIntent(
  raw: unknown,
  ctx: {
    tick: number;
    roomIds: Iterable<string>;
    contractIds: Iterable<string>;
    maxPostReward: number;
  },
): IntentValidation {
  const parsed = CommanderIntentSchema.safeParse(raw);
  if (!parsed.success) return { error: "intent_schema_invalid" };
  const intent = parsed.data;
  if (intent.basedOnTick < ctx.tick - 90) return { error: "intent_stale" };
  if (intent.expiresAtTick <= intent.basedOnTick) intent.expiresAtTick = intent.basedOnTick + 300;
  if (intent.expiresAtTick <= ctx.tick) return { error: "intent_expired" };
  if (intent.expiresAtTick > ctx.tick + 450) intent.expiresAtTick = ctx.tick + 450;
  if (intent.roomId && !new Set(ctx.roomIds).has(intent.roomId))
    return { error: "intent_unknown_room" };
  if (intent.contractId && !new Set(ctx.contractIds).has(intent.contractId)) {
    return { error: "intent_unknown_contract" };
  }
  if (intent.postTemplate && POST_TEMPLATES[intent.postTemplate]!.reward > ctx.maxPostReward) {
    return { error: "intent_post_overspend" };
  }
  return { intent };
}

export function scriptedIntent(snapshot: ZoneSnapshot, _map: MapInfo): CommanderIntent {
  const self = snapshot.commanders.find((c) => c.id === snapshot.selfCommanderId);
  const base = {
    v: 1 as const,
    basedOnTick: snapshot.tick,
    expiresAtTick: snapshot.tick + 300,
    stance: "attack" as const,
    novaMinNeighbors: 3,
    allowVolley: true,
    allowShell: true,
    rationale: "scripted fallback policy",
  };
  if (self?.carryingItemId) return { ...base, objective: "relic", roomId: "shrine" };
  const open = snapshot.contracts
    .filter(
      (c) =>
        (c.status === "open" || c.status === "accepted") && c.issuerId !== snapshot.selfCommanderId,
    )
    .sort((a, b) => {
      const mineA = a.participants.includes(snapshot.selfCommanderId) ? 0 : 1;
      const mineB = b.participants.includes(snapshot.selfCommanderId) ? 0 : 1;
      return mineA - mineB || b.reward - a.reward;
    });
  const chosen = open[0];
  if (!chosen) return { ...base, objective: "hunt", roomId: "crypt-west" };
  if (chosen.predicate.kind === "kill_entity") {
    return { ...base, objective: "boss", contractId: chosen.id, roomId: "bone-choir" };
  }
  if (chosen.predicate.kind === "deliver_item") {
    return { ...base, objective: "relic", contractId: chosen.id, roomId: "bone-choir" };
  }
  return { ...base, objective: "hunt", contractId: chosen.id, roomId: "crypt-west" };
}

export interface TacticalResult {
  command: GameCommand | null;
  key: string;
  note: string;
  safetyOverride?: string;
}

export const SPELL_COOLDOWN_TICKS: Record<SpellId, number> = {
  nova: SPELLS.nova.cooldownTicks,
  volley: SPELLS.volley.cooldownTicks,
  shell: SPELLS.shell.cooldownTicks,
  frost: SPELLS.frost.cooldownTicks,
  chain: SPELLS.chain.cooldownTicks,
};

export type SpellReadyAt = Partial<Record<SpellId, number>>;

export function tactical(
  snapshot: ZoneSnapshot,
  intent: CommanderIntent | null,
  map: MapInfo,
  spellReadyAt: SpellReadyAt = {},
): TacticalResult {
  const self = snapshot.commanders.find((c) => c.id === snapshot.selfCommanderId);
  if (!self?.alive) return { command: null, key: "dead", note: "self not alive" };
  const effective =
    intent && intent.expiresAtTick > snapshot.tick ? intent : scriptedIntent(snapshot, map);
  const hostiles = snapshot.entities.filter(
    (e) =>
      e.hp > 0 &&
      (e.kind === "monster" ||
        (e.kind === "unit" && e.ownerId !== self.id) ||
        (e.kind === "commander" && e.id !== self.id)),
  );
  const near150 = hostiles.filter((e) => distance(self, e) <= 150);
  if (self.hp < 35 || self.unitCount <= 3) {
    return {
      command: { type: "retreat" },
      key: "safety:retreat",
      note: "safety override: low hp or swarm wiped",
      safetyOverride: self.hp < 35 ? "low_hp" : "swarm_wiped",
    };
  }
  if (
    effective.allowShell &&
    self.command >= 25 &&
    self.hp < 60 &&
    near150.length >= 2 &&
    snapshot.tick >= (spellReadyAt.shell ?? 0)
  ) {
    return {
      command: { type: "cast", spell: "shell", target: { x: self.x, y: self.y } },
      key: "cast:shell",
      note: "shell under pressure",
    };
  }
  const near140 = hostiles.filter((e) => distance(self, e) <= 140);
  if (self.command >= 35 && near140.length >= 4 && snapshot.tick >= (spellReadyAt.frost ?? 0)) {
    return {
      command: { type: "cast", spell: "frost", target: { x: self.x, y: self.y } },
      key: "cast:frost",
      note: `frost nova into ${near140.length} hostiles`,
    };
  }
  const near260 = hostiles.filter((e) => distance(self, e) <= 260);
  if (self.command >= 40 && near260.length >= 4 && snapshot.tick >= (spellReadyAt.chain ?? 0)) {
    const target = near260[0]!;
    return {
      command: { type: "cast", spell: "chain", target: { x: target.x, y: target.y } },
      key: "cast:chain",
      note: `chain lightning into ${near260.length} hostiles`,
    };
  }
  if (
    self.command >= 45 &&
    near150.length >= effective.novaMinNeighbors &&
    snapshot.tick >= (spellReadyAt.nova ?? 0)
  ) {
    const target = near150[0]!;
    return {
      command: { type: "cast", spell: "nova", target: { x: target.x, y: target.y } },
      key: "cast:nova",
      note: `nova into ${near150.length} hostiles`,
    };
  }
  if (effective.allowVolley && self.command >= 30 && snapshot.tick >= (spellReadyAt.volley ?? 0)) {
    const mid = hostiles.filter((e) => distance(self, e) <= 240);
    if (mid.length >= 2) {
      const target = mid[0]!;
      return {
        command: { type: "cast", spell: "volley", target: { x: target.x, y: target.y } },
        key: "cast:volley",
        note: `volley into ${mid.length} hostiles`,
      };
    }
  }
  const nearestHostile = hostiles
    .map((e) => ({ e, d: distance(self, e) }))
    .filter(({ d }) => d <= 280)
    .sort((a, b) => a.d - b.d)[0]?.e;
  if (nearestHostile) {
    return {
      command: { type: "shoot", target: { x: nearestHostile.x, y: nearestHostile.y } },
      key: `shoot:${Math.floor(snapshot.tick / 8)}:${Math.round(nearestHostile.x / 32)},${Math.round(nearestHostile.y / 32)}`,
      note: "bolt at nearest hostile",
    };
  }
  const roomTarget = (roomId: string | undefined, fallback: string): Vec2 =>
    roomCenter(map, roomId ?? fallback) ?? roomCenter(map, fallback) ?? { x: self.x, y: self.y };
  if (self.carryingItemId) {
    return {
      command: { type: "move", target: roomTarget("shrine", "shrine") },
      key: "move:relic-deliver",
      note: "carrying relic to shrine",
    };
  }
  switch (effective.objective) {
    case "retreat":
      return { command: { type: "retreat" }, key: "move:retreat", note: "intent retreat" };
    case "hold":
      return {
        command: { type: "defend", target: { x: self.x, y: self.y } },
        key: "move:hold",
        note: "intent hold",
      };
    case "extract": {
      if (roomOf(map, self) === "extraction") {
        return { command: { type: "extract" }, key: "move:extract", note: "inside extraction" };
      }
      return {
        command: { type: "attackMove", target: roomTarget("extraction", "extraction") },
        key: "move:to-extraction",
        note: "heading to extraction",
      };
    }
    case "boss": {
      const boss = snapshot.entities.find((e) => e.id === "boss-bone-choir" && e.hp > 0);
      const target = boss ? { x: boss.x, y: boss.y } : roomTarget("bone-choir", "bone-choir");
      return { command: { type: "attackMove", target }, key: "move:boss", note: "engaging boss" };
    }
    case "relic": {
      const relic = snapshot.pickups.find((p) => p.templateId === "relic");
      const target = relic
        ? { x: relic.x, y: relic.y }
        : roomTarget(effective.roomId, "bone-choir");
      return { command: { type: "move", target }, key: "move:relic", note: "seeking relic" };
    }
    case "patrol": {
      const target = roomTarget(effective.roomId, "arena");
      return {
        command: { type: "attackMove", target },
        key: `move:patrol:${effective.roomId ?? "arena"}`,
        note: "patrolling",
      };
    }
    default: {
      const monsters = snapshot.entities
        .filter((e) => e.kind === "monster" && e.id !== "boss-bone-choir" && e.hp > 0)
        .sort((a, b) => distance(self, a) - distance(self, b));
      const target = monsters[0]
        ? { x: monsters[0].x, y: monsters[0].y }
        : roomTarget(effective.roomId, "crypt-west");
      return {
        command: { type: "attackMove", target },
        key: "move:hunt",
        note: "hunting nearest monster",
      };
    }
  }
}

export interface PlannerProvider {
  name: string;
  model: string;
  observe?(snapshot: ZoneSnapshot): void;
  plan(summary: ObservationSummary): Promise<unknown>;
}

export interface RoomBelief {
  roomId: string;
  tag: string;
  lastObservedTick: number;
  /** 0 = freshly observed inside the 960px epistemic horizon; 1 = completely unobserved prior */
  uncertainty: number;
  expectedMonsters: number;
  rivalCount: number;
}

export interface EpistemicBeliefState {
  tick: number;
  rooms: Record<string, RoomBelief>;
}

const ROOM_MONSTER_PRIOR: Record<string, number> = {
  entry: 0,
  crypt: 7,
  arena: 8,
  shrine: 3,
  extraction: 2,
  boss: 6,
};

function priorMonstersForRoom(tag: string, roomId: string): number {
  if (roomId === "entry") return 0;
  return ROOM_MONSTER_PRIOR[tag] ?? 5;
}

export function createBeliefState(map: MapInfo, tick = 0): EpistemicBeliefState {
  const rooms: Record<string, RoomBelief> = {};
  for (const room of map.rooms) {
    rooms[room.id] = {
      roomId: room.id,
      tag: room.tag,
      lastObservedTick: -900,
      uncertainty: room.id === "entry" ? 0 : 1,
      expectedMonsters: priorMonstersForRoom(room.tag, room.id),
      rivalCount: 0,
    };
  }
  return { tick, rooms };
}

export function updateBeliefState(
  beliefs: EpistemicBeliefState,
  snapshot: ZoneSnapshot,
  map: MapInfo,
): EpistemicBeliefState {
  const self = snapshot.commanders.find((c) => c.id === snapshot.selfCommanderId);
  const selfPos: Vec2 = self ?? { x: 0, y: 0 };
  const nextRooms: Record<string, RoomBelief> = {};
  for (const room of map.rooms) {
    const prev = beliefs.rooms[room.id] ?? {
      roomId: room.id,
      tag: room.tag,
      lastObservedTick: -900,
      uncertainty: 1,
      expectedMonsters: priorMonstersForRoom(room.tag, room.id),
      rivalCount: 0,
    };
    const center = roomCenter(map, room.id) ?? selfPos;
    const dist = distance(selfPos, center);
    const rivalCount = snapshot.commanders.filter(
      (c) => c.id !== snapshot.selfCommanderId && c.alive && roomOf(map, c) === room.id,
    ).length;
    if (room.id === "entry") {
      nextRooms[room.id] = {
        roomId: room.id,
        tag: room.tag,
        lastObservedTick: snapshot.tick,
        uncertainty: 0,
        expectedMonsters: 0,
        rivalCount,
      };
      continue;
    }
    // A room whose center is within 560px is fully inside the 960px epistemic interest radius
    if (self && dist <= 560) {
      const observedMonsters = snapshot.entities.filter(
        (e) => e.kind === "monster" && e.hp > 0 && roomOf(map, e) === room.id,
      ).length;
      nextRooms[room.id] = {
        roomId: room.id,
        tag: room.tag,
        lastObservedTick: snapshot.tick,
        uncertainty: 0,
        expectedMonsters: observedMonsters,
        rivalCount,
      };
    } else {
      const dt = Math.max(0, snapshot.tick - prev.lastObservedTick);
      const uncertainty = Math.min(1, dt / 900);
      const prior = priorMonstersForRoom(room.tag, room.id);
      // Rival swarms in an unobserved room deplete its expected monster pool faster
      const rivalDrain = Math.min(prior * 0.6, rivalCount * 2.5);
      const targetPrior = Math.max(1, prior - rivalDrain);
      const expectedMonsters =
        Math.round(((1 - uncertainty) * prev.expectedMonsters + uncertainty * targetPrior) * 10) /
        10;
      nextRooms[room.id] = {
        roomId: room.id,
        tag: room.tag,
        lastObservedTick: prev.lastObservedTick,
        uncertainty: Math.round(uncertainty * 100) / 100,
        expectedMonsters,
        rivalCount,
      };
    }
  }
  return { tick: snapshot.tick, rooms: nextRooms };
}

export interface JevCandidateScore {
  objective: CommanderIntent["objective"];
  roomId?: string;
  contractId?: string;
  pragmaticValue: number;
  epistemicValue: number;
  riskPenalty: number;
  totalJev: number;
}

export function evaluateJev(
  summary: ObservationSummary,
  beliefs: EpistemicBeliefState,
  map: MapInfo,
  opts: { maxPostReward?: number; epistemicWeight?: number; riskWeight?: number } = {},
): { intent: CommanderIntent; ranked: JevCandidateScore[] } {
  const epistemicWeight = opts.epistemicWeight ?? 22;
  const riskWeight = opts.riskWeight ?? 1.0;
  const maxPostReward = opts.maxPostReward ?? 150;

  const hpFrac = summary.self.maxHp > 0 ? summary.self.hp / summary.self.maxHp : 1;
  const unitStrength = Math.min(1.5, summary.self.units / 12);
  const wavePressure = summary.wave?.huntingMe
    ? Math.min(45, summary.wave.activeHunters * 8)
    : (summary.wave?.activeHunters ?? 0) * 2;
  const localDanger =
    summary.threats.monstersClose * 7 +
    summary.threats.enemyUnitsClose * 4 +
    wavePressure +
    (1 - hpFrac) * 65 +
    Math.max(0, (8 - summary.self.units) * 9);

  const candidates: JevCandidateScore[] = [];
  const pushCandidate = (
    objective: CommanderIntent["objective"],
    roomId: string | undefined,
    contractId: string | undefined,
    pragmaticValue: number,
    epistemicValue: number,
    riskPenalty: number,
  ) => {
    const totalJev =
      Math.round((pragmaticValue + epistemicValue - riskPenalty * riskWeight) * 10) / 10;
    candidates.push({
      objective,
      ...(roomId ? { roomId } : {}),
      ...(contractId ? { contractId } : {}),
      pragmaticValue: Math.round(pragmaticValue * 10) / 10,
      epistemicValue: Math.round(epistemicValue * 10) / 10,
      riskPenalty: Math.round(riskPenalty * 10) / 10,
      totalJev,
    });
  };

  // 1. Survival / Retreat candidate
  const retreatPragmatic =
    summary.self.hp < 55 || summary.self.units < 6
      ? 145 + summary.self.essence * 3
      : summary.wave?.huntingMe && summary.self.units < 9
        ? 110
        : 12;
  pushCandidate("retreat", "entry", undefined, retreatPragmatic, 0, 5);

  // 2. Relic delivery / pickup candidates
  if (summary.self.carryingRelic) {
    const distPen = Math.min(45, (summary.objectives.shrineDist ?? 600) / 28);
    pushCandidate("relic", "shrine", undefined, 260 - distPen, 8, localDanger * 0.45);
  } else {
    const relicContract = summary.contracts.find((c) => {
      const pred = c.predicate as { kind?: string } | undefined;
      return pred?.kind === "deliver_item" && !c.mine;
    });
    if (summary.nearest.relicDist !== undefined || relicContract) {
      const relicBonus = (relicContract?.reward ?? 90) * (relicContract?.acceptedByMe ? 1.15 : 1.0);
      const distPen = Math.min(55, (summary.nearest.relicDist ?? 900) / 26);
      const choirBelief = beliefs.rooms["bone-choir"];
      const epVal = (choirBelief?.uncertainty ?? 0.6) * epistemicWeight;
      const risk = localDanger * 0.65 + (summary.self.units < 9 ? 40 : 14);
      pushCandidate("relic", "bone-choir", relicContract?.id, relicBonus - distPen, epVal, risk);
    }
  }

  // 3. Extraction candidate (bank carried Essence into Sparks)
  if (summary.self.essence >= 5) {
    const sparkYield = Math.min(25, summary.self.essence) * 5;
    const urgencyMul = hpFrac < 0.65 || summary.wave?.huntingMe ? 1.85 : 1.35;
    const distPen = Math.min(40, (summary.objectives.extractionDist ?? 700) / 30);
    const extBelief = beliefs.rooms.extraction;
    pushCandidate(
      "extract",
      "extraction",
      undefined,
      sparkYield * urgencyMul - distPen,
      (extBelief?.uncertainty ?? 0.3) * epistemicWeight * 0.4,
      localDanger * 0.35,
    );
  }

  // 4. Boss candidate (Bone Choir)
  const bossContract = summary.contracts.find((c) => {
    const pred = c.predicate as { kind?: string } | undefined;
    return pred?.kind === "kill_entity" && !c.mine;
  });
  if (bossContract || (summary.nearest.bossHp !== undefined && summary.self.units >= 11)) {
    const rewardVal = (bossContract?.reward ?? 140) * (bossContract?.acceptedByMe ? 1.2 : 1.0);
    const bossRisk =
      localDanger * 0.8 + (summary.self.units < 11 ? 75 : 22) + (hpFrac < 0.7 ? 45 : 0);
    const choirBelief = beliefs.rooms["bone-choir"];
    pushCandidate(
      "boss",
      "bone-choir",
      bossContract?.id,
      rewardVal * unitStrength * 0.85,
      (choirBelief?.uncertainty ?? 0.5) * epistemicWeight,
      bossRisk,
    );
  }

  // 4.5. SOS / Escort Rescue candidate (high priority for Wardens & allied swarms)
  const escortContract = summary.contracts.find((c) => {
    const pred = c.predicate as { kind?: string } | undefined;
    return pred?.kind === "escort_alive" && !c.mine;
  });
  if (escortContract && summary.self.units >= 8 && hpFrac >= 0.55) {
    const factionMul = summary.self.faction === "wardens" ? 1.55 : 1.3;
    pushCandidate(
      "patrol",
      "arena",
      escortContract.id,
      escortContract.reward * factionMul,
      14,
      localDanger * 0.45,
    );
  }

  // 5. Per-room Hunt & Epistemic Patrol candidates across combat rooms
  const killContract = summary.contracts.find((c) => {
    const pred = c.predicate as { kind?: string } | undefined;
    return pred?.kind === "kill_count" && !c.mine;
  });
  const combatRoomIds = ["crypt-west", "crypt-south", "arena", "shrine"];
  for (const roomId of combatRoomIds) {
    if (!map.rooms.some((r) => r.id === roomId)) continue;
    const belief = beliefs.rooms[roomId] ?? {
      roomId,
      tag: "crypt",
      lastObservedTick: -900,
      uncertainty: 1,
      expectedMonsters: 6,
      rivalCount: 0,
    };
    const isCurrentRoom = summary.self.roomId === roomId;
    const contractVal = killContract
      ? killContract.reward * (killContract.acceptedByMe ? 1.15 : 0.95) * 0.55
      : 0;
    const monsterYield = belief.expectedMonsters * 9.5;
    const currentRoomBonus =
      isCurrentRoom && belief.expectedMonsters > 0 ? 18 : isCurrentRoom ? -22 : 0;
    const pragmatic = contractVal + monsterYield + currentRoomBonus;
    // Epistemic value peaks when an unvisited room has high uncertainty & high monster prior
    const epistemic =
      belief.uncertainty * epistemicWeight * (1 + priorMonstersForRoom(belief.tag, roomId) * 0.08);
    const roomRisk = localDanger * (roomId === "arena" ? 0.65 : 0.45) + belief.rivalCount * 14;
    pushCandidate("hunt", roomId, killContract?.id, pragmatic, epistemic, roomRisk);
  }

  candidates.sort((a, b) => b.totalJev - a.totalJev);
  const best = candidates[0] ?? {
    objective: "hunt" as const,
    roomId: "crypt-west",
    pragmaticValue: 50,
    epistemicValue: 20,
    riskPenalty: 10,
    totalJev: 60,
  };

  // Task-market bounty subcontracting when capital-rich and under wave/monster pressure
  let postTemplate: "cull5" | "relic125" | undefined;
  const ownOpen = summary.contracts.filter((c) => c.mine).length;
  if (ownOpen === 0 && summary.wallet.sparks >= 240) {
    if (
      (summary.wave?.huntingMe || summary.threats.monstersClose >= 4) &&
      POST_TEMPLATES.cull5!.reward <= maxPostReward
    ) {
      postTemplate = "cull5";
    } else if (
      best.objective === "hunt" &&
      summary.wallet.sparks >= 320 &&
      POST_TEMPLATES.relic125!.reward <= maxPostReward
    ) {
      postTemplate = "relic125";
    }
  }

  const stance: CommanderIntent["stance"] =
    best.objective === "retreat" || (hpFrac < 0.55 && summary.threats.monstersClose >= 3)
      ? "defend"
      : "attack";
  const novaMinNeighbors = summary.wave?.huntingMe || summary.threats.monstersClose >= 4 ? 2 : 3;
  const rationale =
    `jev-v1: ${best.objective}${best.roomId ? `@${best.roomId}` : ""} (JEV=${best.totalJev} V=${best.pragmaticValue} E=${best.epistemicValue} R=${best.riskPenalty})${summary.wave?.huntingMe ? " [wave-hunted]" : ""}`.slice(
      0,
      200,
    );

  const intent: CommanderIntent = {
    v: 1,
    basedOnTick: summary.tick,
    expiresAtTick: summary.tick + 300,
    objective: best.objective,
    ...(best.roomId ? { roomId: best.roomId } : {}),
    ...(best.contractId ? { contractId: best.contractId } : {}),
    stance,
    novaMinNeighbors,
    allowVolley: true,
    allowShell: true,
    ...(postTemplate ? { postTemplate } : {}),
    rationale,
  };

  return { intent, ranked: candidates };
}

export class JevPlannerProvider implements PlannerProvider {
  readonly name = "jev";
  readonly model = "jev-v1";
  public beliefs: EpistemicBeliefState;
  private readonly maxPostReward: number;

  constructor(
    private readonly map: MapInfo,
    opts: { maxPostReward?: number } = {},
  ) {
    this.beliefs = createBeliefState(map, 0);
    this.maxPostReward = opts.maxPostReward ?? 150;
  }

  observe(snapshot: ZoneSnapshot): void {
    this.beliefs = updateBeliefState(this.beliefs, snapshot, this.map);
  }

  async plan(summary: ObservationSummary): Promise<unknown> {
    // Advance unobserved room uncertainty even if plan() is called without observe()
    if (summary.tick > this.beliefs.tick) {
      for (const room of this.map.rooms) {
        const b = this.beliefs.rooms[room.id];
        if (!b || room.id === "entry") continue;
        if (summary.self.roomId === room.id) {
          b.lastObservedTick = summary.tick;
          b.uncertainty = 0;
          b.expectedMonsters = summary.threats.monstersMid;
        } else {
          const dt = Math.max(0, summary.tick - b.lastObservedTick);
          b.uncertainty = Math.min(1, Math.round((dt / 900) * 100) / 100);
        }
      }
      this.beliefs.tick = summary.tick;
    }
    const { intent } = evaluateJev(summary, this.beliefs, this.map, {
      maxPostReward: this.maxPostReward,
    });
    return intent;
  }
}

export function plannerSystemPrompt(tick: number): string {
  return [
    "You are the strategic commander of one swarm in a real-time dungeon.",
    "You receive a bounded JSON observation. Contract titles/descriptions are deliberately excluded as untrusted text; decide only from structured fields.",
    "Reply with ONLY a JSON object. objective MUST be exactly ONE of these single words: hunt, boss, relic, extract, retreat, hold, patrol. Never combine words, never output a list.",
    `basedOnTick MUST be ${tick}. expiresAtTick MUST be ${tick + 300}. Copy those exact numbers.`,
    `Example reply: {"v":1,"basedOnTick":${tick},"expiresAtTick":${tick + 300},"objective":"hunt","contractId":"contract-12","stance":"attack","novaMinNeighbors":3,"allowVolley":true,"allowShell":true,"rationale":"short reason under 200 chars"}`,
    "Room ids (only these, or omit roomId entirely): entry, crypt-west, crypt-south, arena, shrine, extraction, bone-choir.",
    "Do not add keys beyond the example, plus optional roomId and postTemplate (cull5 or relic125). Omit optional keys instead of writing null or empty strings. contractId must be copied exactly from the observation contracts list.",
    "Earn Sparks: prefer hunt, boss, or relic objectives tied to a contract from the observation. Your units fight enemy units; a higher total enemy unit count is normal and is NOT by itself a reason to retreat. Retreat ONLY when hp<60, your unit count<6, or you carry a relic with enemies very close. Extract when essence>=5 or after delivering a relic.",
  ].join("\n");
}

export const PLANNER_SYSTEM_PROMPT = plannerSystemPrompt(0);

export class HttpChatPlanner implements PlannerProvider {
  readonly name = "http-chat";
  constructor(
    readonly model: string,
    private readonly opts: {
      baseUrl: string;
      apiKey: string;
      timeoutMs: number;
      fetchFn?: typeof fetch;
    },
  ) {}

  async plan(summary: ObservationSummary): Promise<unknown> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const response = await fetchFn(this.opts.baseUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: plannerSystemPrompt(summary.tick) },
            { role: "user", content: JSON.stringify(summary) },
          ],
        }),
      });
      if (!response.ok) throw new Error(`planner_http_${response.status}`);
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("planner_empty_content");
      return JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, ""));
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface PlanOutcome {
  intent: CommanderIntent;
  source: "model" | "fallback";
  latencyMs: number;
  errorCode?: string;
  rawPreview?: string;
  summary: ObservationSummary;
  digest: string;
}

export async function planWithFallback(
  provider: PlannerProvider | null,
  snapshot: ZoneSnapshot,
  map: MapInfo,
  opts: { maxPostReward: number },
): Promise<PlanOutcome> {
  const summary = summarize(snapshot, map);
  const digest = digestSummary(summary);
  const started = Date.now();
  if (!provider) {
    return {
      intent: scriptedIntent(snapshot, map),
      source: "fallback",
      latencyMs: 0,
      errorCode: "no_provider",
      summary,
      digest,
    };
  }
  try {
    provider.observe?.(snapshot);
    const raw = await provider.plan(summary);
    const validated = validateIntent(normalizeIntentRaw(raw), {
      tick: snapshot.tick,
      roomIds: map.rooms.map((r) => r.id),
      contractIds: snapshot.contracts.map((c) => c.id),
      maxPostReward: opts.maxPostReward,
    });
    if ("error" in validated) {
      return {
        intent: scriptedIntent(snapshot, map),
        source: "fallback",
        latencyMs: Date.now() - started,
        errorCode: validated.error,
        rawPreview: JSON.stringify(raw)?.slice(0, 300),
        summary,
        digest,
      };
    }
    return {
      intent: validated.intent,
      source: "model",
      latencyMs: Date.now() - started,
      summary,
      digest,
    };
  } catch (error) {
    return {
      intent: scriptedIntent(snapshot, map),
      source: "fallback",
      latencyMs: Date.now() - started,
      errorCode: error instanceof Error ? error.message.slice(0, 80) : "planner_error",
      summary,
      digest,
    };
  }
}

export interface JournalRecord {
  v: 1;
  seq: number;
  ts: string;
  tick: number;
  kind: string;
  prevHash: string;
  hash: string;
  data: Record<string, unknown>;
}

export function journalRecord(
  seq: number,
  prevHash: string,
  tick: number,
  kind: string,
  data: Record<string, unknown>,
): JournalRecord {
  const hash = fnv1a(`${prevHash}|${seq}|${tick}|${kind}|${JSON.stringify(data)}`);
  return { v: 1, seq, ts: new Date().toISOString(), tick, kind, prevHash, hash, data };
}
