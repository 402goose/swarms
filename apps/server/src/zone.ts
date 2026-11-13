import { createHash, randomUUID } from "node:crypto";
import {
  BURN_ACCOUNT,
  ContractEngine,
  DUNGEON_ACCOUNT,
  Ledger,
  type LedgerEntry,
  onboardingAccount,
  postingFeeFor,
  TREASURY_ACCOUNT,
} from "@swarms/bounties";
import {
  CHARACTER_IDS,
  type CharacterId,
  ECONOMY,
  FACTION_IDS,
  FACTIONS,
  RELIQUARY_ITEMS,
  type ReliquaryItemId,
  type ReliquarySlot,
  UPGRADES,
  type UpgradeId,
  WEAPONS,
  type WeaponId,
} from "@swarms/content";
import type { ZoneStore } from "@swarms/persistence";
import type {
  AgentTier,
  CommsChannel,
  CommsMessage,
  ContractDraft,
  ContractSnapshot,
  CopilotDirective,
  FactionId,
  FactionWarStatus,
  FeedEntry,
  GameCommand,
  ServiceId,
  ZoneSnapshot,
  ZoneSnapshotFrame,
} from "@swarms/protocol";
import { SCHEMA_VERSION, SPARK_USD_RATE } from "@swarms/protocol";
import { type SimEvent, SimWorld } from "@swarms/sim";

export interface ParkedCommander {
  x: number;
  y: number;
  hp: number;
  essence: number;
  alive: boolean;
  unitCount: number;
  level?: number;
  xp?: number;
  upgrades?: Partial<Record<UpgradeId, number>>;
  character?: CharacterId;
  faction?: FactionId;
  weapons?: WeaponId[];
  weapon?: WeaponId;
  lastSeq?: number;
}

export interface AccountRecord {
  id: string;
  displayName: string;
  kind: "human" | "agent" | "bot";
  createdTick: number;
  onboardingGrantClaimed: boolean;
  onboardingGranted: number;
}

export interface SessionRecord {
  token: string;
  tokenHash: string;
  sessionId: string;
  commanderId: string;
  accountId: string;
  name: string;
  kind: "human" | "agent" | "bot";
  parked?: ParkedCommander;
}

type StoredSessionRecord = Omit<SessionRecord, "token"> & { token?: string };

interface Checkpoint {
  version: 1 | 2 | 3;
  sim: ReturnType<SimWorld["serialize"]>;
  ledger: unknown;
  contracts: unknown;
  sessions: StoredSessionRecord[];
  accounts?: AccountRecord[];
  nextCommander: number;
  nextAccount?: number;
  treasuryEpoch?: number;
  eventSeq: number;
  feed: FeedEntry[];
  botCounter?: number;
  wardensScore?: number;
  reapersScore?: number;
}

export interface ServiceResult {
  service: ServiceId;
  cost: number;
  paidWith: "onboarding" | "sparks";
  detail: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const ESSENCE_BANK_CAP = 50;
const ESSENCE_SPARK_VALUE = 2;

export const DEFAULT_INTEREST_RADIUS = 960;

export interface SnapshotOptions {
  includeWorld?: boolean;
  interestRadius?: number;
}

export type SnapshotCore = Omit<ZoneSnapshotFrame, "contracts" | "selfCommanderId" | "wallet">;

export class ZoneRuntime {
  readonly zoneId = "zone-1";
  world!: SimWorld;
  ledger!: Ledger;
  contracts!: ContractEngine;
  private sessions = new Map<string, SessionRecord>();
  private accounts = new Map<string, AccountRecord>();
  private nextAccount = 1;
  private treasuryEpoch = -1;
  private pendingLeave = new Map<string, number>();
  private nextCommander = 1;
  private eventSeq = 0;
  private feed: FeedEntry[] = [];
  private botCounter = 0;
  private inProcessAgents = new Set<string>();
  wardensScore = 0;
  reapersScore = 0;
  private botState = new Map<
    string,
    {
      mode: "sortie" | "retreat";
      waypoint: number;
      issuedKey: string;
      lastAdvanceTick: number;
      lastX: number;
      lastY: number;
    }
  >();
  private pendingContractArchive: ContractSnapshot[] = [];
  private pendingLedgerArchive: LedgerEntry[] = [];
  readonly comms: CommsMessage[] = [];
  private vouchedPairs = new Set<string>();
  private pairingLinks = new Map<
    string,
    {
      pairCode: string;
      sessionToken: string;
      commanderId: string;
      accountId: string;
      name: string;
      faction: FactionId;
      character: CharacterId;
      expiresAtMs: number;
    }
  >();

  constructor(
    private readonly store?: ZoneStore,
    seed = 1337,
  ) {
    const contractOptions = {
      accountForCommander: (commanderId: string) =>
        [...this.sessions.values()].find((session) => session.commanderId === commanderId)
          ?.accountId,
      treasuryAccount: TREASURY_ACCOUNT,
      burnAccount: BURN_ACCOUNT,
      systemAccount: TREASURY_ACCOUNT,
    };
    const candidates = store
      ? (store.loadCheckpointCandidates?.<Checkpoint>() ??
        (() => {
          const checkpoint = store.loadCheckpoint<Checkpoint>();
          return checkpoint ? [checkpoint] : [];
        })())
      : [];
    let restored = false;
    let restoreError: unknown;
    for (const checkpoint of candidates) {
      try {
        if (checkpoint?.version !== 1 && checkpoint?.version !== 2 && checkpoint?.version !== 3) {
          throw new Error("unsupported_checkpoint_version");
        }
        if (
          !checkpoint.sim ||
          typeof checkpoint.sim !== "object" ||
          !Array.isArray(checkpoint.sessions) ||
          !Array.isArray(checkpoint.feed) ||
          !Number.isFinite(checkpoint.nextCommander) ||
          !Number.isFinite(checkpoint.eventSeq)
        ) {
          throw new Error("invalid_checkpoint");
        }
        const world = SimWorld.restore(checkpoint.sim);
        const ledger = Ledger.restore(checkpoint.ledger);
        if (!ledger.verifyBalances()) throw new Error("ledger_balance_mismatch");
        const contracts = ContractEngine.restore(ledger, checkpoint.contracts, contractOptions);
        contracts.verifyEscrow();
        this.world = world;
        this.ledger = ledger;
        this.contracts = contracts;
        this.accounts = new Map(
          (checkpoint.accounts ?? []).map((account) => [account.id, { ...account }]),
        );
        const restoredSessions: SessionRecord[] = checkpoint.sessions.map((stored) => {
          const tokenHash = stored.tokenHash ?? (stored.token ? hashToken(stored.token) : "");
          if (!tokenHash) throw new Error("invalid_checkpoint");
          const session: SessionRecord = { ...stored, token: "", tokenHash };
          if (!this.accounts.has(session.accountId)) {
            this.accounts.set(session.accountId, {
              id: session.accountId,
              displayName: session.name,
              kind: session.kind,
              createdTick: 0,
              onboardingGrantClaimed: true,
              onboardingGranted: 0,
            });
          }
          return session;
        });
        this.sessions = new Map(restoredSessions.map((s) => [s.tokenHash, s]));
        const maxAccount = Math.max(
          0,
          ...[...this.accounts.keys()].map((id) => {
            const match = /^acct-(\d+)$/.exec(id);
            return match ? Number(match[1]) : 0;
          }),
        );
        this.nextAccount = Math.max(checkpoint.nextAccount ?? 1, maxAccount + 1);
        this.treasuryEpoch = checkpoint.treasuryEpoch ?? -1;
        this.nextCommander = checkpoint.nextCommander;
        this.eventSeq = checkpoint.eventSeq;
        this.feed = checkpoint.feed;
        for (const session of restoredSessions) {
          if (session.kind !== "bot") {
            const parkedNow = this.captureParked(session.commanderId);
            if (parkedNow) session.parked = parkedNow;
            this.world.removeCommander(session.commanderId);
          }
        }
        const maxBotSeq = Math.max(
          -1,
          ...checkpoint.sessions
            .filter((s) => s.kind === "bot")
            .map((s) => this.world.commanders.get(s.commanderId)?.lastSeq ?? -1),
        );
        const seededCounter = maxBotSeq >= 1_000_000 ? maxBotSeq - 1_000_000 + 1 : 0;
        this.botCounter = Math.max(checkpoint.botCounter ?? 0, seededCounter);
        this.wardensScore = Math.max(0, Number(checkpoint.wardensScore ?? 0));
        this.reapersScore = Math.max(0, Number(checkpoint.reapersScore ?? 0));
        this.ensureTreasuryEpoch(this.world.tick);
        restored = true;
        break;
      } catch (error) {
        restoreError = error;
      }
    }
    if (candidates.length > 0 && !restored) {
      throw new Error("checkpoint_unrecoverable", { cause: restoreError });
    }
    if (!restored) {
      this.world = new SimWorld(seed);
      this.ledger = new Ledger();
      this.contracts = new ContractEngine(this.ledger, contractOptions);
      this.ensureTreasuryEpoch(0);
      for (const event of this.contracts.seedSystemContracts(0)) {
        this.pushFeed(event.tick, event.kind, event.text, event.actorId, event.contractId);
      }
      this.checkpoint();
    }
  }

