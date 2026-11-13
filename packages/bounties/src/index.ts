import type {
  ContractDraft,
  ContractMechanism,
  ContractPayout,
  ContractSnapshot,
  ReputationSnapshot,
  Vec2,
} from "@swarms/protocol";
import { distance } from "@swarms/protocol";

export const DUNGEON_ACCOUNT = "dungeon";
export const TREASURY_ACCOUNT = "treasury";
export const BURN_ACCOUNT = "burn";

export function onboardingAccount(accountId: string): string {
  return `onboarding:${accountId}`;
}

export function postingFeeFor(reward: number): number {
  return Math.min(100, Math.max(1, Math.ceil((reward * 200) / 10_000)));
}

export function referenceRewardFor(predicate: ContractDraft["predicate"]): number {
  switch (predicate.kind) {
    case "kill_count": {
      const perKill = predicate.targetTag === "warden" ? 25 : 13;
      return predicate.count * perKill;
    }
    case "kill_entity":
      return predicate.entityId === "boss-bone-choir" ? 400 : 100;
    case "deliver_item":
      return 250;
    case "escort_alive":
      return 300;
  }
}

export interface LedgerEntry {
  id: string;
  seq: number;
  tick: number;
  from: string;
  to: string;
  amount: number;
  kind: string;
  ref: string;
  idempotencyKey: string;
}

export class Ledger {
  private seq = 0;
  private archivedEntryCount = 0;
  readonly entries: LedgerEntry[] = [];
  readonly balances = new Map<string, number>();
  private byIdempotency = new Map<string, string>();
  private openingBalances = new Map<string, number>();

  ensureAccount(accountId: string, startingSparks: number, tick: number): void {
    if (this.balances.has(accountId)) return;
    this.balances.set(accountId, 0);
    if (startingSparks > 0) {
      this.transfer({
        from: DUNGEON_ACCOUNT,
        to: accountId,
        amount: startingSparks,
        kind: "starting_grant",
        ref: accountId,
        tick,
        idempotencyKey: `starting:${accountId}`,
      });
    }
  }

  balance(accountId: string): number {
    return this.balances.get(accountId) ?? 0;
  }

  private static applyEntry(balances: Map<string, number>, entry: LedgerEntry): void {
    balances.set(entry.from, (balances.get(entry.from) ?? 0) - entry.amount);
    balances.set(entry.to, (balances.get(entry.to) ?? 0) + entry.amount);
  }

  verifyBalances(): boolean {
    const computed = new Map(this.openingBalances);
    for (const entry of this.entries) Ledger.applyEntry(computed, entry);
    const accounts = new Set([...this.balances.keys(), ...computed.keys()]);
    for (const account of accounts) {
      if ((this.balances.get(account) ?? 0) !== (computed.get(account) ?? 0)) return false;
    }
    return true;
  }

  findByIdempotency(idempotencyKey: string): LedgerEntry | undefined {
    const existingId = this.byIdempotency.get(idempotencyKey);
    return existingId ? this.entries.find((entry) => entry.id === existingId) : undefined;
  }

  transfer(input: {
    from: string;
    to: string;
    amount: number;
    kind: string;
    ref: string;
    tick: number;
    idempotencyKey: string;
  }): LedgerEntry {
    const found = this.findByIdempotency(input.idempotencyKey);
    if (found) return found;
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new Error("invalid_amount");
    }
    if (input.from !== DUNGEON_ACCOUNT && this.balance(input.from) < input.amount) {
      throw new Error("insufficient_sparks");
    }
    if (!this.balances.has(input.from)) this.balances.set(input.from, 0);
    if (!this.balances.has(input.to)) this.balances.set(input.to, 0);
    const entry: LedgerEntry = {
      ...input,
      id: `ledger-${++this.seq}`,
      seq: this.seq,
    };
    this.balances.set(input.from, this.balance(input.from) - input.amount);
    this.balances.set(input.to, this.balance(input.to) + input.amount);
    this.entries.push(entry);
    this.byIdempotency.set(input.idempotencyKey, entry.id);
    return entry;
  }

  takeCompactionBatch(maxEntries = 2048): LedgerEntry[] {
    const keep = Math.max(0, Math.floor(maxEntries));
    if (this.entries.length <= keep) return [];
    const removed = this.entries.splice(0, this.entries.length - keep);
    for (const entry of removed) Ledger.applyEntry(this.openingBalances, entry);
    this.archivedEntryCount += removed.length;
    this.byIdempotency = new Map(
      this.entries.map((entry) => [entry.idempotencyKey, entry.id] as const),
    );
    return removed;
  }

  deleteZeroAccount(accountId: string): boolean {
    if (this.balance(accountId) !== 0) return false;
    return this.balances.delete(accountId);
  }

  serialize(): unknown {
    return {
      seq: this.seq,
      archivedEntryCount: this.archivedEntryCount,
      openingThroughSeq: this.archivedEntryCount,
      openingBalances: [...this.openingBalances.entries()].filter(([, balance]) => balance !== 0),
      entries: this.entries,
      balances: [...this.balances.entries()],
    };
  }

  static restore(data: unknown): Ledger {
    const source =
      data && typeof data === "object"
        ? (data as {
            seq?: unknown;
            archivedEntryCount?: unknown;
            openingThroughSeq?: unknown;
            openingBalances?: Array<[unknown, unknown]>;
            entries?: LedgerEntry[];
            balances?: Array<[unknown, unknown]>;
            byIdempotency?: Array<[unknown, unknown]>;
          })
        : {};
    const ledger = new Ledger();
    ledger.seq = Number(source.seq ?? 0);
    ledger.archivedEntryCount = Math.max(0, Math.floor(Number(source.archivedEntryCount ?? 0)));
    const hasOpeningBalances = Array.isArray(source.openingBalances);
    for (const [k, v] of hasOpeningBalances ? source.openingBalances! : []) {
      ledger.openingBalances.set(String(k), Number(v));
    }
    ledger.entries.push(...(Array.isArray(source.entries) ? source.entries : []));
    for (const [k, v] of Array.isArray(source.balances) ? source.balances : []) {
      ledger.balances.set(String(k), Number(v));
    }
    for (const entry of ledger.entries) {
      ledger.byIdempotency.set(entry.idempotencyKey, entry.id);
    }
    for (const [k, v] of Array.isArray(source.byIdempotency) ? source.byIdempotency : []) {
      ledger.byIdempotency.set(String(k), String(v));
    }
    const hasOpeningThroughSeq = source.openingThroughSeq !== undefined;
    const expectedOpeningThroughSeq =
      ledger.entries.length > 0 ? ledger.entries[0]!.seq - 1 : ledger.seq;
    if (hasOpeningThroughSeq && Number(source.openingThroughSeq) !== expectedOpeningThroughSeq) {
      throw new Error("ledger_balance_mismatch");
    }
    if (!hasOpeningBalances || !hasOpeningThroughSeq) {
      ledger.archivedEntryCount = expectedOpeningThroughSeq;
      ledger.openingBalances = new Map(ledger.balances);
      for (const entry of ledger.entries) {
        ledger.openingBalances.set(
          entry.from,
          (ledger.openingBalances.get(entry.from) ?? 0) + entry.amount,
        );
        ledger.openingBalances.set(
          entry.to,
          (ledger.openingBalances.get(entry.to) ?? 0) - entry.amount,
        );
      }
    } else if (!ledger.verifyBalances()) {
      throw new Error("ledger_balance_mismatch");
    }
    return ledger;
  }

  reconcile(): {
    accounts: number;
    entries: number;
    retainedEntries: number;
    archivedEntries: number;
    net: number;
  } {
    let net = 0;
    for (const value of this.balances.values()) net += value;
    return {
      accounts: this.balances.size,
      entries: this.archivedEntryCount + this.entries.length,
      retainedEntries: this.entries.length,
      archivedEntries: this.archivedEntryCount,
      net,
    };
  }
}

