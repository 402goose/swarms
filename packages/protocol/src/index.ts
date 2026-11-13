import { z } from "zod";

export const SCHEMA_VERSION = "swarms.protocol.v2" as const;
export const TICK_RATE = 30;
export const TICK_SECONDS = 1 / TICK_RATE;
export const SNAPSHOT_MS = 100;

export const Vec2Schema = z
  .object({
    x: z.number().finite().min(-10_000).max(10_000),
    y: z.number().finite().min(-10_000).max(10_000),
  })
  .strict();
export type Vec2 = z.infer<typeof Vec2Schema>;

export const SpellIdSchema = z.enum(["nova", "volley", "shell", "frost", "chain"]);
export type SpellId = z.infer<typeof SpellIdSchema>;

export const UpgradeIdSchema = z.enum([
  "might",
  "swift",
  "brood",
  "magnet",
  "vitality",
  "arcane",
  "scatter",
  "lance",
  "orbit",
  "wisp",
  "scythe",
  "storm",
  "hellscatter",
  "phantom",
]);
export type UpgradeId = z.infer<typeof UpgradeIdSchema>;

export const WeaponIdSchema = z.enum([
  "bolt",
  "scatter",
  "lance",
  "orbit",
  "wisp",
  "scythe",
  "storm",
  "hellscatter",
  "phantom",
]);
export type WeaponId = z.infer<typeof WeaponIdSchema>;

export const CharacterIdSchema = z.enum(["necromancer", "warlock", "boneknight"]);
export type CharacterId = z.infer<typeof CharacterIdSchema>;

export const FactionIdSchema = z.enum(["wardens", "reapers"]);
export type FactionId = z.infer<typeof FactionIdSchema>;

export const AgentTierSchema = z.enum(["tap", "self", "unverified"]);
export type AgentTier = z.infer<typeof AgentTierSchema>;

export const CopilotDirectiveSchema = z.enum([
  "off",
  "auto",
  "boss",
  "hunt_rivals",
  "farm_crypts",
  "escort_relic",
  "sanctuary",
]);
export type CopilotDirective = z.infer<typeof CopilotDirectiveSchema>;

export const CommsChannelSchema = z.enum(["faction", "global", "forge"]);
export type CommsChannel = z.infer<typeof CommsChannelSchema>;

export const ReliquarySlotSchema = z.enum(["weapon_rune", "armor", "relic_ring", "war_banner"]);
export type ReliquarySlot = z.infer<typeof ReliquarySlotSchema>;

export const ReliquaryRaritySchema = z.enum(["runic", "sovereign", "mythic"]);
export type ReliquaryRarity = z.infer<typeof ReliquaryRaritySchema>;

export const ReliquaryItemIdSchema = z.enum([
  "ashbrand_seal",
  "choirbane_sigil",
  "first_seal_edge",
  "wardens_plate",
  "ossuary_cuirass",
  "undying_shroud",
  "ember_band",
  "blood_moor_signet",
  "bone_choir_eye",
  "thrall_standard",
  "breach_herald",
  "ashen_host_banner",
]);
export type ReliquaryItemId = z.infer<typeof ReliquaryItemIdSchema>;

/** Micro-settlement rate: 1 Spark = $0.001 USD equivalent */
export const SPARK_USD_RATE = 0.001;

export const GameCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), target: Vec2Schema }).strict(),
  z.object({ type: z.literal("attackMove"), target: Vec2Schema }).strict(),
  z.object({ type: z.literal("defend"), target: Vec2Schema }).strict(),
  z.object({ type: z.literal("retreat") }).strict(),
  z.object({ type: z.literal("stop") }).strict(),
  z.object({ type: z.literal("cast"), spell: SpellIdSchema, target: Vec2Schema }).strict(),
  z.object({ type: z.literal("chooseUpgrade"), upgrade: UpgradeIdSchema }).strict(),
  z.object({ type: z.literal("shoot"), target: Vec2Schema }).strict(),
  z
    .object({
      type: z.literal("steer"),
      dx: z.number().finite().min(-1).max(1),
      dy: z.number().finite().min(-1).max(1),
    })
    .strict(),
  z.object({ type: z.literal("switchWeapon"), weapon: WeaponIdSchema }).strict(),
  z.object({ type: z.literal("raiseUnit") }).strict(),
  z.object({ type: z.literal("extract") }).strict(),
]);
export type GameCommand = z.infer<typeof GameCommandSchema>;

export const ContractPredicateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("kill_count"),
      targetTag: z.string().min(1).max(48),
      count: z.number().int().positive().max(10_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("kill_entity"),
      entityId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("escort_alive"),
      subjectCommanderId: z.string().min(1).max(128),
      withinDistance: z.number().positive().max(5_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deliver_item"),
      itemTemplateId: z.string().min(1).max(64),
      destination: z.enum(["shrine", "extraction"]),
    })
    .strict(),
]);
export type ContractPredicate = z.infer<typeof ContractPredicateSchema>;