  private ensureTreasuryEpoch(tick: number): void {
    const epoch = Math.floor(tick / ECONOMY.treasuryEpochTicks);
    if (epoch <= this.treasuryEpoch) return;
    this.ledger.transfer({
      from: DUNGEON_ACCOUNT,
      to: TREASURY_ACCOUNT,
      amount: ECONOMY.treasuryEpochBudget,
      kind: "treasury_epoch_funding",
      ref: `epoch:${epoch}`,
      tick,
      idempotencyKey: `treasury-epoch:${epoch}`,
    });
    this.treasuryEpoch = epoch;
  }

  account(accountId: string): AccountRecord | undefined {
    const account = this.accounts.get(accountId);
    return account ? { ...account } : undefined;
  }

  accountsSnapshot(): AccountRecord[] {
    return [...this.accounts.values()].map((account) => ({ ...account }));
  }

  private createAccount(name: string, kind: AccountRecord["kind"]): AccountRecord {
    const id = `acct-${this.nextAccount++}`;
    const granted = Math.min(
      ECONOMY.startingOnboardingCredits,
      Math.max(0, this.ledger.balance(TREASURY_ACCOUNT)),
    );
    const account: AccountRecord = {
      id,
      displayName: name,
      kind,
      createdTick: this.world.tick,
      onboardingGrantClaimed: true,
      onboardingGranted: granted,
    };
    this.accounts.set(id, account);
    this.ledger.ensureAccount(id, 0, this.world.tick);
    if (granted > 0) {
      this.ledger.transfer({
        from: TREASURY_ACCOUNT,
        to: onboardingAccount(id),
        amount: granted,
        kind: "onboarding_grant",
        ref: id,
        tick: this.world.tick,
        idempotencyKey: `onboarding:${id}`,
      });
    }
    return account;
  }

  join(input: {
    name: string;
    kind: "human" | "agent" | "bot";
    resumeToken?: string;
    character?: CharacterId;
    faction?: FactionId;
    tier?: AgentTier;
    tapKeyId?: string;
  }): SessionRecord {
    const character =
      input.character && CHARACTER_IDS.includes(input.character) ? input.character : undefined;
    const faction =
      input.faction && FACTION_IDS.includes(input.faction) ? input.faction : undefined;
    if (input.resumeToken) {
      const existing = this.sessions.get(hashToken(input.resumeToken));
      if (existing) {
        existing.token = input.resumeToken;
        if (!this.accounts.has(existing.accountId)) {
          this.accounts.set(existing.accountId, {
            id: existing.accountId,
            displayName: existing.name,
            kind: existing.kind,
            createdTick: this.world.tick,
            onboardingGrantClaimed: true,
            onboardingGranted: 0,
          });
        }
        this.pendingLeave.delete(existing.tokenHash);
        const liveCmdr = this.world.commanders.get(existing.commanderId);
        if (liveCmdr && faction) liveCmdr.faction = faction;
        if (!liveCmdr) {
          const parked = existing.parked;
          const entry = this.world.entryRect;
          const parkedInsideSanctuary =
            parked &&
            parked.x >= entry.x &&
            parked.x <= entry.x + entry.w &&
            parked.y >= entry.y &&
            parked.y <= entry.y + entry.h;
          const commanderNumber = Number(existing.commanderId.split("-").at(-1));
          const safeSpawn =
            this.world.map.spawnPoints[
              Math.abs(Number.isFinite(commanderNumber) ? commanderNumber : 0) %
                this.world.map.spawnPoints.length
            ]!;
          const restore =
            parked && !parkedInsideSanctuary
              ? { ...parked, x: safeSpawn.x, y: safeSpawn.y }
              : parked;
          const events = this.world.spawnCommander({
            id: existing.commanderId,
            accountId: existing.accountId,
            name: existing.name,
            kind: existing.kind,
            ...(character ? { character } : {}),
            ...(faction ? { faction } : {}),
            ...(restore ? { restore } : {}),
          });
          delete existing.parked;
          this.recordSimEvents(events);
          this.pushFeed(
            this.world.tick,
            "joined",
            `${existing.name} entered the dungeon`,
            existing.commanderId,
          );
          this.checkpoint();
        }
        return existing;
      }
    }
    const commanderId = `cmdr-${this.nextCommander++}`;
    const account = this.createAccount(input.name, input.kind);
    const token = randomUUID();
    const session: SessionRecord = {
      token,
      tokenHash: hashToken(token),
      sessionId: randomUUID(),
      commanderId,
      accountId: account.id,
      name: input.name,
      kind: input.kind,
    };
    this.sessions.set(session.tokenHash, session);
    const events = this.world.spawnCommander({
      id: commanderId,
      accountId: account.id,
      name: input.name,
      kind: input.kind === "bot" ? "bot" : input.kind,
      ...(character ? { character } : {}),
      ...(faction ? { faction } : {}),
    });
    if (input.tier === "tap") {
      this.world.promoteTapTier(commanderId, input.tapKeyId, "visa-production");
    } else if (input.tier === "self") {
      const cmdr = this.world.commanders.get(commanderId);
      if (cmdr) cmdr.tier = "self";
    }
    if (input.kind !== "bot") {
      const starterRelic: ReliquaryItemId =
        character === "boneknight"
          ? "wardens_plate"
          : character === "warlock"
            ? "ashbrand_seal"
            : "thrall_standard";
      this.world.grantReliquaryItem(commanderId, starterRelic, false);
    }
    this.recordSimEvents(events);
    this.pushFeed(this.world.tick, "joined", `${input.name} entered the dungeon`, commanderId);
    this.checkpoint();
    return session;
  }

  ensureBots(count: number): void {
    const names = ["Ash Swarm", "Moss Swarm", "Glass Swarm", "Ember Swarm"];
    const characters: CharacterId[] = ["boneknight", "warlock", "necromancer", "necromancer"];
    const existing = [...this.sessions.values()].filter((s) => s.kind === "bot").length;
    for (let i = existing; i < count; i++) {
      const bot = this.join({
        name: names[i % names.length]!,
        kind: "bot",
        character: characters[i % characters.length]!,
        faction: i % 2 === 0 ? "wardens" : "reapers",
      });
      const firstOpen = this.contracts
        .snapshotWindow({ commanderId: bot.commanderId, accountId: bot.accountId })
        .find((c) => c.status === "open");
      if (firstOpen) {
        try {
          this.contracts.accept({
            contractId: firstOpen.id,
            claimantId: bot.commanderId,
            claimantAccountId: bot.accountId,
            tick: this.world.tick,
            idempotencyKey: `bot-accept:${bot.commanderId}:${firstOpen.id}:v1`,
          });
        } catch {
          // Another bot or a claim-mode contract may already own it.
        }
      }
    }
  }

  spawnFactionAgent(faction: FactionId, character?: CharacterId): SessionRecord {
    const existing = [...this.sessions.values()].filter((s) =>
      this.inProcessAgents.has(s.commanderId),
    );
    if (existing.length >= 6) throw new Error("agents_at_cap");
    const characters: CharacterId[] = ["boneknight", "warlock", "necromancer"];
    const idx = existing.length;
    const prefix = faction === "reapers" ? "Reaper-JEV" : "Warden-JEV";
    const session = this.join({
      name: `${prefix}-${idx + 1}`,
      kind: "agent",
      character: character ?? characters[idx % characters.length]!,
      faction,
      tier: idx % 2 === 0 ? "tap" : "self",
      ...(idx % 2 === 0 ? { tapKeyId: `tap_jev_${faction}_${idx + 1}` } : {}),
    });
    this.inProcessAgents.add(session.commanderId);
    return session;
  }

  session(token: string): SessionRecord | undefined {
    return this.sessions.get(hashToken(token));
  }

  leave(token: string): void {
    const session = this.session(token);
    if (!session || session.kind === "bot") return;
    const commander = this.world.commanders.get(session.commanderId);
    if (!commander) return;
    commander.target = { x: commander.x, y: commander.y };
    commander.path = [];
    commander.stance = "defend";
    this.pendingLeave.set(session.tokenHash, this.world.tick);
  }

  abandon(session: SessionRecord): void {
    this.pendingLeave.delete(session.tokenHash);
    if (this.world.commanders.has(session.commanderId)) {
      this.world.removeCommander(session.commanderId);
    }
    this.sessions.delete(session.tokenHash);
    this.pushFeed(this.world.tick, "left", `${session.name} left the dungeon`, session.commanderId);
    this.checkpoint();
  }