export type ContractState = ContractSnapshot;

export interface ContractEngineEvent {
  kind:
    | "contract_opened"
    | "contract_accepted"
    | "contract_settled"
    | "contract_refunded"
    | "contract_lease_released"
    | "contract_cancelled";
  tick: number;
  contractId: string;
  actorId?: string;
  text: string;
  payouts?: ContractPayout[];
}

type SimLikeEvent = {
  type: string;
  tick: number;
  victimId?: string;
  victimTag?: string;
  killerCommanderId?: string;
  commanderId?: string;
  templateId?: string;
  destination?: string;
  targetId?: string;
  amount?: number;
  sourceCommanderId?: string;
};

export interface ContractEngineOptions {
  accountForCommander?: (commanderId: string) => string | undefined;
  treasuryAccount?: string;
  burnAccount?: string;
  systemAccount?: string;
}

interface ReputationRecord {
  accountId: string;
  completed: number;
  settledValue: number;
  uniqueIssuers: string[];
  expiredClaims: number;
}

export interface ContractArchiveOptions {
  keepClosed?: number;
  keepTombstones?: number;
  keepOperations?: number;
  keepCreateOperations?: number;
}

export interface ContractSnapshotWindowOptions {
  commanderId?: string;
  accountId?: string;
  limit?: number;
}

const DEFAULT_HOT_CLOSED_CONTRACTS = 128;
const DEFAULT_TOMBSTONE_CONTRACTS = 512;
const DEFAULT_OPERATION_RECORDS = 2048;
const DEFAULT_CREATE_OPERATION_RECORDS = 4096;

function mechanismFor(contract: ContractState): ContractMechanism {
  return contract.mechanism ?? (contract.mode === "claim" ? "exclusive_lease" : "open_race");
}

function cloneContract(contract: ContractState): ContractSnapshot {
  return {
    ...contract,
    mechanism: mechanismFor(contract),
    attribution:
      contract.attribution ??
      (mechanismFor(contract) === "party_share" ? "damage_share" : "final_blow"),
    bond: contract.bond ?? 0,
    postingFee: contract.postingFee ?? 0,
    referenceReward: contract.referenceReward ?? referenceRewardFor(contract.predicate),
    predicate: { ...contract.predicate },
    participants: [...contract.participants],
    progressByCommander: { ...contract.progressByCommander },
    damageByCommander: { ...(contract.damageByCommander ?? {}) },
    paidOut: contract.paidOut ?? 0,
    payouts: (contract.payouts ?? []).map((payout) => ({ ...payout })),
  };
}

function compactContractForCheckpoint(contract: ContractState, archived = false): ContractState {
  const compact: ContractState = { ...contract };
  const defaultMechanism = contract.mode === "claim" ? "exclusive_lease" : "open_race";
  if (mechanismFor(contract) === defaultMechanism) delete compact.mechanism;
  const defaultAttribution =
    mechanismFor(contract) === "party_share" ? "damage_share" : "final_blow";
  if ((contract.attribution ?? defaultAttribution) === defaultAttribution) {
    delete compact.attribution;
  }
  if ((contract.bond ?? 0) === 0) delete compact.bond;
  if ((contract.postingFee ?? 0) === 0) delete compact.postingFee;
  if (
    (contract.referenceReward ?? referenceRewardFor(contract.predicate)) ===
    referenceRewardFor(contract.predicate)
  ) {
    delete compact.referenceReward;
  }
  if (Object.keys(contract.damageByCommander ?? {}).length === 0) {
    delete compact.damageByCommander;
  }
  if ((contract.paidOut ?? 0) === 0) delete compact.paidOut;
  if ((contract.payouts ?? []).length === 0) delete compact.payouts;
  if (archived) {
    delete compact.payouts;
    delete compact.damageByCommander;
    compact.progressByCommander = {};
  }
  return compact;
}

function isLiveContract(contract: ContractState): boolean {
  return contract.status === "open" || contract.status === "accepted";
}

function contractActivityTick(contract: ContractState): number {
  return contract.closedAtTick ?? contract.opensAtTick;
}