export const ContractMechanismSchema = z.enum([
  "open_race",
  "piece_rate",
  "exclusive_lease",
  "party_share",
  "directed_offer",
]);
export type ContractMechanism = z.infer<typeof ContractMechanismSchema>;

export const ContractAttributionSchema = z.enum(["final_blow", "progress_share", "damage_share"]);
export type ContractAttribution = z.infer<typeof ContractAttributionSchema>;

export const ContractDraftSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(500).default(""),
    predicate: ContractPredicateSchema,
    reward: z.number().int().positive().max(1_000_000),
    mode: z.enum(["claim", "bounty"]).default("bounty"),
    mechanism: ContractMechanismSchema.optional(),
    attribution: ContractAttributionSchema.optional(),
    maxClaimants: z.number().int().min(1).max(32).optional(),
    bond: z.number().int().nonnegative().max(1_000_000).optional(),
    leaseTicks: z
      .number()
      .int()
      .min(TICK_RATE)
      .max(TICK_RATE * 60 * 30)
      .optional(),
    directedToCommanderId: z.string().min(1).max(128).optional(),
    zoneId: z.string().min(1).max(64).optional(),
    ttlTicks: z
      .number()
      .int()
      .min(TICK_RATE)
      .max(TICK_RATE * 60 * 30),
  })
  .strict();
export type ContractDraft = z.infer<typeof ContractDraftSchema>;

export const ServiceIdSchema = z.enum([
  "mend",
  "rally",
  "scout",
  "revive",
  "mercenary",
  "armory",
  "sos",
  "agent",
  "swarm_war",
  "tap_verify",
  "sovereign_edict",
  "sanctuary_recall",
]);
export type ServiceId = z.infer<typeof ServiceIdSchema>;

const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      schemaVersion: z.literal(SCHEMA_VERSION),
      name: z.string().trim().min(1).max(40),
      kind: z.enum(["human", "agent"]).default("human"),
      resumeToken: z.string().min(8).max(128).optional(),
      character: CharacterIdSchema.optional(),
      faction: FactionIdSchema.optional(),
      tier: AgentTierSchema.optional(),
      tapKeyId: z.string().min(4).max(128).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("command"),
      seq: z.number().int().nonnegative(),
      command: GameCommandSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("postContract"),
      idempotencyKey: IdempotencyKeySchema,
      draft: ContractDraftSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("acceptContract"),
      idempotencyKey: IdempotencyKeySchema,
      contractId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("cancelContract"),
      idempotencyKey: IdempotencyKeySchema,
      contractId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("buyService"),
      idempotencyKey: IdempotencyKeySchema,
      service: ServiceIdSchema,
    })
    .strict(),
  z.object({ type: z.literal("ping"), at: z.number().optional() }).strict(),
  z.object({ type: z.literal("requestWorld") }).strict(),
  z.object({ type: z.literal("abandon") }).strict(),
  z
    .object({
      type: z.literal("setCopilot"),
      enabled: z.boolean(),
      directive: CopilotDirectiveSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("sendComms"),
      channel: CommsChannelSchema.default("faction"),
      text: z.string().trim().min(1).max(280),
    })
    .strict(),
  z
    .object({
      type: z.literal("vouch"),
      targetCommanderId: z.string().min(1).max(128),
      reason: z.string().max(140).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("equipItem"),
      itemId: ReliquaryItemIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("salvageItem"),
      itemId: ReliquaryItemIdSchema,
    })
    .strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type EntityKind = "commander" | "unit" | "monster";

export interface EntitySnapshot {
  id: string;
  kind: EntityKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  radius: number;
  ownerId?: string;
  teamId?: string;
  tag?: string;
  carryingItemId?: string;
  slowed?: boolean;
  elite?: boolean;
  alerted?: boolean;
}

export interface CommanderSnapshot {
  id: string;
  accountId: string;
  name: string;
  kind: "human" | "agent" | "bot";
  character?: CharacterId;
  faction?: FactionId;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  command: number;
  maxCommand: number;
  essence: number;
  alive: boolean;
  extracted: boolean;
  unitCount: number;
  carryingItemId?: string;
  level?: number;
  xp?: number;
  xpNext?: number;
  pendingUpgrades?: UpgradeId[];
  upgrades?: Partial<Record<UpgradeId, number>>;
  spellReadyAt?: Record<SpellId, number>;
  shellActive?: boolean;
  slowActive?: boolean;
  hasteActive?: boolean;
  fangActive?: boolean;
  frenzyActive?: boolean;
  buffTicks?: Partial<Record<"shell" | "haste" | "fang" | "frenzy", number>>;
  stance?: string;
  weapon?: WeaponId;
  weapons?: WeaponId[];
  vx?: number;
  vy?: number;
  moveSpeed?: number;
  pvpGrace?: boolean;
  pvpGraceTicks?: number;
  graceBlockedAtTick?: number;
  respawnAtTick?: number;
  tier?: AgentTier;
  tapKeyId?: string;
  tapRegistry?: string;
  kills?: number;
  bountiesCompleted?: number;
  inSanctuary?: boolean;
  copilotEnabled?: boolean;
  copilotDirective?: CopilotDirective;
  copilotSparksEarned?: number;
  vouches?: number;
  lastCommsText?: string;
  lastCommsTick?: number;
  equipped?: Partial<Record<ReliquarySlot, ReliquaryItemId>>;
  vault?: ReliquaryItemId[];
}