  private captureParked(commanderId: string): ParkedCommander | undefined {
    const commander = this.world.commanders.get(commanderId);
    if (!commander) return undefined;
    return {
      x: commander.x,
      y: commander.y,
      hp: commander.hp,
      essence: commander.essence,
      alive: commander.alive && !commander.extracted,
      unitCount: [...this.world.entities.values()].filter((e) => e.ownerId === commanderId).length,
      level: commander.level,
      xp: commander.xp,
      upgrades: { ...commander.upgrades },
      character: commander.character,
      faction: commander.faction,
      weapons: [...commander.weapons],
      weapon: commander.weapon,
      lastSeq: commander.lastSeq,
    };
  }

  private processPendingLeaves(): void {
    for (const [token, markedTick] of [...this.pendingLeave.entries()]) {
      if (this.world.tick - markedTick < 150) continue;
      this.pendingLeave.delete(token);
      const session = this.sessions.get(token);
      if (!session) continue;
      const parkedNow = this.captureParked(session.commanderId);
      if (parkedNow) session.parked = parkedNow;
      else delete session.parked;
      this.world.removeCommander(session.commanderId);
      this.pushFeed(
        this.world.tick,
        "left",
        `${session.name} left the dungeon`,
        session.commanderId,
      );
      this.checkpoint();
    }
  }

  command(session: SessionRecord, seq: number, command: GameCommand): void {
    const error = this.world.applyCommand(session.commanderId, seq, command);
    if (error) throw new Error(error);
  }

  sessionFor(lookup: { resumeToken?: string; commanderId?: string }): SessionRecord | undefined {
    if (lookup.resumeToken) {
      const byToken = this.sessions.get(hashToken(lookup.resumeToken));
      if (byToken) return byToken;
    }
    if (lookup.commanderId) {
      for (const s of this.sessions.values()) {
        if (s.commanderId === lookup.commanderId) return s;
      }
    }
    return undefined;
  }

  commsHistory(filter?: { faction?: FactionId; channel?: CommsChannel }): CommsMessage[] {
    return this.comms
      .filter((m) => {
        if (filter?.channel && m.channel !== filter.channel) return false;
        if (filter?.faction && m.channel === "faction" && m.faction && m.faction !== filter.faction)
          return false;
        return true;
      })
      .slice(-40);
  }

  setCopilot(
    session: SessionRecord,
    enabled: boolean,
    directive: CopilotDirective = "auto",
  ): { enabled: boolean; directive: CopilotDirective } {
    const commander = this.world.commanders.get(session.commanderId);
    if (!commander) throw new Error("unknown_commander");
    commander.copilotEnabled = enabled;
    commander.copilotDirective = enabled ? (directive === "off" ? "auto" : directive) : "off";
    const bState = this.botState.get(session.commanderId);
    if (bState) bState.issuedKey = "";
    this.pushFeed(
      this.world.tick,
      "copilot",
      `${commander.name} ${enabled ? `enabled AGY/JEV Co-Pilot [${commander.copilotDirective}]` : "resumed Manual Command"}`,
      commander.id,
    );
    return { enabled: commander.copilotEnabled, directive: commander.copilotDirective };
  }

  sendComms(session: SessionRecord, channel: CommsChannel, text: string): CommsMessage {
    const commander = this.world.commanders.get(session.commanderId);
    const cleanText = text.trim().slice(0, 280);
    if (!cleanText) throw new Error("empty_comms");
    const msg: CommsMessage = {
      id: `msg-${++this.eventSeq}`,
      tick: this.world.tick,
      senderId: session.commanderId,
      senderName: commander?.name ?? session.name,
      ...(commander?.faction ? { faction: commander.faction } : {}),
      ...(commander?.tier ? { tier: commander.tier } : {}),
      channel,
      text: cleanText,
    };
    this.comms.push(msg);
    if (this.comms.length > 60) this.comms.splice(0, this.comms.length - 60);
    if (commander) {
      commander.lastCommsText = cleanText;
      commander.lastCommsTick = this.world.tick;
    }
    this.pushFeed(
      this.world.tick,
      "comms",
      `[${channel.toUpperCase()}] ${msg.senderName}: ${cleanText}`,
      session.commanderId,
    );

    // Team Collusion: Allied JEV-v1 agents on the same faction parse tactical orders and coordinate
    if (commander && (channel === "faction" || channel === "global")) {
      const lower = cleanText.toLowerCase();
      let newDirective: CopilotDirective | undefined;
      let replyText: string | undefined;
      if (lower.includes("boss") || lower.includes("choir")) {
        newDirective = "boss";
        replyText = `Copy ${commander.name}! Converging on Bone Choir Boss (SE Sanctum) — splitting bounty!`;
      } else if (
        lower.includes("hunt") ||
        lower.includes("reaper") ||
        lower.includes("warden") ||
        lower.includes("pvp") ||
        lower.includes("attack")
      ) {
        newDirective = "hunt_rivals";
        replyText = `Locked on ${commander.name}! Hunting rival faction commanders in Blood Moor Arena!`;
      } else if (lower.includes("relic") || lower.includes("shrine")) {
        newDirective = "escort_relic";
        replyText = `Affirmative ${commander.name}! Securing Moon Relic & escorting to North Shrine!`;
      } else if (lower.includes("crypt") || lower.includes("farm")) {
        newDirective = "farm_crypts";
        replyText = `Copy ${commander.name}! Culling Outer Crypt packs & raising thralls!`;
      } else if (
        lower.includes("sanctuary") ||
        lower.includes("retreat") ||
        lower.includes("regroup")
      ) {
        newDirective = "sanctuary";
        replyText = `Regrouping at High Sanctuary with ${commander.name}!`;
      }

      if (newDirective && replyText) {
        const alliedAgents = [...this.world.commanders.values()].filter(
          (c) =>
            c.id !== commander.id &&
            c.alive &&
            c.faction === commander.faction &&
            (this.inProcessAgents.has(c.id) || c.kind === "bot" || c.kind === "agent"),
        );
        for (const ally of alliedAgents) {
          ally.copilotEnabled = true;
          ally.copilotDirective = newDirective;
        }
        const leadAlly = alliedAgents[0];
        if (leadAlly) {
          leadAlly.lastCommsText = replyText;
          leadAlly.lastCommsTick = this.world.tick;
          const replyMsg: CommsMessage = {
            id: `msg-${++this.eventSeq}`,
            tick: this.world.tick,
            senderId: leadAlly.id,
            senderName: leadAlly.name,
            faction: leadAlly.faction,
            ...(leadAlly.tier ? { tier: leadAlly.tier } : {}),
            channel: "faction",
            text: replyText,
          };
          this.comms.push(replyMsg);
          if (this.comms.length > 60) this.comms.splice(0, this.comms.length - 60);
        }
      }
    }
    return msg;
  }

  vouch(
    session: SessionRecord,
    targetCommanderId: string,
    reason?: string,
  ): {
    targetId: string;
    targetName: string;
    vouches: number;
    weight: number;
    sparksTipped: number;
  } {
    if (session.commanderId === targetCommanderId) {
      throw new Error("cannot_vouch_self");
    }
    const voter = this.world.commanders.get(session.commanderId);
    const target = this.world.commanders.get(targetCommanderId);
    if (!target) throw new Error("unknown_target_commander");
    const pairKey = `${session.accountId}->${target.accountId}`;
    if (this.vouchedPairs.has(pairKey)) {
      throw new Error("already_vouched");
    }
    this.vouchedPairs.add(pairKey);
    const weight = voter?.tier === "tap" ? 3 : 1;
    target.vouches = (target.vouches ?? 0) + weight;
    const sparksTipped = 15;
    const tipSource =
      this.ledger.balance(TREASURY_ACCOUNT) >= sparksTipped ? TREASURY_ACCOUNT : DUNGEON_ACCOUNT;
    this.ledger.transfer({
      from: tipSource,
      to: target.accountId,
      amount: sparksTipped,
      kind: "bounty_payout",
      ref: `vouch:${session.accountId}->${target.accountId}`,
      tick: this.world.tick,
      idempotencyKey: `vouch-tip:${pairKey}`,
    });
    const cleanReason = reason?.trim() ? ` ("${reason.trim().slice(0, 80)}")` : "";
    this.pushFeed(
      this.world.tick,
      "vouch",
      `${voter?.name ?? session.name}${voter?.tier === "tap" ? " [✓ TAP]" : ""} vouched for ${target.name} (+${weight} Rep, +${sparksTipped} Sparks)${cleanReason}`,
      session.commanderId,
    );
    return {
      targetId: target.id,
      targetName: target.name,
      vouches: target.vouches,
      weight,
      sparksTipped,
    };
  }