export class ContractEngine {
  readonly contracts = new Map<string, ContractState>();
  readonly archivedContracts = new Map<string, ContractState>();
  private nextContract = 1;
  private operations = new Map<string, string>();
  private reputations = new Map<string, ReputationRecord>();

  constructor(
    readonly ledger: Ledger,
    private readonly options: ContractEngineOptions = {},
  ) {}

  private accountForCommander(commanderId: string): string {
    return this.options.accountForCommander?.(commanderId) ?? commanderId;
  }

  private treasuryAccount(): string {
    return this.options.treasuryAccount ?? TREASURY_ACCOUNT;
  }

  private burnAccount(): string {
    return this.options.burnAccount ?? BURN_ACCOUNT;
  }

  private systemAccount(): string {
    return this.options.systemAccount ?? DUNGEON_ACCOUNT;
  }

  bondAccount(contractId: string): string {
    return `bond:${contractId}`;
  }

  private reputationRecord(accountId: string): ReputationRecord {
    let record = this.reputations.get(accountId);
    if (!record) {
      record = {
        accountId,
        completed: 0,
        settledValue: 0,
        uniqueIssuers: [],
        expiredClaims: 0,
      };
      this.reputations.set(accountId, record);
    }
    return record;
  }

  reputationFor(accountId: string): ReputationSnapshot {
    const record = this.reputations.get(accountId) ?? {
      accountId,
      completed: 0,
      settledValue: 0,
      uniqueIssuers: [],
      expiredClaims: 0,
    };
    const uniqueIssuers = [...new Set(record.uniqueIssuers)];
    return {
      accountId,
      score: Math.max(
        0,
        record.completed * 10 +
          Math.min(50, Math.floor(record.settledValue / 25)) +
          uniqueIssuers.length * 5 -
          record.expiredClaims * 15,
      ),
      completed: record.completed,
      settledValue: record.settledValue,
      uniqueIssuers: uniqueIssuers.length,
      expiredClaims: record.expiredClaims,
    };
  }

  reputationsSnapshot(): ReputationSnapshot[] {
    return [...this.reputations.keys()]
      .map((accountId) => this.reputationFor(accountId))
      .sort((a, b) => b.score - a.score || a.accountId.localeCompare(b.accountId));
  }

  private recordPayoutReputation(
    contract: ContractState,
    payout: ContractPayout,
    completedContract: boolean,
  ): void {
    if (payout.accountId === this.systemAccount() || payout.accountId === DUNGEON_ACCOUNT) return;
    const record = this.reputationRecord(payout.accountId);
    record.settledValue += payout.amount;
    if (completedContract) record.completed++;
    if (
      contract.issuerId !== payout.accountId &&
      !record.uniqueIssuers.includes(contract.issuerId)
    ) {
      record.uniqueIssuers.push(contract.issuerId);
    }
  }

  get archivedCount(): number {
    return this.archivedContracts.size;
  }

  get totalContractCount(): number {
    return this.contracts.size + this.archivedContracts.size;
  }

  private findContract(contractId: string): ContractState | undefined {
    return this.contracts.get(contractId) ?? this.archivedContracts.get(contractId);
  }

  escrowAccount(contractId: string): string {
    return `escrow:${contractId}`;
  }