export interface PickupSnapshot {
  id: string;
  templateId: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  reliquaryItemId?: ReliquaryItemId;
}

export type ContractStatus =
  | "open"
  | "accepted"
  | "satisfied"
  | "settled"
  | "expired"
  | "refunded"
  | "cancelled";

export interface ContractPayout {
  commanderId: string;
  accountId: string;
  amount: number;
  tick: number;
  kind: "settlement" | "piece";
}

export interface ContractSnapshot {
  id: string;
  issuerId: string;
  title: string;
  description: string;
  predicate: ContractPredicate;
  reward: number;
  mode: "claim" | "bounty";
  mechanism?: ContractMechanism;
  attribution?: ContractAttribution;
  maxClaimants?: number;
  bond?: number;
  leaseTicks?: number;
  leaseExpiresAtTick?: number;
  directedToCommanderId?: string;
  zoneId?: string;
  postingFee?: number;
  referenceReward?: number;
  status: ContractStatus;
  claimantId?: string;
  participants: string[];
  progress: number;
  progressByCommander: Record<string, number>;
  damageByCommander?: Record<string, number>;
  paidOut?: number;
  payouts?: ContractPayout[];
  opensAtTick: number;
  expiresAtTick: number;
  closedAtTick?: number;
  settlementId?: string;
}

export interface ReputationSnapshot {
  accountId: string;
  score: number;
  completed: number;
  settledValue: number;
  uniqueIssuers: number;
  expiredClaims: number;
}

export interface FeedEntry {
  seq: number;
  tick: number;
  kind: string;
  text: string;
  commanderId?: string;
  contractId?: string;
}

export interface SpellEffect {
  kind: "chain";
  points: Vec2[];
  tick: number;
}

export interface ProjectileSnapshot {
  id: string;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  ownerId: string;
  radius?: number;
  weapon?: WeaponId;
}

export interface WaveStatus {
  number: number;
  title: string;
  nextAtTick: number;
  activeHunters: number;
  targetCommanderId?: string;
}

export interface FactionWarStatus {
  wardensScore: number;
  reapersScore: number;
  wardensCommanders: number;
  reapersCommanders: number;
  leadingFaction?: FactionId;
  sparkUsdRate: number;
}

export interface CommsMessage {
  id: string;
  tick: number;
  senderId: string;
  senderName: string;
  faction?: FactionId;
  tier?: AgentTier;
  channel: CommsChannel;
  text: string;
}

export interface ZoneWorldSnapshot {
  widthTiles: number;
  heightTiles: number;
  tileSize: number;
  walls: string[];
  rooms?: Array<{ id: string; x: number; y: number; w: number; h: number; tag: string }>;
}

export interface ZoneSnapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  tick: number;
  zoneId: string;
  world: ZoneWorldSnapshot;
  worldHash?: string;
  selfCommanderId: string;
  commanders: CommanderSnapshot[];
  entities: EntitySnapshot[];
  pickups: PickupSnapshot[];
  projectiles?: ProjectileSnapshot[];
  contracts: ContractSnapshot[];
  wallet: {
    accountId?: string;
    sparks: number;
    onboardingCredits?: number;
    escrowed: number;
    openContracts?: number;
    reputation?: ReputationSnapshot;
  };
  feed: FeedEntry[];
  effects?: SpellEffect[];
  wave?: WaveStatus;
  factions?: FactionWarStatus;
  comms?: CommsMessage[];
}

export type ZoneSnapshotFrame = Omit<ZoneSnapshot, "world"> & {
  world?: ZoneWorldSnapshot;
  worldHash: string;
};

export type ServerMessage =
  | {
      type: "welcome";
      schemaVersion: typeof SCHEMA_VERSION;
      sessionId: string;
      commanderId: string;
      accountId?: string;
      resumeToken: string;
    }
  | { type: "snapshot"; snapshot: ZoneSnapshotFrame }
  | {
      type: "serviceResult";
      idempotencyKey: string;
      service: ServiceId;
      cost: number;
      paidWith: "onboarding" | "sparks";
      detail: string;
    }
  | { type: "ack"; seq?: number; idempotencyKey?: string; ok: true }
  | { type: "error"; code: string; message: string; seq?: number }
  | { type: "pong"; at?: number; serverTick: number };

export function parseClientMessage(raw: string): ClientMessage {
  return ClientMessageSchema.parse(JSON.parse(raw));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