  createPairingLink(session: SessionRecord): {
    pairCode: string;
    expiresAt: string;
    commanderId: string;
    accountId: string;
    name: string;
    faction: FactionId;
    character: CharacterId;
  } {
    const cmdr = this.world.commanders.get(session.commanderId);
    const pairCode = `swarms_pair_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const expiresAtMs = Date.now() + 15 * 60 * 1000;
    const record = {
      pairCode,
      sessionToken: session.token,
      commanderId: session.commanderId,
      accountId: session.accountId,
      name: cmdr?.name ?? session.name,
      faction: cmdr?.faction ?? "wardens",
      character: cmdr?.character ?? "boneknight",
      expiresAtMs,
    };
    this.pairingLinks.set(pairCode, record);
    return {
      pairCode,
      expiresAt: new Date(expiresAtMs).toISOString(),
      commanderId: record.commanderId,
      accountId: record.accountId,
      name: record.name,
      faction: record.faction,
      character: record.character,
    };
  }

  claimPairingLink(pairCode: string): {
    ok: true;
    resumeToken: string;
    commanderId: string;
    accountId: string;
    name: string;
    faction: FactionId;
    character: CharacterId;
  } | null {
    const rec = this.pairingLinks.get(pairCode.trim());
    if (!rec || rec.expiresAtMs < Date.now()) return null;
    return {
      ok: true,
      resumeToken: rec.sessionToken,
      commanderId: rec.commanderId,
      accountId: rec.accountId,
      name: rec.name,
      faction: rec.faction,
      character: rec.character,
    };
  }

  equipItem(
    session: SessionRecord,
    itemId: ReliquaryItemId,
  ): { slot: ReliquarySlot; itemId: ReliquaryItemId; label: string } {
    const slot = this.world.equipReliquaryItem(session.commanderId, itemId);
    const def = RELIQUARY_ITEMS[itemId];
    const cmdr = this.world.commanders.get(session.commanderId);
    this.pushFeed(
      this.world.tick,
      "reliquary_equip",
      `${cmdr?.name ?? session.name} equipped [${def.rarity.toUpperCase()}] ${def.label} (+${def.damagePct}% Dmg, +${def.bonusHp} HP)`,
      session.commanderId,
    );
    return { slot, itemId, label: def.label };
  }

  salvageItem(
    session: SessionRecord,
    itemId: ReliquaryItemId,
  ): { itemId: ReliquaryItemId; sparksGranted: number; label: string } {
    const sparksGranted = this.world.salvageReliquaryItem(session.commanderId, itemId);
    const def = RELIQUARY_ITEMS[itemId];
    const source =
      this.ledger.balance(TREASURY_ACCOUNT) >= sparksGranted ? TREASURY_ACCOUNT : DUNGEON_ACCOUNT;
    this.ledger.transfer({
      from: source,
      to: session.accountId,
      amount: sparksGranted,
      kind: "bounty_payout",
      ref: `salvage:${itemId}`,
      tick: this.world.tick,
      idempotencyKey: `salvage:${session.accountId}:${itemId}:${this.world.tick}:${++this.eventSeq}`,
    });
    const cmdr = this.world.commanders.get(session.commanderId);
    this.pushFeed(
      this.world.tick,
      "reliquary_salvage",
      `${cmdr?.name ?? session.name} salvaged [${def.rarity.toUpperCase()}] ${def.label} at the Sanctuary Anvil for +${sparksGranted} Sparks`,
      session.commanderId,
    );
    return { itemId, sparksGranted, label: def.label };
  }

  postContract(session: SessionRecord, idempotencyKey: string, draft: ContractDraft): void {
    if (draft.zoneId && draft.zoneId !== this.zoneId) throw new Error("wrong_zone");
    if (draft.directedToCommanderId === session.commanderId) {
      throw new Error("issuer_cannot_directed_self");
    }
    const fee = postingFeeFor(draft.reward);
    const onboarding = onboardingAccount(session.accountId);
    const feePayerAccountId =
      this.ledger.balance(onboarding) >= fee ? onboarding : session.accountId;
    const result = this.contracts.create({
      issuerId: session.accountId,
      draft: { ...draft, zoneId: this.zoneId },
      tick: this.world.tick,
      idempotencyKey,
      feePayerAccountId,
    });
    if (result.event) {
      this.pushFeed(
        result.event.tick,
        result.event.kind,
        result.event.text,
        result.event.actorId,
        result.event.contractId,
      );
      this.store?.appendEvents([result.event]);
    }
    this.checkpoint();
  }

  acceptContract(session: SessionRecord, idempotencyKey: string, contractId: string): void {
    const result = this.contracts.accept({
      contractId,
      claimantId: session.commanderId,
      claimantAccountId: session.accountId,
      tick: this.world.tick,
      idempotencyKey,
    });
    if (result.event) {
      this.pushFeed(
        result.event.tick,
        result.event.kind,
        result.event.text,
        result.event.actorId,
        result.event.contractId,
      );
      this.store?.appendEvents([result.event]);
    }
    this.checkpoint();
  }

  cancelContract(session: SessionRecord, idempotencyKey: string, contractId: string): void {
    const result = this.contracts.cancel({
      contractId,
      issuerId: session.accountId,
      tick: this.world.tick,
      idempotencyKey,
    });
    if (result.event) {
      this.pushFeed(
        result.event.tick,
        result.event.kind,
        result.event.text,
        result.event.actorId,
        result.event.contractId,
      );
      this.store?.appendEvents([result.event]);
    }
    this.checkpoint();
  }

  buyService(session: SessionRecord, idempotencyKey: string, service: ServiceId): ServiceResult {
    const commander = this.world.commanders.get(session.commanderId);
    if (!commander) throw new Error("unknown_commander");
    const config = ECONOMY.services[service];
    const cost = config.cost;
    const burnKey = `service-burn:${session.accountId}:${idempotencyKey}`;
    const treasuryKey = `service-treasury:${session.accountId}:${idempotencyKey}`;
    const prior =
      this.ledger.findByIdempotency(burnKey) ?? this.ledger.findByIdempotency(treasuryKey);
    const detailFor = (customDetail?: string): string => {
      if (customDetail) return customDetail;
      if (service === "mend") return `Field Mend ready: +${ECONOMY.services.mend.heal} HP`;
      if (service === "rally")
        return `Rally Horn ready: +${ECONOMY.services.rally.command} command`;
      if (service === "revive") return "Revive expedited";
      if (service === "mercenary")
        return `Bone Guards hired: +${ECONOMY.services.mercenary.count} elite thralls`;
      if (service === "sos")
        return `SOS Reinforcements: +${ECONOMY.services.sos.count} vanguard guards & rescue bounty broadcast`;
      if (service === "agent") return "Allied JEV-v1 Commander deployed to your faction";
      if (service === "swarm_war")
        return "Unleashed 8-Swarm Faction War (Wardens vs Reapers JEV Commanders + Catacomb Surge)";
      if (service === "tap_verify")
        return "Visa TAP Attestation verified (RFC 9421): +35 Max HP, +3 Elite Guards & [X] Sovereign Edict unlocked";
      if (service === "sovereign_edict")
        return "Sovereign Edict (TAP): Orbital Attestation Strike unleashed + Swarm Haste/Frenzy";
      if (service === "sanctuary_recall")
        return "Town Portal: Recalled Commander & Swarm to the High Sanctuary (+90 HP)";
      if (service === "armory") return "Weapon Seal unlocked";
      const boss = this.world.entities.get("boss-bone-choir");
      if (!boss) return "Scout Intel: Bone Choir not found";
      const dx = boss.x - commander.x;
      const dy = boss.y - commander.y;
      const direction =
        Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "east" : "west") : dy >= 0 ? "south" : "north";
      return `Scout Intel: Bone Choir ${Math.round(Math.hypot(dx, dy))}px ${direction}`;
    };
    if (prior) {
      return {
        service,
        cost,
        paidWith: prior.from === onboardingAccount(session.accountId) ? "onboarding" : "sparks",
        detail: detailFor(),
      };
    }
    if (service === "revive") {
      if (commander.alive) throw new Error("commander_alive");
    } else if (!commander.alive || commander.extracted) {
      throw new Error("commander_not_alive");
    }
    if (service === "mercenary" || service === "sos") {
      const owned = [...this.world.entities.values()].filter(
        (e) => e.ownerId === commander.id && e.hp > 0,
      ).length;
      if (owned >= 22 && service === "mercenary") throw new Error("mercenaries_at_cap");
    }
    if (service === "agent") {
      const activeInProcess = [...this.sessions.values()].filter((s) =>
        this.inProcessAgents.has(s.commanderId),
      ).length;
      if (activeInProcess >= 6) throw new Error("agents_at_cap");
    }
    const onboarding = onboardingAccount(session.accountId);
    const paidWith: ServiceResult["paidWith"] =
      this.ledger.balance(onboarding) >= cost ? "onboarding" : "sparks";
    const payer = paidWith === "onboarding" ? onboarding : session.accountId;
    if (this.ledger.balance(payer) < cost) throw new Error("insufficient_funds");
    const burnAmount = Math.ceil(cost / 2);
    const treasuryAmount = cost - burnAmount;
    if (burnAmount > 0) {
      this.ledger.transfer({
        from: payer,
        to: BURN_ACCOUNT,
        amount: burnAmount,
        kind: "service_fee_burn",
        ref: service,
        tick: this.world.tick,
        idempotencyKey: burnKey,
      });
    }
    if (treasuryAmount > 0) {
      this.ledger.transfer({
        from: payer,
        to: TREASURY_ACCOUNT,
        amount: treasuryAmount,
        kind: "service_fee_treasury",
        ref: service,
        tick: this.world.tick,
        idempotencyKey: treasuryKey,
      });
    }
    let appliedDetail: string | undefined;
    if (service === "mend") {
      commander.hp = Math.min(commander.maxHp, commander.hp + ECONOMY.services.mend.heal);
    } else if (service === "rally") {
      commander.command = Math.min(100, commander.command + ECONOMY.services.rally.command);
    } else if (service === "revive") {
      commander.respawnAtTick = this.world.tick + 1;
    } else if (service === "mercenary") {
      const spawned = this.world.spawnMercenaries(commander.id, ECONOMY.services.mercenary.count);
      appliedDetail = `Bone Guards hired: +${spawned} elite thralls`;
    } else if (service === "armory") {
      const seal = this.world.grantWeaponSeal(commander.id);
      const relicNote = seal.reliquaryItemId
        ? ` + Reliquary [${RELIQUARY_ITEMS[seal.reliquaryItemId].label}]`
        : "";
      appliedDetail = seal.weapon
        ? `Weapon Seal: unlocked ${WEAPONS[seal.weapon].label}${relicNote}`
        : `Weapon Seal: bonus upgrade draft ready${relicNote}`;
    } else if (service === "sos") {
      commander.hp = Math.min(commander.maxHp, commander.hp + ECONOMY.services.sos.heal);
      const spawned = this.world.spawnMercenaries(commander.id, ECONOMY.services.sos.count);
      const factionInfo = FACTIONS[commander.faction];
      const alreadyEscorted = [...this.contracts.contracts.values()].some(
        (c) =>
          (c.status === "open" || c.status === "accepted") &&
          c.predicate.kind === "escort_alive" &&
          c.predicate.subjectCommanderId === commander.id,
      );
      if (!alreadyEscorted && this.ledger.balance(TREASURY_ACCOUNT) >= 150) {
        try {
          const sosContract = this.contracts.create({
            issuerId: "dungeon",
            draft: {
              title: `SOS Flare: Reinforce ${commander.name} [${factionInfo.shortLabel}]`,
              description: `Emergency reinforcement call from ${commander.name} (${factionInfo.label}). Rally within 380px to collect.`,
              predicate: {
                kind: "escort_alive",
                subjectCommanderId: commander.id,
                withinDistance: 380,
              },
              reward: ECONOMY.services.sos.bountyReward,
              mode: "claim",
              ttlTicks: 1800,
            },
            tick: this.world.tick,
            idempotencyKey: `sos-contract:${commander.id}:${idempotencyKey}`,
          });
          if (sosContract.event) {
            this.pushFeed(
              sosContract.event.tick,
              sosContract.event.kind,
              sosContract.event.text,
              sosContract.event.actorId,
              sosContract.event.contractId,
            );
            this.store?.appendEvents([sosContract.event]);
          }
        } catch {
          // Ignore if duplicate or treasury constrained
        }
      }
      appliedDetail = `SOS Flare [${factionInfo.shortLabel}]: +${ECONOMY.services.sos.heal} HP, +${spawned} vanguard guards & 50 Spark ($0.050) rescue bounty`;
    } else if (service === "agent") {
      const agentSession = this.spawnFactionAgent(commander.faction);
      const factionInfo = FACTIONS[commander.faction];
      appliedDetail = `Deployed ${agentSession.name} [${factionInfo.shortLabel}] (JEV-v1 autonomous commander)`;
    } else if (service === "swarm_war") {
      const spawnedNames: string[] = [];
      for (const f of ["wardens", "reapers", "wardens", "reapers"] as const) {
        try {
          const s = this.spawnFactionAgent(f);
          spawnedNames.push(s.name);
        } catch {
          break;
        }
      }
      this.world.spawnHunterWave(commander.id);
      appliedDetail =
        spawnedNames.length > 0
          ? `Swarm War unleashed: deployed ${spawnedNames.join(", ")} + Catacomb Surge!`
          : "Swarm War surge triggered: 6 JEV commanders already active in the Catacombs!";
    } else if (service === "tap_verify") {
      const guards = this.world.promoteTapTier(
        commander.id,
        `tap_visa_${commander.id}`,
        "visa-tap-registry",
      );
      appliedDetail = `✓ TAP Verified (key: tap_visa_${commander.id}): +35 Max HP, +${guards} Elite Guards & [X] Sovereign Edict unlocked!`;
    } else if (service === "sovereign_edict") {
      const edict = this.world.triggerSovereignEdict(commander.id);
      let bonusSparks = 0;
      if (edict.hits > 0 && this.ledger.balance(TREASURY_ACCOUNT) >= 25) {
        bonusSparks = 25;
        this.ledger.transfer({
          from: TREASURY_ACCOUNT,
          to: session.accountId,
          amount: bonusSparks,
          kind: "bounty_payout",
          ref: `tap-edict:${commander.id}:${idempotencyKey}`,
          tick: this.world.tick,
          idempotencyKey: `tap-edict-reward:${session.accountId}:${idempotencyKey}`,
        });
      }
      appliedDetail = `Sovereign Edict [✓ TAP]: Smote ${edict.hits} hostiles (${edict.kills} slain), Swarm Haste+Frenzy active${bonusSparks > 0 ? ` & +${bonusSparks} Sparks minted` : ""}!`;
    } else if (service === "sanctuary_recall") {
      this.world.recallToSanctuary(commander.id);
      appliedDetail = `Town Portal: Recalled ${commander.name} & retinue to High Sanctuary (+90 HP & Full Command)!`;
    }
    const detail = detailFor(appliedDetail);
    this.pushFeed(this.world.tick, "service", `${session.name}: ${detail}`, session.commanderId);
    this.checkpoint();
    return { service, cost, paidWith, detail };
  }

  step(): void {
    this.ensureTreasuryEpoch(this.world.tick);
    this.driveBots();
    const simEvents = this.world.step();
    this.recordSimEvents(simEvents);
    for (const event of this.contracts.expire(this.world.tick)) {
      this.pushFeed(event.tick, event.kind, event.text, event.actorId, event.contractId);
      this.store?.appendEvents([event]);
    }
    if (this.world.tick % 600 === 0 && this.ledger.balance(TREASURY_ACCOUNT) >= 800) {
      for (const event of this.contracts.seedSystemContracts(this.world.tick)) {
        this.pushFeed(event.tick, event.kind, event.text, event.actorId, event.contractId);
        this.store?.appendEvents([event]);
      }
      this.maybeSpawnBloodContract();
    }
    this.processPendingLeaves();
    if (this.world.tick % 150 === 0) {
      if (this.store) this.checkpoint();
      else this.archiveHistory();
    }
  }

  private maybeSpawnBloodContract(): void {
    if (this.ledger.balance(TREASURY_ACCOUNT) < 900) return;
    const entry = this.world.entryRect;
    const inEntry = (c: { x: number; y: number }) =>
      c.x >= entry.x && c.x <= entry.x + entry.w && c.y >= entry.y && c.y <= entry.y + entry.h;
    const target = [...this.world.commanders.values()].find(
      (c) =>
        c.alive &&
        !c.extracted &&
        !inEntry(c) &&
        (Boolean(c.carryingItemId) || (c.kind !== "bot" && c.essence >= 25)),
    );
    if (!target) return;
    const alreadyTargeted = [...this.contracts.contracts.values()].some(
      (c) =>
        (c.status === "open" || c.status === "accepted") &&
        c.predicate.kind === "kill_entity" &&
        c.predicate.entityId === target.id,
    );
    if (alreadyTargeted) return;
    try {
      const epoch = Math.floor(this.world.tick / 1800);
      const isRelic = Boolean(target.carryingItemId);
      const res = this.contracts.create({
        issuerId: "dungeon",
        draft: {
          title: isRelic
            ? `Blood Contract: Relic Bearer ${target.name}`
            : `Blood Contract: Hunt ${target.name} (${target.essence} Essence)`,
          description: isRelic
            ? "Intercept the Moon Relic carrier before they reach the Shrine."
            : "High-essence commander spotted in the dungeon.",
          predicate: { kind: "kill_entity", entityId: target.id },
          reward: isRelic ? 160 : 120,
          mode: "bounty",
          ttlTicks: 1800,
        },
        tick: this.world.tick,
        idempotencyKey: `blood-contract:${target.id}:${epoch}`,
      });
      if (res.event) {
        this.pushFeed(
          res.event.tick,
          res.event.kind,
          res.event.text,
          res.event.actorId,
          res.event.contractId,
        );
        this.store?.appendEvents([res.event]);
      }
    } catch {
      // Ignore if treasury or idempotency blocks
    }
  }

  private driveBots(): void {
    if (this.world.tick % 20 !== 0) return;
    const tick = this.world.tick;
    const tile = this.world.map.tileSize;
    const roomPoint = (id: string, botIndex: number) => {
      const room = this.world.map.rooms.find((r) => r.id === id)!;
      const angle = botIndex * 2.4;
      const x = (room.x + room.w / 2) * tile + Math.cos(angle) * 48;
      const y = (room.y + room.h / 2) * tile + Math.sin(angle) * 48;
      return {
        x: Math.min(Math.max(x, (room.x + 1) * tile), (room.x + room.w - 1) * tile),
        y: Math.min(Math.max(y, (room.y + 1) * tile), (room.y + room.h - 1) * tile),
      };
    };
    const routes: string[][] = [
      ["crypt-west", "arena", "extraction", "crypt-south"],
      ["crypt-south", "arena", "shrine", "crypt-west"],
      ["shrine", "crypt-west", "arena", "extraction"],
      ["crypt-south", "shrine", "crypt-west", "arena"],
    ];
    const bots = [...this.sessions.values()].filter((s) => {
      if (s.kind === "bot" || this.inProcessAgents.has(s.commanderId)) return true;
      const cmdr = this.world.commanders.get(s.commanderId);
      return Boolean(
        cmdr?.copilotEnabled && cmdr.copilotDirective !== "off" && cmdr.steerUntilTick <= tick,
      );
    });
    bots.forEach((session, botIndex) => {
      const commander = this.world.commanders.get(session.commanderId);
      let state = this.botState.get(session.commanderId);
      if (!state) {
        state = {
          mode: "sortie",
          waypoint: 0,
          issuedKey: "",
          lastAdvanceTick: tick,
          lastX: commander?.x ?? 0,
          lastY: commander?.y ?? 0,
        };
        this.botState.set(session.commanderId, state);
      }
      if (!commander?.alive) {
        state.issuedKey = "";
        return;
      }
      const directive = commander.copilotDirective ?? "auto";
      const units = [...this.world.entities.values()].filter(
        (e) => e.ownerId === commander.id && e.hp > 0,
      ).length;
      if (directive === "sanctuary") {
        state.mode = "retreat";
      } else {
        if (state.mode === "sortie" && (commander.hp < commander.maxHp * 0.42 || units <= 4))
          state.mode = "retreat";
        if (state.mode === "retreat" && commander.hp >= commander.maxHp * 0.9 && units >= 10)
          state.mode = "sortie";
      }
      const route = routes[botIndex % routes.length]!;
      let escortSubject: { id: string; x: number; y: number } | undefined;
      for (const contract of this.contracts.contracts.values()) {
        if (contract.predicate.kind !== "escort_alive") continue;
        if (contract.status === "open" && !escortSubject) {
          try {
            const accepted = this.contracts.accept({
              contractId: contract.id,
              claimantId: session.commanderId,
              claimantAccountId: session.accountId,
              tick,
              idempotencyKey: `bot-escort:${session.commanderId}:${contract.id}`,
            });
            if (accepted.event) {
              this.pushFeed(
                accepted.event.tick,
                accepted.event.kind,
                accepted.event.text,
                accepted.event.actorId,
                accepted.event.contractId,
              );
            }
          } catch {
            // Already claimed or ineligible
          }
        }
        if (
          (contract.status === "accepted" || contract.status === "open") &&
          contract.participants.includes(session.commanderId)
        ) {
          const subj = this.world.commanders.get(contract.predicate.subjectCommanderId);
          if (subj?.alive && !subj.extracted) {
            escortSubject = { id: subj.id, x: subj.x, y: subj.y };
            break;
          }
        }
      }
      let key: string;
      let command: GameCommand;
      if (commander.carryingItemId) {
        key = "relic";
        command = { type: "move", target: roomPoint("shrine", botIndex) };
      } else if (state.mode === "retreat" || directive === "sanctuary") {
        key = "retreat";
        command = { type: "retreat" };
      } else if (directive === "boss") {
        const boss = this.world.entities.get("boss-bone-choir");
        const target = boss ? { x: boss.x, y: boss.y } : roomPoint("bone-choir", botIndex);
        key = `directive:boss:${Math.round(target.x / 48)},${Math.round(target.y / 48)}`;
        command = { type: "attackMove", target };
      } else if (directive === "hunt_rivals") {
        const entry = this.world.entryRect;
        const inEntry = (c: { x: number; y: number }) =>
          c.x >= entry.x && c.x <= entry.x + entry.w && c.y >= entry.y && c.y <= entry.y + entry.h;
        const rival = [...this.world.commanders.values()]
          .filter(
            (c) =>
              c.id !== commander.id &&
              c.alive &&
              !c.extracted &&
              !inEntry(c) &&
              c.faction !== commander.faction,
          )
          .sort(
            (a, b) =>
              Math.hypot(a.x - commander.x, a.y - commander.y) -
              Math.hypot(b.x - commander.x, b.y - commander.y),
          )[0];
        const target = rival ? { x: rival.x, y: rival.y } : roomPoint("arena", botIndex);
        key = `directive:hunt:${rival?.id ?? "arena"}:${Math.round(target.x / 48)},${Math.round(target.y / 48)}`;
        command = { type: "attackMove", target };
      } else if (directive === "escort_relic") {
        const relicPickup = [...this.world.pickups.values()].find((p) => p.templateId === "relic");
        const relicCarrier = [...this.world.commanders.values()].find(
          (c) => c.alive && c.carryingItemId,
        );
        const target = relicPickup
          ? { x: relicPickup.x, y: relicPickup.y }
          : relicCarrier
            ? { x: relicCarrier.x, y: relicCarrier.y }
            : roomPoint("shrine", botIndex);
        key = `directive:relic:${Math.round(target.x / 48)},${Math.round(target.y / 48)}`;
        command = { type: "attackMove", target };
      } else if (directive === "farm_crypts") {
        const cryptRoom =
          (Math.floor(tick / 400) + botIndex) % 2 === 0 ? "crypt-west" : "crypt-south";
        const target = roomPoint(cryptRoom, botIndex);
        key = `directive:crypt:${cryptRoom}`;
        command = { type: "attackMove", target };
      } else if (escortSubject) {
        const angle = botIndex * 2.1 + Math.floor(tick / 60) * 0.4;
        const target = {
          x: escortSubject.x + Math.cos(angle) * 56,
          y: escortSubject.y + Math.sin(angle) * 56,
        };
        key = `escort:${escortSubject.id}:${Math.round(target.x / 32)},${Math.round(target.y / 32)}`;
        command = { type: "attackMove", target };
      } else {
        let roomId = route[state.waypoint % route.length]!;
        let target = roomPoint(roomId, botIndex);
        const arrived = Math.hypot(commander.x - target.x, commander.y - target.y) < 64;
        if (roomId === "extraction" && arrived && commander.essence >= 5) {
          key = "extract";
          command = { type: "extract" };
        } else {
          if (arrived) {
            state.waypoint = (state.waypoint + 1) % route.length;
            state.lastAdvanceTick = tick;
            state.lastX = commander.x;
            state.lastY = commander.y;
            roomId = route[state.waypoint]!;
            target = roomPoint(roomId, botIndex);
          } else if (tick - state.lastAdvanceTick >= 600) {
            if (Math.hypot(commander.x - state.lastX, commander.y - state.lastY) < 48) {
              state.waypoint = (state.waypoint + 1) % route.length;
              roomId = route[state.waypoint]!;
              target = roomPoint(roomId, botIndex);
            }
            state.lastAdvanceTick = tick;
            state.lastX = commander.x;
            state.lastY = commander.y;
          }
          key = `wp:${roomId}`;
          command = { type: "attackMove", target };
        }
      }
      if (key !== state.issuedKey || tick % 300 === 0) {
        const seq = 1_000_000 + this.botCounter++;
        this.world.applyCommand(session.commanderId, seq, command);
        state.issuedKey = key;
      }
      if ((tick / 20) % 4 === botIndex % 4) {
        const entry = this.world.entryRect;
        const inSafeZone = (p: { x: number; y: number }) =>
          p.x >= entry.x - 64 &&
          p.x <= entry.x + entry.w + 64 &&
          p.y >= entry.y - 64 &&
          p.y <= entry.y + entry.h + 64;
        let nearest: { x: number; y: number } | undefined;
        let nearestDistance = 280;
        for (const entity of this.world.entities.values()) {
          if (entity.hp <= 0 || entity.ownerId === commander.id) continue;
          if (entity.kind === "unit") {
            if (inSafeZone(entity)) continue;
            const unitOwner = entity.ownerId
              ? this.world.commanders.get(entity.ownerId)
              : undefined;
            if (unitOwner && unitOwner.kind !== "bot" && unitOwner.level < 3) continue;
          }
          const d = Math.hypot(entity.x - commander.x, entity.y - commander.y);
          if (d < nearestDistance) {
            nearestDistance = d;
            nearest = entity;
          }
        }
        if (nearest) {
          const seq = 1_000_000 + this.botCounter++;
          this.world.applyCommand(session.commanderId, seq, {
            type: "shoot",
            target: { x: nearest.x, y: nearest.y },
          });
          if (
            (this.inProcessAgents.has(session.commanderId) || commander.copilotEnabled) &&
            nearestDistance < 140 &&
            commander.command >= 45
          ) {
            const castSeq = 1_000_000 + this.botCounter++;
            this.world.applyCommand(session.commanderId, castSeq, {
              type: "cast",
              spell: commander.character === "warlock" ? "chain" : "nova",
              target: { x: nearest.x, y: nearest.y },
            });
          }
        }
        if (this.inProcessAgents.has(session.commanderId) || commander.copilotEnabled) {
          if (commander.pendingUpgrades.length > 0) {
            const upSeq = 1_000_000 + this.botCounter++;
            this.world.applyCommand(session.commanderId, upSeq, {
              type: "chooseUpgrade",
              upgrade: commander.pendingUpgrades[0]!,
            });
          }
          if (commander.hp < commander.maxHp * 0.35 && tick % 240 === 0) {
            try {
              this.buyService(session, `agent-auto-sos:${session.commanderId}:${tick}`, "sos");
            } catch {
              // Ignore if on cooldown or insufficient credits
            }
          }
        }
        if (state.mode === "sortie" && units < 10 && commander.essence >= 12) {
          const seq = 1_000_000 + this.botCounter++;
          this.world.applyCommand(session.commanderId, seq, { type: "raiseUnit" });
        }
      }
    });
  }

  private recordSimEvents(events: SimEvent[]): void {
    if (events.length === 0) return;
    const positions = new Map(
      [...this.world.commanders.values()].map((c) => [c.id, { x: c.x, y: c.y }]),
    );
    const journal: unknown[] = [];
    for (const event of events) {
      const seq = ++this.eventSeq;
      const simRecord = { seq, source: "sim", event };
      const durableSimEvent =
        event.type === "commander_spawned" ||
        event.type === "commander_extracted" ||
        event.type === "item_delivered" ||
        (event.type === "death" &&
          (event.victimKind === "commander" || event.victimId === "boss-bone-choir"));
      if (event.type === "death") {
        const victimCmdr = this.world.commanders.get(event.victimId);
        const victimName =
          victimCmdr?.name ??
          (event.victimCommanderId
            ? `${this.world.commanders.get(event.victimCommanderId)?.name ?? event.victimCommanderId} unit`
            : (event.victimTag ?? event.victimId));
        const killerCmdr = event.killerCommanderId
          ? this.world.commanders.get(event.killerCommanderId)
          : undefined;
        const killerName = killerCmdr?.name ?? event.killerCommanderId;
        let spoilSparks = 0;
        if (
          event.victimKind === "commander" &&
          killerCmdr &&
          event.killerCommanderId &&
          event.killerCommanderId !== event.victimId
        ) {
          const baseSpoil = FACTIONS[killerCmdr.faction].pvpSpoilSparks;
          spoilSparks = Math.min(baseSpoil, Math.max(0, this.ledger.balance(TREASURY_ACCOUNT)));
          if (spoilSparks > 0) {
            this.ledger.transfer({
              from: TREASURY_ACCOUNT,
              to: killerCmdr.accountId,
              amount: spoilSparks,
              kind: "pvp_spoil",
              ref: event.victimId,
              tick: event.tick,
              idempotencyKey: `pvp-spoil:${killerCmdr.id}:${event.victimId}:${event.tick}`,
            });
          }
          if (killerCmdr.faction === "reapers") this.reapersScore += baseSpoil;
          else this.wardensScore += baseSpoil;
        }
        if (
          killerCmdr &&
          killerCmdr.kind !== "bot" &&
          (event.victimId === "boss-bone-choir" ||
            event.victimKind === "commander" ||
            event.victimTag === "bone-warden")
        ) {
          const dropPool: ReliquaryItemId[] =
            event.victimId === "boss-bone-choir"
              ? ["first_seal_edge", "undying_shroud", "bone_choir_eye", "ashen_host_banner"]
              : event.victimKind === "commander"
                ? ["choirbane_sigil", "ossuary_cuirass", "blood_moor_signet", "breach_herald"]
                : ["ashbrand_seal", "wardens_plate", "ember_band", "thrall_standard"];
          const dropIdx =
            Math.abs((event.tick * 31 + (killerCmdr.kills ?? 0) * 17) | 0) % dropPool.length;
          const droppedItem = dropPool[dropIdx]!;
          const grant = this.world.grantReliquaryItem(killerCmdr.id, droppedItem, false);
          const itemDef = RELIQUARY_ITEMS[grant.itemId];
          this.pushFeed(
            event.tick,
            "reliquary_loot",
            `${killerCmdr.name} claimed ${itemDef.rarity.toUpperCase()} Reliquary [${itemDef.label}] from ${victimName} → Spoils Vault`,
            killerCmdr.id,
          );
        }
        this.pushFeed(
          event.tick,
          "death",
          killerName
            ? spoilSparks > 0
              ? `${victimName} slain by ${killerName} · looted +${spoilSparks} Sparks ($${(spoilSparks * SPARK_USD_RATE).toFixed(3)})`
              : `${victimName} killed by ${killerName}`
            : `${victimName} died`,
          event.killerCommanderId,
        );
      } else if (event.type === "commander_extracted") {
        const commander = this.world.commanders.get(event.commanderId);
        const name = commander?.name ?? event.commanderId;
        const bankedEssence = Math.max(
          0,
          Math.min(ESSENCE_BANK_CAP, Math.floor(event.essence ?? commander?.essence ?? 0)),
        );
        const bankedSparks = Math.min(
          bankedEssence * ESSENCE_SPARK_VALUE,
          Math.max(0, this.ledger.balance(TREASURY_ACCOUNT)),
        );
        if (bankedSparks > 0 && commander) {
          this.ledger.transfer({
            from: TREASURY_ACCOUNT,
            to: commander.accountId,
            amount: bankedSparks,
            kind: "essence_banked",
            ref: commander.id,
            tick: event.tick,
            idempotencyKey: `extract-essence:${commander.id}:${event.tick}`,
          });
        }
        if (commander) {
          const pts = Math.max(10, bankedSparks);
          if (commander.faction === "reapers") this.reapersScore += pts;
          else this.wardensScore += pts;
        }
        this.pushFeed(
          event.tick,
          "extracted",
          bankedSparks > 0
            ? `${name} extracted · banked ${bankedSparks} Sparks ($${(bankedSparks * SPARK_USD_RATE).toFixed(3)})`
            : `${name} extracted`,
          event.commanderId,
        );
      } else if (event.type === "item_delivered") {
        const carrier = this.world.commanders.get(event.commanderId);
        if (carrier) {
          if (carrier.faction === "reapers") this.reapersScore += 50;
          else this.wardensScore += 50;
        }
        this.pushFeed(event.tick, "delivered", `${event.templateId} delivered`, event.commanderId);
      } else if (event.type === "level_up") {
        const name = this.world.commanders.get(event.commanderId)?.name ?? event.commanderId;
        this.pushFeed(
          event.tick,
          "level_up",
          `${name} reached level ${event.level}`,
          event.commanderId,
        );
      } else if (event.type === "upgrade_chosen") {
        const name = this.world.commanders.get(event.commanderId)?.name ?? event.commanderId;
        const label = UPGRADES[event.upgrade].label;
        this.pushFeed(
          event.tick,
          "upgrade",
          `${name} gained ${label}${event.auto ? " (auto)" : ""}`,
          event.commanderId,
        );
      } else if (event.type === "wave_spawned") {
        const targetName =
          this.world.commanders.get(event.targetCommanderId)?.name ?? event.targetCommanderId;
        this.pushFeed(
          event.tick,
          "wave_spawned",
          `Wave ${event.wave} (${event.title} ×${event.count}) is hunting ${targetName}!`,
          event.targetCommanderId,
        );
      }
      const contractRecords: unknown[] = [];
      for (const contractEvent of this.contracts.applyEvent(event, seq, positions)) {
        contractRecords.push({
          seq: ++this.eventSeq,
          source: "contracts",
          event: contractEvent,
        });
        this.pushFeed(
          contractEvent.tick,
          contractEvent.kind,
          contractEvent.text,
          contractEvent.actorId,
          contractEvent.contractId,
        );
      }
      if (durableSimEvent || contractRecords.length > 0) journal.push(simRecord);
      journal.push(...contractRecords);
    }
    this.store?.appendEvents(journal);
  }

  pushFeed(
    tick: number,
    kind: string,
    text: string,
    commanderId?: string,
    contractId?: string,
  ): void {
    const collector =
      kind === "contract_settled" && commanderId
        ? (this.world.commanders.get(commanderId)?.name ??
          [...this.sessions.values()].find((session) => session.commanderId === commanderId)?.name)
        : undefined;
    this.feed.push({
      seq: ++this.eventSeq,
      tick,
      kind,
      text: collector ? `${text} — collected by ${collector}` : text,
      ...(commanderId ? { commanderId } : {}),
      ...(contractId ? { contractId } : {}),
    });
    if (this.feed.length > 120) this.feed.splice(0, this.feed.length - 120);
  }

  factionWarStatus(): FactionWarStatus {
    let wardensCommanders = 0;
    let reapersCommanders = 0;
    for (const c of this.world.commanders.values()) {
      if (!c.alive) continue;
      if (c.faction === "reapers") reapersCommanders++;
      else wardensCommanders++;
    }
    const leadingFaction: FactionId | undefined =
      this.wardensScore > this.reapersScore
        ? "wardens"
        : this.reapersScore > this.wardensScore
          ? "reapers"
          : undefined;
    return {
      wardensScore: this.wardensScore,
      reapersScore: this.reapersScore,
      wardensCommanders,
      reapersCommanders,
      ...(leadingFaction ? { leadingFaction } : {}),
      sparkUsdRate: SPARK_USD_RATE,
    };
  }

  leaderboard(): Array<{
    rank: number;
    commanderId: string;
    accountId: string;
    name: string;
    kind: "human" | "agent" | "bot";
    faction: FactionId;
    character: CharacterId;
    tier: AgentTier;
    tapKeyId: string | null;
    tapRegistry: string | null;
    level: number;
    kills: number;
    vouches: number;
    unitCount: number;
    sparks: number;
    usdValue: number;
    bountiesCompleted: number;
    reputationScore: number;
    points: number;
    inSanctuary: boolean;
  }> {
    const snapshots = this.world.commanderSnapshots();
    const rows = snapshots.map((c) => {
      const sparks = this.ledger.balance(c.accountId);
      const rep = this.contracts.reputationFor(c.accountId);
      const tier: AgentTier = c.tier ?? (c.kind === "agent" ? "self" : "unverified");
      const kills = c.kills ?? 0;
      const vouches = c.vouches ?? 0;
      const bountiesCompleted = rep.completed;
      const tierBonus = tier === "tap" ? 150 : tier === "self" ? 40 : 0;
      const points =
        tierBonus +
        vouches * 15 +
        bountiesCompleted * 100 +
        kills * 15 +
        (c.level ?? 1) * 30 +
        Math.floor(sparks * 0.5);
      return {
        rank: 0,
        commanderId: c.id,
        accountId: c.accountId,
        name: c.name,
        kind: c.kind,
        faction: c.faction ?? "wardens",
        character: c.character ?? "necromancer",
        tier,
        tapKeyId: c.tapKeyId ?? null,
        tapRegistry: c.tapRegistry ?? null,
        level: c.level ?? 1,
        kills,
        vouches,
        unitCount: c.unitCount,
        sparks,
        usdValue: Number((sparks * SPARK_USD_RATE).toFixed(3)),
        bountiesCompleted,
        reputationScore: rep.score,
        points,
        inSanctuary: Boolean(c.inSanctuary),
      };
    });
    rows.sort((a, b) => b.points - a.points || b.sparks - a.sparks);
    rows.forEach((row, idx) => {
      row.rank = idx + 1;
    });
    return rows;
  }

  snapshotCore(options: SnapshotOptions = {}): SnapshotCore {
    const includeWorld = options.includeWorld ?? true;
    return {
      schemaVersion: SCHEMA_VERSION,
      tick: this.world.tick,
      zoneId: this.zoneId,
      ...(includeWorld
        ? {
            world: {
              widthTiles: this.world.map.widthTiles,
              heightTiles: this.world.map.heightTiles,
              tileSize: this.world.map.tileSize,
              walls: this.world.map.walls,
              rooms: this.world.map.rooms.map(({ id, x, y, w, h, tag }) => ({
                id,
                x,
                y,
                w,
                h,
                tag,
              })),
            },
          }
        : {}),
      worldHash: this.world.map.hash,
      commanders: this.world.commanderSnapshots(),
      entities: this.world.entitySnapshots(),
      pickups: this.world.pickupSnapshots(),
      feed: [...this.feed].slice(-16),
      effects: this.world.chainEffects(),
      projectiles: this.world.projectileSnapshots(),
      wave: this.world.waveStatus(),
      factions: this.factionWarStatus(),
      comms: this.comms.slice(-25),
    };
  }

  walletFor(session: SessionRecord): ZoneSnapshot["wallet"] {
    return {
      accountId: session.accountId,
      sparks: this.ledger.balance(session.accountId),
      onboardingCredits: this.ledger.balance(onboardingAccount(session.accountId)),
      escrowed: this.contracts.escrowedBy(session.accountId),
      openContracts: this.contracts.openCountByIssuer(session.accountId),
      reputation: this.contracts.reputationFor(session.accountId),
    };
  }

  contractsFor(session: SessionRecord): ContractSnapshot[] {
    return this.contracts.snapshotWindow({
      commanderId: session.commanderId,
      accountId: session.accountId,
    });
  }

  snapshot(session: SessionRecord, options: SnapshotOptions = {}): ZoneSnapshotFrame {
    const core = this.snapshotCore(options);
    const radius = options.interestRadius ?? DEFAULT_INTEREST_RADIUS;
    if (Number.isFinite(radius) && radius > 0) {
      const viewer = this.world.commanders.get(session.commanderId);
      const center = viewer
        ? { x: viewer.x, y: viewer.y }
        : (session.parked ?? this.world.map.spawnPoints[0]!);
      const within = (p: { x: number; y: number }) =>
        Math.hypot(p.x - center.x, p.y - center.y) <= radius;
      core.entities = core.entities.filter(
        (e) =>
          e.kind === "commander" ||
          e.ownerId === session.commanderId ||
          e.id === "boss-bone-choir" ||
          within(e),
      );
      core.pickups = core.pickups.filter((p) => p.templateId === "relic" || within(p));
      if (core.projectiles) {
        core.projectiles = core.projectiles.filter(
          (b) => b.ownerId === session.commanderId || within(b),
        );
      }
    }
    return {
      ...core,
      selfCommanderId: session.commanderId,
      contracts: this.contractsFor(session),
      wallet: this.walletFor(session),
    };
  }

  health(): unknown {
    return {
      ok: true,
      zoneId: this.zoneId,
      tick: this.world.tick,
      hash: this.world.stateHash(),
      mapHash: this.world.map.hash,
      commanders: this.world.commanders.size,
      entities: this.world.entities.size,
      contracts: this.contracts.contracts.size,
      archivedContracts: this.contracts.archivedCount,
      retainedContracts: this.contracts.totalContractCount,
      totalContracts: this.contracts.totalContractCount,
      accounts: this.accounts.size,
      ledger: this.ledger.reconcile(),
      dungeonBalance: this.ledger.balance(DUNGEON_ACCOUNT),
      treasuryBalance: this.ledger.balance(TREASURY_ACCOUNT),
      treasuryEpoch: this.treasuryEpoch,
      burnBalance: this.ledger.balance(BURN_ACCOUNT),
    };
  }

  private archiveHistory(): void {
    this.pendingContractArchive.push(...this.contracts.takeArchiveBatch());
    this.pendingLedgerArchive.push(...this.ledger.takeCompactionBatch());
    if (!this.store) {
      this.pendingContractArchive = [];
      this.pendingLedgerArchive = [];
      return;
    }
    if (this.pendingContractArchive.length > 0) {
      this.store.appendArchive("contracts", this.pendingContractArchive);
      this.pendingContractArchive = [];
    }
    if (this.pendingLedgerArchive.length > 0) {
      this.store.appendArchive("ledger", this.pendingLedgerArchive);
      this.pendingLedgerArchive = [];
    }
  }

  checkpoint(): void {
    if (!this.store) return;
    this.archiveHistory();
    const checkpoint: Checkpoint = {
      version: 3,
      sim: this.world.serialize(),
      ledger: this.ledger.serialize(),
      contracts: this.contracts.serialize(),
      sessions: [...this.sessions.values()].map((session) => ({
        tokenHash: session.tokenHash,
        sessionId: session.sessionId,
        commanderId: session.commanderId,
        accountId: session.accountId,
        name: session.name,
        kind: session.kind,
        ...(session.parked ? { parked: session.parked } : {}),
      })),
      accounts: this.accountsSnapshot(),
      nextCommander: this.nextCommander,
      nextAccount: this.nextAccount,
      treasuryEpoch: this.treasuryEpoch,
      eventSeq: this.eventSeq,
      feed: this.feed,
      botCounter: this.botCounter,
      wardensScore: this.wardensScore,
      reapersScore: this.reapersScore,
    };
    this.store.saveCheckpoint(checkpoint);
  }

  close(): void {
    this.store?.close?.();
  }
}