  create(input: {
    issuerId: string;
    draft: ContractDraft;
    tick: number;
    idempotencyKey: string;
    feePayerAccountId?: string;
  }): {
    contract: ContractState;
    event?: ContractEngineEvent;
  } {
    const operationKey = `create:${input.issuerId}:${input.idempotencyKey}`;
    const legacyOperationKey = `create:${input.idempotencyKey}`;
    const existingId = this.operations.get(operationKey) ?? this.operations.get(legacyOperationKey);
    if (existingId) {
      const existing = this.findContract(existingId);
      if (!existing) throw new Error("contract_operation_expired");
      this.operations.set(operationKey, existing.id);
      return { contract: existing };
    }
    const escrowKey = `escrow:${input.issuerId}:${input.idempotencyKey}`;
    const priorEscrow =
      this.ledger.findByIdempotency(escrowKey) ??
      this.ledger.findByIdempotency(`escrow:${input.idempotencyKey}`);
    if (priorEscrow) {
      const existing = this.findContract(priorEscrow.ref);
      if (!existing) throw new Error("contract_operation_expired");
      this.operations.set(operationKey, existing.id);
      return { contract: existing };
    }
    const mechanism =
      input.draft.mechanism ?? (input.draft.mode === "claim" ? "exclusive_lease" : "open_race");
    if (mechanism === "piece_rate" && input.draft.predicate.kind !== "kill_count") {
      throw new Error("invalid_mechanism_predicate");
    }
    if (mechanism === "directed_offer" && !input.draft.directedToCommanderId) {
      throw new Error("directed_target_required");
    }
    if ((input.draft.bond ?? 0) > 0 && mechanism !== "exclusive_lease") {
      throw new Error("bond_requires_exclusive_lease");
    }
    if (input.draft.leaseTicks !== undefined && mechanism !== "exclusive_lease") {
      throw new Error("lease_requires_exclusive_lease");
    }
    if (
      input.draft.directedToCommanderId &&
      this.accountForCommander(input.draft.directedToCommanderId) === input.issuerId
    ) {
      throw new Error("issuer_cannot_directed_self");
    }
    const isSystemIssuer =
      input.issuerId === this.systemAccount() || input.issuerId === DUNGEON_ACCOUNT;
    const postingFee = isSystemIssuer ? 0 : postingFeeFor(input.draft.reward);
    const feePayerAccountId = input.feePayerAccountId ?? input.issuerId;
    if (
      input.issuerId !== DUNGEON_ACCOUNT &&
      this.ledger.balance(input.issuerId) < input.draft.reward
    ) {
      throw new Error("insufficient_funds");
    }
    if (
      postingFee > 0 &&
      feePayerAccountId !== DUNGEON_ACCOUNT &&
      this.ledger.balance(feePayerAccountId) <
        postingFee + (feePayerAccountId === input.issuerId ? input.draft.reward : 0)
    ) {
      throw new Error("insufficient_funds");
    }
    const contractId = `contract-${this.nextContract++}`;
    const escrowEntry = this.ledger.transfer({
      from: input.issuerId,
      to: this.escrowAccount(contractId),
      amount: input.draft.reward,
      kind: "contract_escrow",
      ref: contractId,
      tick: input.tick,
      idempotencyKey: escrowKey,
    });
    if (escrowEntry.ref !== contractId) {
      const existing = this.findContract(escrowEntry.ref);
      if (!existing) throw new Error("contract_operation_expired");
      this.operations.set(operationKey, existing.id);
      return { contract: existing };
    }
    if (postingFee > 0) {
      const burnAmount = Math.ceil(postingFee / 2);
      const treasuryAmount = postingFee - burnAmount;
      if (burnAmount > 0) {
        this.ledger.transfer({
          from: feePayerAccountId,
          to: this.burnAccount(),
          amount: burnAmount,
          kind: "posting_fee_burn",
          ref: contractId,
          tick: input.tick,
          idempotencyKey: `posting-fee-burn:${input.issuerId}:${input.idempotencyKey}`,
        });
      }
      if (treasuryAmount > 0) {
        this.ledger.transfer({
          from: feePayerAccountId,
          to: this.treasuryAccount(),
          amount: treasuryAmount,
          kind: "posting_fee_treasury",
          ref: contractId,
          tick: input.tick,
          idempotencyKey: `posting-fee-treasury:${input.issuerId}:${input.idempotencyKey}`,
        });
      }
    }
    const contract: ContractState = {
      id: contractId,
      issuerId: input.issuerId,
      title: input.draft.title,
      description: input.draft.description,
      predicate: input.draft.predicate,
      reward: input.draft.reward,
      mode: input.draft.mode,
      mechanism,
      attribution:
        input.draft.attribution ?? (mechanism === "party_share" ? "damage_share" : "final_blow"),
      ...(input.draft.maxClaimants !== undefined ? { maxClaimants: input.draft.maxClaimants } : {}),
      bond: input.draft.bond ?? 0,
      ...(input.draft.leaseTicks !== undefined ? { leaseTicks: input.draft.leaseTicks } : {}),
      ...(input.draft.directedToCommanderId
        ? { directedToCommanderId: input.draft.directedToCommanderId }
        : {}),
      ...(input.draft.zoneId ? { zoneId: input.draft.zoneId } : {}),
      postingFee,
      referenceReward: referenceRewardFor(input.draft.predicate),
      status: "open",
      progress: 0,
      progressByCommander: {},
      damageByCommander: {},
      paidOut: 0,
      payouts: [],
      opensAtTick: input.tick,
      expiresAtTick: input.tick + input.draft.ttlTicks,
      participants: [],
    };
    this.contracts.set(contractId, contract);
    this.operations.set(operationKey, contractId);
    return {
      contract,
      event: {
        kind: "contract_opened",
        tick: input.tick,
        contractId,
        actorId: input.issuerId,
        text: `${input.draft.title} posted for ${input.draft.reward} Sparks`,
      },
    };
  }

  accept(input: {
    contractId: string;
    claimantId: string;
    claimantAccountId?: string;
    tick: number;
    idempotencyKey: string;
  }): {
    contract: ContractState;
    event?: ContractEngineEvent;
  } {
    const opKey = `accept:${input.contractId}:${input.claimantId}:${input.idempotencyKey}`;
    const legacyOpKey = `accept:${input.idempotencyKey}`;
    if (
      this.operations.get(opKey) === input.contractId ||
      this.operations.get(legacyOpKey) === input.contractId
    ) {
      const replay = this.findContract(input.contractId);
      if (replay) return { contract: replay };
    }
    const contract = this.contracts.get(input.contractId);
    if (!contract) throw new Error("unknown_contract");
    if (contract.status !== "open" && contract.status !== "accepted") {
      throw new Error("contract_not_open");
    }
    const claimantAccountId = input.claimantAccountId ?? this.accountForCommander(input.claimantId);
    if (contract.issuerId === input.claimantId || contract.issuerId === claimantAccountId) {
      throw new Error("issuer_cannot_claim_own");
    }
    const mechanism = mechanismFor(contract);
    if (mechanism === "directed_offer" && contract.directedToCommanderId !== input.claimantId) {
      throw new Error("contract_not_directed_to_claimant");
    }
    if (
      (mechanism === "exclusive_lease" || mechanism === "directed_offer") &&
      contract.claimantId &&
      contract.claimantId !== input.claimantId
    ) {
      throw new Error("contract_already_claimed");
    }
    if (contract.participants.includes(input.claimantId)) {
      this.operations.set(opKey, contract.id);
      return { contract };
    }
    if (
      contract.maxClaimants !== undefined &&
      contract.participants.length >= contract.maxClaimants
    ) {
      throw new Error("contract_full");
    }
    if ((contract.bond ?? 0) > 0) {
      this.ledger.transfer({
        from: claimantAccountId,
        to: this.bondAccount(contract.id),
        amount: contract.bond!,
        kind: "contract_bond",
        ref: contract.id,
        tick: input.tick,
        idempotencyKey: `bond:${contract.id}:${claimantAccountId}`,
      });
    }
    contract.participants.push(input.claimantId);
    if (mechanism === "exclusive_lease" || mechanism === "directed_offer") {
      contract.claimantId = input.claimantId;
      contract.status = "accepted";
      if (mechanism === "exclusive_lease" && contract.leaseTicks !== undefined) {
        contract.leaseExpiresAtTick = input.tick + contract.leaseTicks;
      }
    }
    this.operations.set(opKey, contract.id);
    return {
      contract,
      event: {
        kind: "contract_accepted",
        tick: input.tick,
        contractId: contract.id,
        actorId: input.claimantId,
        text: `${contract.title} accepted`,
      },
    };
  }

  seedSystemContracts(tick: number): ContractEngineEvent[] {
    const hasLiveSystemContract = [...this.contracts.values()].some(
      (c) =>
        (c.issuerId === DUNGEON_ACCOUNT || c.issuerId === this.systemAccount()) &&
        (c.status === "open" || c.status === "accepted"),
    );
    if (hasLiveSystemContract) return [];
    const drafts: ContractDraft[] = [
      {
        title: "Cull 12 skeletons",
        description: "System bounty: clear the crypts.",
        predicate: { kind: "kill_count", targetTag: "skeleton", count: 12 },
        reward: 150,
        mode: "bounty",
        ttlTicks: 30 * 60 * 20,
      },
      {
        title: "Silence the Bone Choir",
        description: "Kill the boss in the south-east choir.",
        predicate: { kind: "kill_entity", entityId: "boss-bone-choir" },
        reward: 400,
        mode: "bounty",
        ttlTicks: 30 * 60 * 20,
      },
      {
        title: "Return the Moon Relic",
        description: "Carry the relic to the north shrine.",
        predicate: { kind: "deliver_item", itemTemplateId: "relic", destination: "shrine" },
        reward: 250,
        mode: "bounty",
        ttlTicks: 30 * 60 * 20,
      },
    ];
    return drafts.flatMap((draft, i) => {
      const result = this.create({
        issuerId: this.systemAccount(),
        draft,
        tick,
        idempotencyKey: `system-contract-v1-${i + 1}@${tick}`,
      });
      return result.event ? [result.event] : [];
    });
  }

  private eligible(contract: ContractState, actorId: string | undefined): actorId is string {
    if (!actorId) return false;
    if (actorId === contract.issuerId || this.accountForCommander(actorId) === contract.issuerId) {
      return false;
    }
    const mechanism = mechanismFor(contract);
    if (mechanism === "exclusive_lease" || mechanism === "directed_offer") {
      return contract.claimantId === actorId;
    }
    return contract.status === "open" || contract.status === "accepted";
  }

  private payFromEscrow(
    contract: ContractState,
    commanderId: string,
    amount: number,
    tick: number,
    eventSeq: number,
    kind: ContractPayout["kind"],
    completedContract: boolean,
  ): ContractPayout | undefined {
    if (amount <= 0) return undefined;
    const accountId = this.accountForCommander(commanderId);
    this.ledger.transfer({
      from: this.escrowAccount(contract.id),
      to: accountId,
      amount,
      kind: kind === "piece" ? "contract_piece_payment" : "contract_settlement",
      ref: contract.id,
      tick,
      idempotencyKey:
        kind === "piece"
          ? `piece:${contract.id}:${eventSeq}:${commanderId}`
          : `settlement:${contract.id}:${eventSeq}:${commanderId}`,
    });
    const payout: ContractPayout = { commanderId, accountId, amount, tick, kind };
    contract.paidOut = (contract.paidOut ?? 0) + amount;
    contract.payouts ??= [];
    contract.payouts.push(payout);
    this.recordPayoutReputation(contract, payout, completedContract);
    return payout;
  }

  private transferBond(
    contract: ContractState,
    toAccountId: string,
    tick: number,
    reason: string,
  ): void {
    const bondAccount = this.bondAccount(contract.id);
    const amount = this.ledger.balance(bondAccount);
    if (amount <= 0) return;
    this.ledger.transfer({
      from: bondAccount,
      to: toAccountId,
      amount,
      kind: `contract_bond_${reason}`,
      ref: contract.id,
      tick,
      idempotencyKey: `bond-${reason}:${contract.id}:${toAccountId}`,
    });
  }

  private refundBond(contract: ContractState, tick: number): void {
    if (!contract.claimantId) return;
    this.transferBond(contract, this.accountForCommander(contract.claimantId), tick, "refund");
  }

  private settleShares(
    contract: ContractState,
    weights: Map<string, number>,
    primaryWinnerId: string,
    tick: number,
    eventSeq: number,
  ): ContractEngineEvent {
    const settlementId = `settlement:${contract.id}:${eventSeq}`;
    const amount = contract.reward - (contract.paidOut ?? 0);
    const positive = [...weights.entries()].filter(([, weight]) => weight > 0);
    const totalWeight = positive.reduce((sum, [, weight]) => sum + weight, 0);
    const allocations = new Map<string, number>();
    if (totalWeight > 0 && amount > 0) {
      let allocated = 0;
      const remainders: Array<{ commanderId: string; remainder: number }> = [];
      for (const [commanderId, weight] of positive.sort(([a], [b]) => a.localeCompare(b))) {
        const exact = (amount * weight) / totalWeight;
        const base = Math.floor(exact);
        allocations.set(commanderId, base);
        allocated += base;
        remainders.push({ commanderId, remainder: exact - base });
      }
      remainders.sort(
        (a, b) => b.remainder - a.remainder || a.commanderId.localeCompare(b.commanderId),
      );
      for (let i = 0; allocated < amount && remainders.length > 0; i++) {
        const commanderId = remainders[i % remainders.length]!.commanderId;
        allocations.set(commanderId, (allocations.get(commanderId) ?? 0) + 1);
        allocated++;
      }
    } else if (amount > 0) {
      allocations.set(primaryWinnerId, amount);
    }
    const payouts: ContractPayout[] = [];
    for (const [commanderId, payoutAmount] of [...allocations.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const payout = this.payFromEscrow(
        contract,
        commanderId,
        payoutAmount,
        tick,
        eventSeq,
        "settlement",
        true,
      );
      if (payout) payouts.push({ ...payout });
    }
    this.refundBond(contract, tick);
    contract.status = "settled";
    contract.closedAtTick = tick;
    contract.settlementId = settlementId;
    contract.claimantId = primaryWinnerId;
    delete contract.leaseExpiresAtTick;
    return {
      kind: "contract_settled",
      tick,
      contractId: contract.id,
      actorId: primaryWinnerId,
      text: `${contract.title} settled for ${contract.reward} Sparks`,
      payouts,
    };
  }

  private settle(
    contract: ContractState,
    winnerId: string,
    tick: number,
    eventSeq: number,
  ): ContractEngineEvent {
    return this.settleShares(contract, new Map([[winnerId, 1]]), winnerId, tick, eventSeq);
  }

  applyEvent(
    event: SimLikeEvent,
    eventSeq: number,
    commanderPositions: Map<string, Vec2>,
  ): ContractEngineEvent[] {
    const out: ContractEngineEvent[] = [];
    for (const contract of this.contracts.values()) {
      if (contract.status !== "open" && contract.status !== "accepted") continue;
      if (event.tick < contract.opensAtTick || event.tick > contract.expiresAtTick) continue;
      const p = contract.predicate;
      if (
        p.kind === "kill_entity" &&
        event.type === "damage" &&
        event.targetId === p.entityId &&
        Number.isFinite(event.amount) &&
        (event.amount ?? 0) > 0
      ) {
        const actor = event.sourceCommanderId;
        if (!this.eligible(contract, actor)) continue;
        contract.damageByCommander ??= {};
        contract.damageByCommander[actor] =
          (contract.damageByCommander[actor] ?? 0) + event.amount!;
      } else if (
        p.kind === "kill_count" &&
        event.type === "death" &&
        event.victimTag === p.targetTag
      ) {
        const actor = event.killerCommanderId;
        if (!this.eligible(contract, actor)) continue;
        const next = (contract.progressByCommander[actor] ?? 0) + 1;
        contract.progressByCommander[actor] = next;
        const mechanism = mechanismFor(contract);
        const totalProgress = Object.values(contract.progressByCommander).reduce(
          (sum, value) => sum + value,
          0,
        );
        if (mechanism === "piece_rate") {
          contract.progress = totalProgress;
          const entitled = Math.floor(
            (contract.reward * Math.min(totalProgress, p.count)) / p.count,
          );
          const due = Math.max(0, entitled - (contract.paidOut ?? 0));
          const payout = this.payFromEscrow(
            contract,
            actor,
            due,
            event.tick,
            eventSeq,
            "piece",
            totalProgress >= p.count,
          );
          if (totalProgress >= p.count) {
            this.refundBond(contract, event.tick);
            contract.status = "settled";
            contract.closedAtTick = event.tick;
            contract.settlementId = `settlement:${contract.id}:${eventSeq}`;
            contract.claimantId = actor;
            out.push({
              kind: "contract_settled",
              tick: event.tick,
              contractId: contract.id,
              actorId: actor,
              text: `${contract.title} settled for ${contract.reward} Sparks`,
              payouts: payout ? [{ ...payout }] : [],
            });
          }
        } else if (mechanism === "party_share") {
          contract.progress = totalProgress;
          if (totalProgress >= p.count) {
            out.push(
              this.settleShares(
                contract,
                new Map(Object.entries(contract.progressByCommander)),
                actor,
                event.tick,
                eventSeq,
              ),
            );
          }
        } else {
          contract.progress = Math.max(...Object.values(contract.progressByCommander), 0);
          if (next >= p.count) out.push(this.settle(contract, actor, event.tick, eventSeq));
        }
      } else if (
        p.kind === "kill_entity" &&
        event.type === "death" &&
        event.victimId === p.entityId
      ) {
        const actor = event.killerCommanderId;
        if (!this.eligible(contract, actor)) continue;
        contract.progress = 1;
        if (mechanismFor(contract) === "party_share") {
          const damageWeights = new Map(Object.entries(contract.damageByCommander ?? {}));
          out.push(this.settleShares(contract, damageWeights, actor, event.tick, eventSeq));
        } else {
          out.push(this.settle(contract, actor, event.tick, eventSeq));
        }
      } else if (
        p.kind === "deliver_item" &&
        event.type === "item_delivered" &&
        event.templateId === p.itemTemplateId &&
        event.destination === p.destination
      ) {
        const actor = event.commanderId;
        if (!this.eligible(contract, actor)) continue;
        contract.progress = 1;
        out.push(this.settle(contract, actor, event.tick, eventSeq));
      } else if (
        p.kind === "escort_alive" &&
        event.type === "commander_extracted" &&
        event.commanderId === p.subjectCommanderId
      ) {
        const subject = commanderPositions.get(p.subjectCommanderId);
        if (!subject) continue;
        const candidates =
          mechanismFor(contract) === "exclusive_lease" ||
          mechanismFor(contract) === "directed_offer"
            ? contract.claimantId
              ? [contract.claimantId]
              : []
            : [...commanderPositions.keys()].filter((id) => id !== p.subjectCommanderId).sort();
        const winner = candidates.find((id) => {
          const pos = commanderPositions.get(id);
          return pos && this.eligible(contract, id) && distance(pos, subject) <= p.withinDistance;
        });
        if (!winner) continue;
        contract.progress = 1;
        out.push(this.settle(contract, winner, event.tick, eventSeq));
      }
    }
    return out;
  }

  expire(tick: number): ContractEngineEvent[] {
    const out: ContractEngineEvent[] = [];
    for (const contract of this.contracts.values()) {
      if (contract.status !== "open" && contract.status !== "accepted") continue;
      if (
        mechanismFor(contract) === "exclusive_lease" &&
        contract.claimantId &&
        contract.leaseExpiresAtTick !== undefined &&
        tick > contract.leaseExpiresAtTick &&
        tick <= contract.expiresAtTick
      ) {
        const claimantId = contract.claimantId;
        const claimantAccountId = this.accountForCommander(claimantId);
        this.transferBond(contract, contract.issuerId, tick, "forfeit");
        this.reputationRecord(claimantAccountId).expiredClaims++;
        contract.participants = contract.participants.filter((id) => id !== claimantId);
        delete contract.claimantId;
        delete contract.leaseExpiresAtTick;
        contract.status = "open";
        out.push({
          kind: "contract_lease_released",
          tick,
          contractId: contract.id,
          actorId: claimantId,
          text: `${contract.title} lease expired and reopened`,
        });
        continue;
      }
      if (tick <= contract.expiresAtTick) continue;
      const escrow = this.escrowAccount(contract.id);
      const amount = this.ledger.balance(escrow);
      if (amount > 0) {
        this.ledger.transfer({
          from: escrow,
          to: contract.issuerId,
          amount,
          kind: "contract_refund",
          ref: contract.id,
          tick,
          idempotencyKey: `refund:${contract.id}`,
        });
      }
      if (mechanismFor(contract) === "exclusive_lease" && contract.claimantId) {
        this.reputationRecord(this.accountForCommander(contract.claimantId)).expiredClaims++;
      }
      this.refundBond(contract, tick);
      contract.status = "refunded";
      contract.closedAtTick = tick;
      delete contract.leaseExpiresAtTick;
      out.push({
        kind: "contract_refunded",
        tick,
        contractId: contract.id,
        actorId: contract.issuerId,
        text: `${contract.title} expired and refunded`,
      });
    }
    return out;
  }

  cancel(input: { contractId: string; issuerId: string; tick: number; idempotencyKey: string }): {
    contract: ContractState;
    event?: ContractEngineEvent;
  } {
    const opKey = `cancel:${input.contractId}:${input.issuerId}:${input.idempotencyKey}`;
    if (this.operations.get(opKey) === input.contractId) {
      const replay = this.findContract(input.contractId);
      if (replay) return { contract: replay };
    }
    const contract = this.contracts.get(input.contractId);
    if (!contract) throw new Error("unknown_contract");
    if (contract.issuerId !== input.issuerId) throw new Error("contract_not_issuer");
    if (!isLiveContract(contract)) throw new Error("contract_not_open");
    const escrow = this.escrowAccount(contract.id);
    const amount = this.ledger.balance(escrow);
    if (amount > 0) {
      this.ledger.transfer({
        from: escrow,
        to: contract.issuerId,
        amount,
        kind: "contract_cancel_refund",
        ref: contract.id,
        tick: input.tick,
        idempotencyKey: `cancel-refund:${contract.id}`,
      });
    }
    this.refundBond(contract, input.tick);
    contract.status = "cancelled";
    contract.closedAtTick = input.tick;
    delete contract.leaseExpiresAtTick;
    this.operations.set(opKey, contract.id);
    return {
      contract,
      event: {
        kind: "contract_cancelled",
        tick: input.tick,
        contractId: contract.id,
        actorId: input.issuerId,
        text: `${contract.title} cancelled and refunded`,
      },
    };
  }

  escrowedBy(issuerId: string): number {
    let total = 0;
    for (const contract of this.contracts.values()) {
      if (contract.issuerId !== issuerId) continue;
      total += this.ledger.balance(this.escrowAccount(contract.id));
    }
    return total;
  }

  verifyEscrow(): { checked: number; escrowed: number } {
    let checked = 0;
    let escrowed = 0;
    for (const contract of [...this.archivedContracts.values(), ...this.contracts.values()]) {
      const expected = isLiveContract(contract) ? contract.reward - (contract.paidOut ?? 0) : 0;
      const actual = this.ledger.balance(this.escrowAccount(contract.id));
      if (actual !== expected) throw new Error(`contract_escrow_mismatch:${contract.id}`);
      const expectedBond =
        isLiveContract(contract) && contract.claimantId ? (contract.bond ?? 0) : 0;
      if (this.ledger.balance(this.bondAccount(contract.id)) !== expectedBond) {
        throw new Error(`contract_escrow_mismatch:${contract.id}`);
      }
      checked++;
      escrowed += actual;
    }
    return { checked, escrowed };
  }

  openCountByIssuer(issuerId: string): number {
    let total = 0;
    for (const contract of this.contracts.values()) {
      if (contract.issuerId === issuerId && isLiveContract(contract)) total++;
    }
    return total;
  }

  private pruneTombstonesAndOperations(options: ContractArchiveOptions = {}): void {
    const keepTombstones = Math.max(
      0,
      Math.floor(options.keepTombstones ?? DEFAULT_TOMBSTONE_CONTRACTS),
    );
    const keepOperations = Math.max(
      0,
      Math.floor(options.keepOperations ?? DEFAULT_OPERATION_RECORDS),
    );
    const keepCreateOperations = Math.max(
      0,
      Math.floor(options.keepCreateOperations ?? DEFAULT_CREATE_OPERATION_RECORDS),
    );
    if (this.archivedContracts.size > keepTombstones) {
      const excess = this.archivedContracts.size - keepTombstones;
      const oldest = [...this.archivedContracts.values()]
        .map((contract, index) => ({ contract, index }))
        .sort((a, b) =>
          contractActivityTick(a.contract) === contractActivityTick(b.contract)
            ? a.index - b.index
            : contractActivityTick(a.contract) - contractActivityTick(b.contract),
        )
        .slice(0, excess);
      for (const { contract } of oldest) this.archivedContracts.delete(contract.id);
    }

    const operationEntries = [...this.operations.entries()];
    const createEntries = operationEntries.filter(([key]) => key.startsWith("create:"));
    const acceptEntries = operationEntries.filter(([key]) => !key.startsWith("create:"));
    let createExcess = Math.max(0, createEntries.length - keepCreateOperations);
    for (const [key, contractId] of createEntries) {
      if (createExcess <= 0) break;
      if (this.findContract(contractId)) continue;
      this.operations.delete(key);
      createExcess--;
    }
    const retainedAcceptEntries: Array<[string, string]> = [];
    for (const [key, contractId] of acceptEntries) {
      if (!this.findContract(contractId)) {
        this.operations.delete(key);
      } else {
        retainedAcceptEntries.push([key, contractId]);
      }
    }
    let acceptExcess = Math.max(0, retainedAcceptEntries.length - keepOperations);
    for (const [key] of retainedAcceptEntries) {
      if (acceptExcess <= 0) break;
      this.operations.delete(key);
      acceptExcess--;
    }
  }

  takeArchiveBatch(options: ContractArchiveOptions = {}): ContractSnapshot[] {
    const keepClosed = Math.max(0, Math.floor(options.keepClosed ?? DEFAULT_HOT_CLOSED_CONTRACTS));
    const closed = [...this.contracts.values()]
      .map((contract, index) => ({ contract, index }))
      .filter(
        ({ contract }) =>
          !isLiveContract(contract) &&
          this.ledger.balance(this.escrowAccount(contract.id)) === 0 &&
          this.ledger.balance(this.bondAccount(contract.id)) === 0,
      )
      .sort((a, b) =>
        contractActivityTick(a.contract) === contractActivityTick(b.contract)
          ? a.index - b.index
          : contractActivityTick(a.contract) - contractActivityTick(b.contract),
      )
      .map(({ contract }) => contract);
    const excess = Math.max(0, closed.length - keepClosed);
    const batch = closed.slice(0, excess);
    for (const contract of batch) {
      this.contracts.delete(contract.id);
      this.archivedContracts.set(contract.id, contract);
      this.ledger.deleteZeroAccount(this.escrowAccount(contract.id));
      this.ledger.deleteZeroAccount(this.bondAccount(contract.id));
    }
    this.pruneTombstonesAndOperations(options);
    return batch.map(cloneContract);
  }

  snapshotWindow(options: ContractSnapshotWindowOptions = {}): ContractSnapshot[] {
    const limit = Math.min(256, Math.max(1, Math.floor(options.limit ?? 32)));
    const viewerIds = new Set(
      [options.commanderId, options.accountId].filter((id): id is string => Boolean(id)),
    );
    const involvesViewer = (contract: ContractState): boolean =>
      viewerIds.has(contract.issuerId) ||
      (contract.claimantId ? viewerIds.has(contract.claimantId) : false) ||
      contract.participants.some((participant) => viewerIds.has(participant));
    const indexed = [...this.archivedContracts.values(), ...this.contracts.values()].map(
      (contract, index) => ({ contract, index }),
    );
    const newest = (entries: Array<{ contract: ContractState; index: number }>, byReward = false) =>
      [...entries].sort((a, b) => {
        if (byReward && a.contract.reward !== b.contract.reward) {
          return b.contract.reward - a.contract.reward;
        }
        if (contractActivityTick(a.contract) !== contractActivityTick(b.contract)) {
          return contractActivityTick(b.contract) - contractActivityTick(a.contract);
        }
        return b.index - a.index;
      });
    const live = indexed.filter(({ contract }) => isLiveContract(contract));
    const closed = indexed.filter(({ contract }) => !isLiveContract(contract));
    const selected = new Map<string, { contract: ContractState; index: number }>();
    const add = (
      entries: Array<{ contract: ContractState; index: number }>,
      maxEntries: number,
      byReward = false,
    ) => {
      let added = 0;
      for (const entry of newest(entries, byReward)) {
        if (selected.size >= limit || added >= maxEntries) return;
        if (!selected.has(entry.contract.id)) added++;
        selected.set(entry.contract.id, entry);
      }
    };
    add(
      live.filter(({ contract }) => involvesViewer(contract)),
      16,
    );
    add(
      closed.filter(({ contract }) => involvesViewer(contract)),
      4,
    );
    add(
      closed.filter(({ contract }) => !involvesViewer(contract)),
      2,
    );
    add(
      live.filter(({ contract }) => !involvesViewer(contract)),
      16,
      true,
    );
    return [...selected.values()]
      .sort((a, b) =>
        contractActivityTick(a.contract) === contractActivityTick(b.contract)
          ? a.index - b.index
          : contractActivityTick(a.contract) - contractActivityTick(b.contract),
      )
      .map(({ contract }) => {
        const snapshot = cloneContract(contract);
        if (!viewerIds.has(contract.issuerId)) {
          snapshot.participants = contract.participants.filter(
            (participant) => viewerIds.has(participant) || participant === contract.claimantId,
          );
          snapshot.progressByCommander = Object.fromEntries(
            Object.entries(contract.progressByCommander).filter(
              ([commanderId]) => viewerIds.has(commanderId) || commanderId === contract.claimantId,
            ),
          );
        }
        return snapshot;
      });
  }

  snapshots(): ContractSnapshot[] {
    return [...this.archivedContracts.values(), ...this.contracts.values()].map(cloneContract);
  }

  serialize(): unknown {
    return {
      nextContract: this.nextContract,
      operations: [...this.operations.entries()],
      contracts: [...this.contracts.values()].map((contract) =>
        compactContractForCheckpoint(contract),
      ),
      archivedContracts: [...this.archivedContracts.values()]
        .slice(-DEFAULT_TOMBSTONE_CONTRACTS)
        .map((contract) => compactContractForCheckpoint(contract, true)),
      reputations: [...this.reputations.values()],
    };
  }

  static restore(
    ledger: Ledger,
    data: unknown,
    options: ContractEngineOptions = {},
  ): ContractEngine {
    const source =
      data && typeof data === "object"
        ? (data as {
            nextContract?: unknown;
            operations?: Array<[unknown, unknown]>;
            contracts?: ContractState[];
            archivedContracts?: ContractState[];
            reputations?: ReputationRecord[];
          })
        : {};
    const engine = new ContractEngine(ledger, options);
    engine.nextContract = Number(source.nextContract ?? 1);
    for (const [k, v] of Array.isArray(source.operations) ? source.operations : []) {
      engine.operations.set(String(k), String(v));
    }
    for (const contract of Array.isArray(source.contracts) ? source.contracts : []) {
      engine.contracts.set(contract.id, cloneContract(contract));
    }
    for (const contract of Array.isArray(source.archivedContracts)
      ? source.archivedContracts
      : []) {
      engine.archivedContracts.set(contract.id, cloneContract(contract));
    }
    for (const record of Array.isArray(source.reputations) ? source.reputations : []) {
      engine.reputations.set(record.accountId, {
        accountId: String(record.accountId),
        completed: Number(record.completed ?? 0),
        settledValue: Number(record.settledValue ?? 0),
        uniqueIssuers: Array.isArray(record.uniqueIssuers) ? record.uniqueIssuers.map(String) : [],
        expiredClaims: Number(record.expiredClaims ?? 0),
      });
    }
    return engine;
  }
}
