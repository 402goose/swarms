import { ContractEngine, Ledger } from "@swarms/bounties";
import { BOLT, COMMANDER, MONSTER, UNIT, xpForLevel } from "@swarms/content";
import { SimWorld } from "@swarms/sim";
import { describe, expect, it } from "vitest";

describe("deterministic simulation", () => {
  it("produces the same hash for the same seed and commands", () => {
    const run = () => {
      const world = new SimWorld(42);
      world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "One", kind: "human" });
      world.spawnCommander({ id: "cmdr-2", accountId: "cmdr-2", name: "Two", kind: "bot" });
      const monster = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
      world.applyCommand("cmdr-1", 1, {
        type: "attackMove",
        target: { x: monster.x, y: monster.y },
      });
      world.applyCommand("cmdr-2", 1, {
        type: "attackMove",
        target: { x: world.map.width * 0.6, y: world.map.height * 0.5 },
      });
      for (let i = 0; i < 240; i++) world.step();
      return world.stateHash();
    };
    expect(run()).toBe(run());
  });

  it("rejects stale command sequences", () => {
    const world = new SimWorld(7);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "One", kind: "human" });
    expect(world.applyCommand("cmdr-1", 5, { type: "stop" })).toBeUndefined();
    expect(world.applyCommand("cmdr-1", 5, { type: "stop" })).toBe("stale_sequence");
  });
});

describe("navigation and respawn", () => {
  it("paths a commander across the dungeon instead of grinding on walls", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Path", kind: "human" });
    const target = {
      x: world.map.extraction.x + world.map.extraction.w / 2,
      y: world.map.extraction.y + world.map.extraction.h / 2,
    };
    world.applyCommand("cmdr-1", 1, { type: "attackMove", target });
    const commander = world.commanders.get("cmdr-1")!;
    const distToTarget = () => Math.hypot(commander.x - target.x, commander.y - target.y);
    let minDistance = distToTarget();
    let reachedAtTick = -1;
    for (let i = 0; i < 1800 && reachedAtTick < 0; i++) {
      world.step();
      minDistance = Math.min(minDistance, distToTarget());
      if (distToTarget() < 48) reachedAtTick = world.tick;
    }
    expect(minDistance).toBeLessThan(48);
    expect(reachedAtTick).toBeGreaterThan(0);
    expect(reachedAtTick).toBeLessThan(900);
  });

  it("sustains speed under repeated WASD-style move commands", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Hold", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    const startX = commander.x;
    let seq = 0;
    for (let i = 0; i < 300; i++) {
      if (i % 4 === 0) {
        world.applyCommand("cmdr-1", ++seq, {
          type: "attackMove",
          target: { x: commander.x + 260, y: commander.y },
        });
      }
      world.step();
    }
    expect(commander.x - startX).toBeGreaterThan(1100);
  });

  it("respawns a dead commander with a fresh swarm", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Again", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    commander.hp = 0;
    commander.alive = false;
    commander.respawnAtTick = world.tick + 2;
    world.step();
    world.step();
    world.step();
    expect(commander.alive).toBe(true);
    expect([...world.entities.values()].filter((e) => e.ownerId === commander.id)).toHaveLength(14);
  });
});

describe("swarm cohesion and monster hunting", () => {
  it("keeps the swarm cohesive while traversing to extraction", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Flock", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    const target = {
      x: world.map.extraction.x + world.map.extraction.w / 2,
      y: world.map.extraction.y + world.map.extraction.h / 2,
    };
    world.applyCommand("cmdr-1", 1, { type: "attackMove", target });
    const distances: number[] = [];
    let reached = false;
    for (let i = 0; i < 1200 && !reached; i++) {
      world.step();
      if (!commander.alive) break;
      if (Math.hypot(commander.x - target.x, commander.y - target.y) < 60) reached = true;
      if (world.tick > 60 && world.tick % 10 === 0) {
        for (const e of world.entities.values()) {
          if (e.ownerId === commander.id)
            distances.push(Math.hypot(e.x - commander.x, e.y - commander.y));
        }
      }
    }
    expect(reached).toBe(true);
    expect(distances.length).toBeGreaterThan(200);
    const sorted = [...distances].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const within190 = distances.filter((d) => d <= 190).length / distances.length;
    const stranded = distances.filter((d) => d > 320).length / distances.length;
    expect(median).toBeLessThanOrEqual(120);
    expect(within190).toBeGreaterThanOrEqual(0.8);
    expect(stranded).toBeLessThanOrEqual(0.02);
  });

  it("keeps cohesion under sustained WASD transit that never settles", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Transit", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    // Cohesion is the subject; with 3-tile corridors the transit now reaches
    // crypt-south and monster attrition (14 units -> 0, death at tick ~808 in
    // the probe) ends the run early. Neutralize monsters so only cohesion is measured.
    for (const e of world.entities.values()) if (e.kind === "monster") e.hp = 0;
    const distances: number[] = [];
    let seq = 0;
    let cumulative = 0;
    let prev = { x: commander.x, y: commander.y };
    for (let i = 0; i < 840; i++) {
      if (i % 4 === 0) {
        const dir = i < 420 ? 1 : -1;
        world.applyCommand("cmdr-1", ++seq, {
          type: "attackMove",
          target: { x: commander.x + dir * 260, y: commander.y },
        });
      }
      world.step();
      cumulative += Math.hypot(commander.x - prev.x, commander.y - prev.y);
      prev = { x: commander.x, y: commander.y };
      if (!commander.alive) break;
      if (world.tick > 90 && world.tick % 10 === 0) {
        for (const e of world.entities.values()) {
          if (e.ownerId === commander.id)
            distances.push(Math.hypot(e.x - commander.x, e.y - commander.y));
        }
      }
    }
    expect(commander.alive).toBe(true);
    expect(cumulative).toBeGreaterThan(1600);
    expect(distances.length).toBeGreaterThan(400);
    const sorted = [...distances].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)]!;
    const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
    const max = sorted[sorted.length - 1]!;
    const stranded = distances.filter((d) => d > 320).length / distances.length;
    expect(p90, `sustained-transit p90=${Math.round(p90)}px`).toBeLessThanOrEqual(200);
    expect(p99, `sustained-transit p99=${Math.round(p99)}px`).toBeLessThanOrEqual(260);
    expect(max, `sustained-transit max=${Math.round(max)}px`).toBeLessThanOrEqual(480);
    expect(stranded).toBeLessThanOrEqual(0.02);
  });

  it("removes the swarm when its commander dies", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Doomed", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    const tile = world.map.tileSize;
    const arena = world.map.rooms.find((r) => r.id === "arena")!;
    commander.x = (arena.x + arena.w / 2) * tile;
    commander.y = (arena.y + arena.h / 2) * tile;
    commander.target = { x: commander.x, y: commander.y };
    commander.path = [];
    commander.trail = [{ x: commander.x, y: commander.y }];
    commander.hp = 1;
    for (const e of world.entities.values()) {
      if (e.ownerId === commander.id) e.x = commander.x - 400;
    }
    const skeleton = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    skeleton.x = commander.x + 20;
    skeleton.y = commander.y;
    skeleton.homeX = skeleton.x;
    skeleton.homeY = skeleton.y;
    skeleton.cooldown = 0;
    for (let i = 0; i < 90 && commander.alive; i++) world.step();
    expect(commander.alive).toBe(false);
    expect([...world.entities.values()].filter((e) => e.ownerId === commander.id)).toHaveLength(0);
  });

  it("catches a far-stranded unit back up to its commander", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Anchor", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    const unit = [...world.entities.values()].find((e) => e.ownerId === commander.id)!;
    unit.x = commander.x + 1400;
    unit.y = commander.y;
    world.step();
    world.step();
    expect(Math.hypot(unit.x - commander.x, unit.y - commander.y)).toBeLessThan(320);
  });

  it("monsters do not hunt sanctuary victims through walls", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Safe", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    commander.x = 330;
    commander.y = 560;
    commander.target = { x: 330, y: 560 };
    commander.path = [];
    commander.trail = [{ x: 330, y: 560 }];
    const monster = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    monster.x = 512;
    monster.y = 448;
    let minDistanceToCommander = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 120; i++) {
      world.step();
      minDistanceToCommander = Math.min(
        minDistanceToCommander,
        Math.hypot(monster.x - commander.x, monster.y - commander.y),
      );
    }
    expect(minDistanceToCommander).toBeGreaterThan(100);
    expect(commander.hp).toBe(commander.maxHp);
  });
});

describe("world liveness", () => {
  it("monsters return home when no victim is available", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Safe", kind: "human" });
    const monster = [...world.entities.values()].find(
      (e) => e.tag === "skeleton" && e.x > 480 && e.x < 660 && e.y > 160 && e.y < 480,
    )!;
    const home = { x: monster.x, y: monster.y };
    monster.x += 180;
    for (let i = 0; i < 900 && Math.hypot(monster.x - home.x, monster.y - home.y) >= 64; i++) {
      world.step();
    }
    expect(Math.hypot(monster.x - home.x, monster.y - home.y)).toBeLessThan(64);
  });

  it("monster refill never exceeds the spawn-point cap", () => {
    const world = new SimWorld(42);
    const monsters = [...world.entities.values()].filter(
      (e) => e.kind === "monster" && e.id !== "boss-bone-choir",
    );
    for (const m of monsters.slice(0, 30)) m.hp = 0;
    for (const m of monsters.slice(30)) m.x += 100;
    while (world.tick <= 900) world.step();
    const count = [...world.entities.values()].filter((e) => e.kind === "monster").length;
    expect(count).toBeLessThanOrEqual(world.map.monsterSpawns.length + 1);
  });

  it("respawns the Bone Choir boss after it is killed", () => {
    const world = new SimWorld(42);
    const boss = world.entities.get("boss-bone-choir")!;
    boss.hp = 0;
    world.step();
    expect(world.entities.has("boss-bone-choir")).toBe(false);
    for (let i = 0; i < 900 && !world.entities.has("boss-bone-choir"); i++) world.step();
    expect(world.entities.get("boss-bone-choir")!.hp).toBe(900);
  });
});

describe("entry sanctuary", () => {
  it("blocks combat damage inside the entry room", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "One", kind: "human" });
    world.spawnCommander({ id: "cmdr-2", accountId: "cmdr-2", name: "Two", kind: "human" });
    for (let i = 0; i < 240; i++) world.step();
    expect(world.commanders.get("cmdr-1")!.hp).toBe(world.commanders.get("cmdr-1")!.maxHp);
    expect(world.commanders.get("cmdr-2")!.hp).toBe(world.commanders.get("cmdr-2")!.maxHp);
    expect([...world.entities.values()].filter((e) => e.kind === "unit")).toHaveLength(
      UNIT.countPerCommander * 2,
    );
  });

  it("heals and replenishes a swarm resting in the entry", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Rest", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    commander.hp = 40;
    const units = [...world.entities.values()].filter((e) => e.ownerId === commander.id);
    for (const unit of units.slice(0, 6)) unit.hp = 0;
    for (let i = 0; i < 900; i++) world.step();
    expect(commander.hp).toBe(commander.maxHp);
    expect([...world.entities.values()].filter((e) => e.ownerId === commander.id)).toHaveLength(
      UNIT.countPerCommander,
    );
  });
});

describe("contract engine", () => {
  it("counts kill progress live and snapshots participants", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 500, 0);
    ledger.ensureAccount("worker", 10, 0);
    const engine = new ContractEngine(ledger);
    const { contract } = engine.create({
      issuerId: "issuer",
      draft: {
        title: "Cull 3 skeletons",
        description: "progress test",
        predicate: { kind: "kill_count", targetTag: "skeleton", count: 3 },
        reward: 90,
        mode: "bounty",
        ttlTicks: 1800,
      },
      tick: 0,
      idempotencyKey: "progress-test-1",
    });
    engine.accept({
      contractId: contract.id,
      claimantId: "worker",
      tick: 1,
      idempotencyKey: "progress-test-accept-1",
    });
    const kill = (seq: number) =>
      engine.applyEvent(
        { type: "death", tick: 10 + seq, victimTag: "skeleton", killerCommanderId: "worker" },
        seq,
        new Map(),
      );
    kill(1);
    kill(2);
    const snap = engine.snapshots().find((c) => c.id === contract.id)!;
    expect(snap.progress).toBe(2);
    expect(snap.progressByCommander.worker).toBe(2);
    expect(snap.participants).toContain("worker");
    expect(snap.status).toBe("open");
    kill(3);
    expect(engine.snapshots().find((c) => c.id === contract.id)!.status).toBe("settled");
    expect(ledger.balance("worker")).toBe(100);
  });

  it("verifies retained ledger balances and funded contract escrow", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 1000, 0);
    ledger.ensureAccount("worker", 10, 0);
    const engine = new ContractEngine(ledger);
    const { contract } = engine.create({
      issuerId: "issuer",
      draft: {
        title: "Verify escrow",
        description: "",
        predicate: { kind: "kill_count", targetTag: "skeleton", count: 1 },
        reward: 90,
        mode: "bounty",
        ttlTicks: 1800,
      },
      tick: 0,
      idempotencyKey: "verify-escrow-1",
    });
    expect(engine.verifyEscrow()).toEqual({ checked: 1, escrowed: 90 });
    ledger.takeCompactionBatch(1);
    const serialized = ledger.serialize() as { balances: Array<[string, number]> };
    const restored = Ledger.restore(serialized);
    expect(restored.balance("issuer")).toBe(908);
    expect(restored.verifyBalances()).toBe(true);
    const legacySerialized = {
      ...serialized,
      openingBalances: [],
      openingThroughSeq: undefined,
    };
    expect(Ledger.restore(legacySerialized).verifyBalances()).toBe(true);
    serialized.balances = serialized.balances.map(([account, balance]) =>
      account === "issuer" ? [account, balance + 1] : [account, balance],
    );
    expect(() => Ledger.restore(serialized)).toThrow("ledger_balance_mismatch");

    ledger.balances.set(`escrow:${contract.id}`, 0);
    expect(() => engine.verifyEscrow()).toThrow("contract_escrow_mismatch");
  });

  it("re-seeds system bounties after they expire", () => {
    const ledger = new Ledger();
    const engine = new ContractEngine(ledger);
    expect(engine.seedSystemContracts(0)).toHaveLength(3);
    expect(engine.seedSystemContracts(10)).toHaveLength(0);
    engine.expire(30 * 60 * 20 + 1);
    expect(engine.snapshots().filter((c) => c.status === "open")).toHaveLength(0);
    expect(engine.seedSystemContracts(30 * 60 * 20 + 2)).toHaveLength(3);
    expect(engine.snapshots().filter((c) => c.status === "open")).toHaveLength(3);
    expect(ledger.reconcile().net).toBe(0);
  });

  it("escrows, settles once, and reconciles", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 500, 0);
    ledger.ensureAccount("worker", 10, 0);
    const engine = new ContractEngine(ledger);
    const created = engine.create({
      issuerId: "issuer",
      tick: 0,
      idempotencyKey: "test-contract-1",
      draft: {
        title: "Cull two skeletons",
        description: "Test bounty",
        predicate: { kind: "kill_count", targetTag: "skeleton", count: 2 },
        reward: 75,
        mode: "bounty",
        ttlTicks: 900,
      },
    });
    expect(ledger.balance("issuer")).toBe(423);
    expect(created.contract.postingFee).toBe(2);
    expect(ledger.balance(engine.escrowAccount(created.contract.id))).toBe(75);
    const positions = new Map<string, { x: number; y: number }>();
    engine.applyEvent(
      {
        type: "death",
        tick: 1,
        victimId: "m1",
        victimTag: "skeleton",
        killerCommanderId: "worker",
      },
      1,
      positions,
    );
    const settled = engine.applyEvent(
      {
        type: "death",
        tick: 2,
        victimId: "m2",
        victimTag: "skeleton",
        killerCommanderId: "worker",
      },
      2,
      positions,
    );
    expect(settled).toHaveLength(1);
    expect(ledger.balance("worker")).toBe(85);
    engine.applyEvent(
      {
        type: "death",
        tick: 2,
        victimId: "m2",
        victimTag: "skeleton",
        killerCommanderId: "worker",
      },
      2,
      positions,
    );
    expect(ledger.balance("worker")).toBe(85);
    expect(ledger.reconcile().net).toBe(0);
  });

  it("refunds expired escrow exactly once", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 100, 0);
    const engine = new ContractEngine(ledger);
    engine.create({
      issuerId: "issuer",
      tick: 0,
      idempotencyKey: "test-contract-expire",
      draft: {
        title: "Expire me",
        description: "",
        predicate: { kind: "kill_count", targetTag: "skeleton", count: 1 },
        reward: 40,
        mode: "claim",
        ttlTicks: 30,
      },
    });
    expect(engine.expire(31)).toHaveLength(1);
    expect(engine.expire(32)).toHaveLength(0);
    expect(ledger.balance("issuer")).toBe(99);
  });

  it("pays piece-rate work incrementally and refunds only the unpaid remainder", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 1000, 0);
    ledger.ensureAccount("worker-a", 0, 0);
    ledger.ensureAccount("worker-b", 0, 0);
    const engine = new ContractEngine(ledger);
    const { contract } = engine.create({
      issuerId: "issuer",
      tick: 0,
      idempotencyKey: "piece-rate-1",
      draft: {
        title: "Piece cull",
        description: "",
        predicate: { kind: "kill_count", targetTag: "skeleton", count: 4 },
        reward: 101,
        mode: "bounty",
        mechanism: "piece_rate",
        ttlTicks: 100,
      },
    });
    const kill = (actor: string, seq: number) =>
      engine.applyEvent(
        { type: "death", tick: seq, victimTag: "skeleton", killerCommanderId: actor },
        seq,
        new Map(),
      );
    kill("worker-a", 1);
    kill("worker-b", 2);
    expect(ledger.balance("worker-a")).toBe(25);
    expect(ledger.balance("worker-b")).toBe(25);
    expect(contract.paidOut).toBe(50);
    expect(engine.verifyEscrow()).toEqual({ checked: 1, escrowed: 51 });
    engine.expire(101);
    expect(contract.status).toBe("refunded");
    expect(ledger.balance("issuer")).toBe(1000 - 101 - 3 + 51);
    expect(ledger.reconcile().net).toBe(0);
  });

  it("splits party-share rewards by contribution and pays winner accounts", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 1000, 0);
    ledger.ensureAccount("acct-a", 0, 0);
    ledger.ensureAccount("acct-b", 0, 0);
    const engine = new ContractEngine(ledger, {
      accountForCommander: (commanderId) =>
        commanderId === "cmdr-a" ? "acct-a" : commanderId === "cmdr-b" ? "acct-b" : undefined,
    });
    const { contract } = engine.create({
      issuerId: "issuer",
      tick: 0,
      idempotencyKey: "party-share-1",
      draft: {
        title: "Party cull",
        description: "",
        predicate: { kind: "kill_count", targetTag: "skeleton", count: 4 },
        reward: 101,
        mode: "bounty",
        mechanism: "party_share",
        attribution: "progress_share",
        ttlTicks: 900,
      },
    });
    const kill = (actor: string, seq: number) =>
      engine.applyEvent(
        { type: "death", tick: seq, victimTag: "skeleton", killerCommanderId: actor },
        seq,
        new Map(),
      );
    kill("cmdr-a", 1);
    kill("cmdr-a", 2);
    kill("cmdr-a", 3);
    const settled = kill("cmdr-b", 4);
    expect(settled).toHaveLength(1);
    expect(contract.payouts).toEqual([
      expect.objectContaining({ commanderId: "cmdr-a", accountId: "acct-a", amount: 76 }),
      expect.objectContaining({ commanderId: "cmdr-b", accountId: "acct-b", amount: 25 }),
    ]);
    expect(ledger.balance("acct-a")).toBe(76);
    expect(ledger.balance("acct-b")).toBe(25);
    expect(engine.reputationFor("acct-a")).toMatchObject({ completed: 1, settledValue: 76 });
    expect(engine.reputationFor("acct-a").score).toBeGreaterThan(
      engine.reputationFor("acct-b").score,
    );
  });

  it("escrows exclusive-lease bonds, releases expired leases, and refunds settled bonds", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 1000, 0);
    ledger.ensureAccount("worker", 100, 0);
    ledger.ensureAccount("other", 100, 0);
    const engine = new ContractEngine(ledger);
    const { contract } = engine.create({
      issuerId: "issuer",
      tick: 0,
      idempotencyKey: "exclusive-lease-1",
      draft: {
        title: "Lease the boss",
        description: "",
        predicate: { kind: "kill_entity", entityId: "boss-bone-choir" },
        reward: 200,
        mode: "claim",
        mechanism: "exclusive_lease",
        bond: 20,
        leaseTicks: 50,
        ttlTicks: 900,
      },
    });
    engine.accept({
      contractId: contract.id,
      claimantId: "worker",
      claimantAccountId: "worker",
      tick: 1,
      idempotencyKey: "lease-accept-1",
    });
    expect(ledger.balance("worker")).toBe(80);
    expect(contract.leaseExpiresAtTick).toBe(51);
    const released = engine.expire(52);
    expect(released.map((event) => event.kind)).toContain("contract_lease_released");
    expect(contract.status).toBe("open");
    expect(contract.claimantId).toBeUndefined();
    expect(ledger.balance("worker")).toBe(80);
    expect(ledger.balance("issuer")).toBe(1000 - 200 - 4 + 20);
    engine.accept({
      contractId: contract.id,
      claimantId: "other",
      claimantAccountId: "other",
      tick: 53,
      idempotencyKey: "lease-accept-2",
    });
    engine.applyEvent(
      { type: "death", tick: 54, victimId: "boss-bone-choir", killerCommanderId: "other" },
      54,
      new Map(),
    );
    expect(contract.status).toBe("settled");
    expect(ledger.balance("other")).toBe(100 - 20 + 200 + 20);
    expect(engine.verifyEscrow()).toEqual({ checked: 1, escrowed: 0 });
    expect(ledger.reconcile().net).toBe(0);
  });

  it("restricts directed offers and splits boss rewards by recorded damage", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 1000, 0);
    ledger.ensureAccount("cmdr-a", 0, 0);
    ledger.ensureAccount("cmdr-b", 0, 0);
    const engine = new ContractEngine(ledger);
    const directed = engine.create({
      issuerId: "issuer",
      tick: 0,
      idempotencyKey: "directed-offer-1",
      draft: {
        title: "Directed cull",
        description: "",
        predicate: { kind: "kill_count", targetTag: "skeleton", count: 1 },
        reward: 50,
        mode: "bounty",
        mechanism: "directed_offer",
        directedToCommanderId: "cmdr-a",
        ttlTicks: 900,
      },
    }).contract;
    expect(() =>
      engine.accept({
        contractId: directed.id,
        claimantId: "cmdr-b",
        tick: 1,
        idempotencyKey: "directed-wrong-accept",
      }),
    ).toThrow("contract_not_directed_to_claimant");

    const boss = engine.create({
      issuerId: "issuer",
      tick: 0,
      idempotencyKey: "damage-share-boss-1",
      draft: {
        title: "Damage-share boss",
        description: "",
        predicate: { kind: "kill_entity", entityId: "boss-bone-choir" },
        reward: 100,
        mode: "bounty",
        mechanism: "party_share",
        attribution: "damage_share",
        ttlTicks: 900,
      },
    }).contract;
    engine.applyEvent(
      {
        type: "damage",
        tick: 1,
        targetId: "boss-bone-choir",
        amount: 75,
        sourceCommanderId: "cmdr-a",
      },
      1,
      new Map(),
    );
    engine.applyEvent(
      {
        type: "damage",
        tick: 2,
        targetId: "boss-bone-choir",
        amount: 25,
        sourceCommanderId: "cmdr-b",
      },
      2,
      new Map(),
    );
    engine.applyEvent(
      { type: "death", tick: 3, victimId: "boss-bone-choir", killerCommanderId: "cmdr-b" },
      3,
      new Map(),
    );
    expect(boss.payouts).toEqual([
      expect.objectContaining({ commanderId: "cmdr-a", amount: 75 }),
      expect.objectContaining({ commanderId: "cmdr-b", amount: 25 }),
    ]);

    const cancelled = engine.cancel({
      contractId: directed.id,
      issuerId: "issuer",
      tick: 4,
      idempotencyKey: "directed-cancel-1",
    });
    expect(cancelled.contract.status).toBe("cancelled");
    expect(ledger.reconcile().net).toBe(0);
  });

  it("archives closed contracts without breaking create idempotency", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 10_000, 0);
    ledger.ensureAccount("worker", 10, 0);
    const engine = new ContractEngine(ledger);
    const draft = {
      title: "Archive replay target",
      description: "This settled contract must survive as a tombstone.",
      predicate: { kind: "kill_count", targetTag: "skeleton", count: 1 } as const,
      reward: 25,
      mode: "bounty" as const,
      ttlTicks: 900,
    };
    const target = engine.create({
      issuerId: "issuer",
      draft,
      tick: 0,
      idempotencyKey: "archive-replay-target",
    }).contract;
    const kill = (seq: number) =>
      engine.applyEvent(
        { type: "death", tick: seq, victimTag: "skeleton", killerCommanderId: "worker" },
        seq,
        new Map(),
      );
    kill(1);
    for (let i = 0; i < 20; i++) {
      engine.create({
        issuerId: "issuer",
        draft: { ...draft, title: `Archive filler ${i}` },
        tick: i + 2,
        idempotencyKey: `archive-filler-${i}`,
      });
      kill(i + 2);
    }

    const archived = engine.takeArchiveBatch({
      keepClosed: 2,
      keepTombstones: 32,
      keepOperations: 32,
    });
    expect(archived.map((contract) => contract.id)).toContain(target.id);
    expect(engine.contracts.size).toBeLessThanOrEqual(2);
    expect(engine.takeArchiveBatch({ keepClosed: 2 })).toEqual([]);

    const removedLedgerEntries = ledger.takeCompactionBatch(8);
    expect(removedLedgerEntries.length).toBeGreaterThan(0);
    expect(ledger.entries.length).toBeLessThanOrEqual(8);
    expect(ledger.reconcile()).toMatchObject({
      retainedEntries: 8,
      archivedEntries: removedLedgerEntries.length,
      entries: 8 + removedLedgerEntries.length,
    });
    expect(engine.snapshots()).toHaveLength(21);
    expect(ledger.balance("worker")).toBe(10 + 21 * 25);

    const issuerBefore = ledger.balance("issuer");
    const replay = engine.create({
      issuerId: "issuer",
      draft,
      tick: 100,
      idempotencyKey: "archive-replay-target",
    });
    expect(replay.contract.id).toBe(target.id);
    expect(replay.contract.status).toBe("settled");
    expect(ledger.balance("issuer")).toBe(issuerBefore);
    expect(engine.contracts.size).toBeLessThanOrEqual(2);
  });

  it("fails closed when a create replay arrives after tombstone eviction", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 1000, 0);
    ledger.ensureAccount("worker", 10, 0);
    const engine = new ContractEngine(ledger);
    const draft = {
      title: "Evicted replay target",
      description: "A replay must never mint a replacement contract.",
      predicate: { kind: "kill_count", targetTag: "skeleton", count: 1 } as const,
      reward: 25,
      mode: "bounty" as const,
      ttlTicks: 900,
    };
    engine.create({
      issuerId: "issuer",
      draft,
      tick: 0,
      idempotencyKey: "evicted-replay-target",
    });
    engine.applyEvent(
      { type: "death", tick: 1, victimTag: "skeleton", killerCommanderId: "worker" },
      1,
      new Map(),
    );
    engine.takeArchiveBatch({
      keepClosed: 0,
      keepTombstones: 0,
      keepCreateOperations: 32,
    });
    const issuerBefore = ledger.balance("issuer");
    const workerBefore = ledger.balance("worker");
    expect(() =>
      engine.create({
        issuerId: "issuer",
        draft,
        tick: 10,
        idempotencyKey: "evicted-replay-target",
      }),
    ).toThrow("contract_operation_expired");
    expect(engine.contracts.size).toBe(0);
    expect(ledger.balance("issuer")).toBe(issuerBefore);
    expect(ledger.balance("worker")).toBe(workerBefore);

    engine.takeArchiveBatch({
      keepClosed: 0,
      keepTombstones: 0,
      keepCreateOperations: 0,
    });
    expect(() =>
      engine.create({
        issuerId: "issuer",
        draft,
        tick: 11,
        idempotencyKey: "evicted-replay-target",
      }),
    ).toThrow("contract_operation_expired");
    expect(engine.contracts.size).toBe(0);
    expect(ledger.balance("issuer")).toBe(issuerBefore);
    expect(ledger.balance("worker")).toBe(workerBefore);
  });

  it("reserves the viewer's just-settled contract and archives by close time", () => {
    const ledger = new Ledger();
    ledger.ensureAccount("issuer", 100_000, 0);
    ledger.ensureAccount("worker", 100_000, 0);
    const engine = new ContractEngine(ledger);
    const make = (
      issuerId: string,
      title: string,
      predicate:
        | { kind: "kill_entity"; entityId: string }
        | { kind: "kill_count"; targetTag: string; count: number },
      tick: number,
      key: string,
    ) =>
      engine.create({
        issuerId,
        draft: {
          title,
          description: "",
          predicate,
          reward: 10,
          mode: "bounty",
          ttlTicks: 10_000,
        },
        tick,
        idempotencyKey: key,
      }).contract;
    const oldTarget = make(
      "issuer",
      "Old long-lived target",
      { kind: "kill_entity", entityId: "old-target" },
      0,
      "window-old-target",
    );
    for (let i = 0; i < 16; i++) {
      make(
        "worker",
        `Worker live ${i}`,
        { kind: "kill_count", targetTag: "skeleton", count: 999 },
        i + 1,
        `window-worker-live-${i}`,
      );
    }
    for (let i = 0; i < 20; i++) {
      make(
        "issuer",
        `Issuer live ${i}`,
        { kind: "kill_count", targetTag: "skeleton", count: 999 },
        i + 17,
        `window-issuer-live-${i}`,
      );
    }
    const shortClosed = make(
      "issuer",
      "Short closed",
      { kind: "kill_entity", entityId: "short-target" },
      50,
      "window-short-closed",
    );
    const killEntity = (entityId: string, tick: number) =>
      engine.applyEvent(
        { type: "death", tick, victimId: entityId, killerCommanderId: "worker" },
        tick,
        new Map(),
      );
    killEntity("short-target", 51);
    killEntity("old-target", 100);

    const window = engine.snapshotWindow({ commanderId: "worker", accountId: "worker" });
    const includedOld = window.find((contract) => contract.id === oldTarget.id);
    expect(includedOld).toBeDefined();
    expect(includedOld?.closedAtTick).toBe(100);
    const archived = engine.takeArchiveBatch({ keepClosed: 1 });
    expect(archived.map((contract) => contract.id)).toContain(shortClosed.id);
    expect(archived.map((contract) => contract.id)).not.toContain(oldTarget.id);
    expect(engine.contracts.has(oldTarget.id)).toBe(true);
  });
});

describe("levels, drafts, drops, and new spells", () => {
  function killBossFor(world: SimWorld, killerId: string): void {
    const boss = world.entities.get("boss-bone-choir")!;
    boss.lastAttackerCommanderId = killerId;
    boss.hp = 0;
    world.step();
  }

  function clearOwnUnits(world: SimWorld, ownerId: string): void {
    for (const e of [...world.entities.values()]) {
      if (e.ownerId === ownerId) world.entities.delete(e.id);
    }
  }

  it("grants XP, levels up, and lets a human pick from three offered boons", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Hero", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    killBossFor(world, "cmdr-1");
    expect(commander.level).toBe(2);
    expect(commander.pendingDrafts).toBe(1);
    expect(commander.pendingUpgrades).toHaveLength(3);
    const unoffered = (["might", "swift", "brood", "magnet", "vitality", "arcane"] as const).find(
      (u) => !commander.pendingUpgrades.includes(u),
    )!;
    expect(world.applyCommand("cmdr-1", 1, { type: "chooseUpgrade", upgrade: unoffered })).toBe(
      "upgrade_not_offered",
    );
    const offered = commander.pendingUpgrades[0]!;
    expect(
      world.applyCommand("cmdr-1", 2, { type: "chooseUpgrade", upgrade: offered }),
    ).toBeUndefined();
    expect(commander.upgrades[offered]).toBe(1);
    expect(commander.pendingDrafts).toBe(0);
    expect(commander.pendingUpgrades).toHaveLength(0);
  });

  it("auto-picks an upgrade for bot commanders on level-up", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-9", accountId: "cmdr-9", name: "Bot", kind: "bot" });
    const bot = world.commanders.get("cmdr-9")!;
    killBossFor(world, "cmdr-9");
    expect(bot.level).toBe(2);
    expect(bot.pendingDrafts).toBe(0);
    const total = Object.values(bot.upgrades).reduce((a, b) => a + (b ?? 0), 0);
    expect(total).toBe(1);
  });

  it("drops frenzy and a blood vial from the boss", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Hero", kind: "human" });
    killBossFor(world, "cmdr-1");
    const kinds = [...world.pickups.values()].map((p) => p.templateId);
    expect(kinds).toContain("frenzy");
    expect(kinds).toContain("vial");
  });

  it("frost nova damages and slows a monster next to the caster", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Frost", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    clearOwnUnits(world, "cmdr-1");
    const skeleton = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    commander.x = skeleton.x;
    commander.y = skeleton.y;
    commander.target = { x: commander.x, y: commander.y };
    expect(
      world.applyCommand("cmdr-1", 1, {
        type: "cast",
        spell: "frost",
        target: { x: commander.x, y: commander.y },
      }),
    ).toBeUndefined();
    world.step();
    expect(skeleton.hp).toBeLessThan(skeleton.maxHp);
    expect(skeleton.slowUntil ?? 0).toBeGreaterThan(world.tick);
  });

  it("rejects targeted casts beyond range or without line of sight before spending command", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Range", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    commander.command = 100;
    const beforeCommand = commander.command;
    const farTarget = {
      x: commander.x + world.map.tileSize * 40,
      y: commander.y + world.map.tileSize * 40,
    };
    expect(
      world.applyCommand("cmdr-1", 1, { type: "cast", spell: "nova", target: farTarget }),
    ).toBe("cast_out_of_range");
    expect(commander.command).toBe(beforeCommand);
    expect(commander.spellReadyAt.nova).toBe(0);

    const crypt = world.map.rooms.find((room) => room.id === "crypt-south")!;
    const blockedTarget = {
      x: (crypt.x + crypt.w / 2) * world.map.tileSize,
      y: (crypt.y + crypt.h / 2) * world.map.tileSize,
    };
    expect(
      world.applyCommand("cmdr-1", 2, { type: "cast", spell: "volley", target: blockedTarget }),
    ).toBe("cast_no_line_of_sight");
    expect(commander.command).toBe(beforeCommand);
    expect(commander.spellReadyAt.volley).toBe(0);
  });

  it("chain lightning hops across three clustered skeletons with falloff", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Zap", kind: "human" });
    clearOwnUnits(world, "cmdr-1");
    const skeletons = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 3);
    expect(skeletons).toHaveLength(3);
    const keep = new Set(skeletons.map((s) => s.id));
    for (const e of [...world.entities.values()]) {
      if (e.kind === "monster" && !keep.has(e.id)) world.entities.delete(e.id);
    }
    const [m1, m2, m3] = skeletons as [
      (typeof skeletons)[number],
      (typeof skeletons)[number],
      (typeof skeletons)[number],
    ];
    m2.x = m1.x + 90;
    m2.y = m1.y;
    m3.x = m1.x + 180;
    m3.y = m1.y;
    const caster = world.commanders.get("cmdr-1")!;
    caster.x = m1.x - 100;
    caster.y = m1.y;
    caster.target = { x: caster.x, y: caster.y };
    caster.trail = [{ x: caster.x, y: caster.y }];
    expect(
      world.applyCommand("cmdr-1", 1, {
        type: "cast",
        spell: "chain",
        target: { x: m1.x, y: m1.y },
      }),
    ).toBeUndefined();
    world.step();
    expect(m1.hp).toBeLessThan(m1.maxHp);
    expect(m2.hp).toBeLessThan(m2.maxHp);
    expect(m3.hp).toBeLessThan(m3.maxHp);
    expect(m1.hp).toBeLessThan(m2.hp);
    expect(m2.hp).toBeLessThan(m3.hp);
    const fx = world.chainEffects();
    expect(fx).toHaveLength(1);
    expect(fx[0]!.kind).toBe("chain");
    expect(fx[0]!.points).toHaveLength(4);
  });

  it("warlock Hex Chain costs less, cools down faster, and hops to a fifth target", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-hex",
      accountId: "cmdr-hex",
      name: "Hex",
      kind: "human",
      character: "warlock",
    });
    const commander = world.commanders.get("cmdr-hex")!;
    clearOwnUnits(world, commander.id);
    const skeletons = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 5);
    expect(skeletons).toHaveLength(5);
    const keep = new Set(skeletons.map((s) => s.id));
    for (const e of [...world.entities.values()]) {
      if (e.kind === "monster" && !keep.has(e.id)) world.entities.delete(e.id);
    }
    skeletons.forEach((skeleton, i) => {
      skeleton.x = skeletons[0]!.x + i * 90;
      skeleton.y = skeletons[0]!.y;
    });
    commander.x = skeletons[0]!.x - 100;
    commander.y = skeletons[0]!.y;
    commander.target = { x: commander.x, y: commander.y };
    commander.trail = [{ x: commander.x, y: commander.y }];
    commander.command = 32;
    expect(
      world.applyCommand(commander.id, 1, {
        type: "cast",
        spell: "chain",
        target: { x: skeletons[0]!.x, y: skeletons[0]!.y },
      }),
    ).toBeUndefined();
    expect(commander.command).toBe(0);
    expect(commander.spellReadyAt.chain).toBe(world.tick + 120);
    world.step();
    for (const skeleton of skeletons) expect(skeleton.hp).toBeLessThan(skeleton.maxHp);
    expect(world.chainEffects()[0]!.points).toHaveLength(6);
  });

  it("collecting a frenzy idol sets frenzyUntil", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Fast", kind: "human" });
    const commander = world.commanders.get("cmdr-1")!;
    world.pickups.set("pickup-test", {
      id: "pickup-test",
      templateId: "frenzy",
      x: commander.x,
      y: commander.y,
    });
    world.step();
    expect(commander.frenzyUntil).toBeGreaterThan(world.tick);
    expect(world.pickups.has("pickup-test")).toBe(false);
  });

  it("death clears level progress and any pending draft", () => {
    const world = new SimWorld(42);
    world.spawnCommander({ id: "cmdr-1", accountId: "cmdr-1", name: "Doomed", kind: "human" });
    world.spawnCommander({ id: "cmdr-2", accountId: "cmdr-2", name: "Slayer", kind: "human" });
    clearOwnUnits(world, "cmdr-1");
    clearOwnUnits(world, "cmdr-2");
    const doomed = world.commanders.get("cmdr-1")!;
    const slayer = world.commanders.get("cmdr-2")!;
    killBossFor(world, "cmdr-1");
    expect(doomed.level).toBe(2);
    expect(doomed.pendingUpgrades).toHaveLength(3);
    const skeleton = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    doomed.x = skeleton.x;
    doomed.y = skeleton.y;
    doomed.hp = 10;
    doomed.spawnedAtTick = -1000;
    slayer.x = skeleton.x + 20;
    slayer.y = skeleton.y;
    expect(
      world.applyCommand("cmdr-2", 1, {
        type: "cast",
        spell: "nova",
        target: { x: doomed.x, y: doomed.y },
      }),
    ).toBeUndefined();
    world.step();
    expect(doomed.alive).toBe(false);
    expect(doomed.level).toBe(1);
    expect(doomed.pendingDrafts).toBe(0);
    expect(doomed.pendingUpgrades).toHaveLength(0);
    expect(
      world.commanderSnapshots().find((c) => c.id === "cmdr-1")?.pendingUpgrades,
    ).toBeUndefined();
  });
});

describe("character classes and bolts", () => {
  function toArena(world: SimWorld, commanderId: string) {
    const commander = world.commanders.get(commanderId)!;
    const tile = world.map.tileSize;
    const arena = world.map.rooms.find((r) => r.id === "arena")!;
    commander.x = (arena.x + arena.w / 2) * tile;
    commander.y = (arena.y + arena.h / 2) * tile;
    commander.target = { x: commander.x, y: commander.y };
    commander.path = [];
    commander.trail = [{ x: commander.x, y: commander.y }];
    return commander;
  }

  it("applies class maxHp and unitHp modifiers at spawn", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-10",
      accountId: "cmdr-10",
      name: "Necro",
      kind: "human",
      character: "necromancer",
    });
    world.spawnCommander({
      id: "cmdr-11",
      accountId: "cmdr-11",
      name: "Hex",
      kind: "human",
      character: "warlock",
    });
    world.spawnCommander({
      id: "cmdr-12",
      accountId: "cmdr-12",
      name: "Bone",
      kind: "human",
      character: "boneknight",
    });
    expect(world.commanders.get("cmdr-10")!.maxHp).toBe(COMMANDER.maxHp);
    expect(world.commanders.get("cmdr-11")!.maxHp).toBe(90);
    expect(world.commanders.get("cmdr-12")!.maxHp).toBe(170);
    const boneUnit = [...world.entities.values()].find((e) => e.ownerId === "cmdr-12")!;
    expect(boneUnit.maxHp).toBe(Math.round(UNIT.maxHp * 1.3));
    expect(world.commanderSnapshots().find((c) => c.id === "cmdr-11")?.character).toBe("warlock");
  });

  it("spawns each class with its starter weapon and swarm cap", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-10",
      accountId: "cmdr-10",
      name: "Necro",
      kind: "human",
      character: "necromancer",
    });
    world.spawnCommander({
      id: "cmdr-11",
      accountId: "cmdr-11",
      name: "Hex",
      kind: "human",
      character: "warlock",
    });
    world.spawnCommander({
      id: "cmdr-12",
      accountId: "cmdr-12",
      name: "Bone",
      kind: "human",
      character: "boneknight",
    });
    const necro = world.commanders.get("cmdr-10")!;
    const warlock = world.commanders.get("cmdr-11")!;
    const bone = world.commanders.get("cmdr-12")!;
    expect(necro.weapons).toEqual(["bolt", "wisp"]);
    expect(necro.weapon).toBe("wisp");
    expect(warlock.weapons).toEqual(["bolt", "lance"]);
    expect(warlock.weapon).toBe("lance");
    expect(bone.weapons).toEqual(["bolt", "scythe"]);
    expect(bone.weapon).toBe("scythe");
    const unitCount = (ownerId: string) =>
      [...world.entities.values()].filter((e) => e.ownerId === ownerId).length;
    expect(unitCount(necro.id)).toBe(UNIT.countPerCommander + 4);
    expect(unitCount(warlock.id)).toBe(UNIT.countPerCommander);
    expect(unitCount(bone.id)).toBe(UNIT.countPerCommander);
  });

  it("necromancer Grave Nova raises a replacement when it hits", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-10",
      accountId: "cmdr-10",
      name: "Necro",
      kind: "human",
      character: "necromancer",
    });
    const commander = toArena(world, "cmdr-10");
    const missing = [...world.entities.values()].find((e) => e.ownerId === commander.id)!;
    world.entities.delete(missing.id);
    const skeleton = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    for (const e of world.entities.values()) {
      if (e.kind === "monster" && e.id !== skeleton.id) e.hp = 0;
    }
    skeleton.x = commander.x + 40;
    skeleton.y = commander.y;
    expect(
      world.applyCommand(commander.id, 1, {
        type: "cast",
        spell: "nova",
        target: { x: skeleton.x, y: skeleton.y },
      }),
    ).toBeUndefined();
    world.step();
    expect(skeleton.hp).toBeLessThan(skeleton.maxHp);
    expect(
      [...world.entities.values()].filter((e) => e.ownerId === commander.id && e.hp > 0),
    ).toHaveLength(UNIT.countPerCommander + 4);
  });

  it("bone knight nearby swarm takes reduced damage", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-12",
      accountId: "cmdr-12",
      name: "Bone",
      kind: "human",
      character: "boneknight",
    });
    world.spawnCommander({
      id: "cmdr-99",
      accountId: "cmdr-99",
      name: "Enemy",
      kind: "human",
      character: "necromancer",
    });
    const commander = toArena(world, "cmdr-12");
    commander.spawnedAtTick = world.tick - 500;
    const unit = [...world.entities.values()].find((e) => e.ownerId === commander.id)!;
    for (const e of world.entities.values()) {
      if (e.kind === "monster" || e.ownerId === "cmdr-99") e.hp = 0;
      if (e.ownerId === commander.id && e.id !== unit.id) e.hp = 0;
    }
    unit.x = commander.x + 100;
    unit.y = commander.y;
    unit.hp = unit.maxHp;
    const enemy = toArena(world, "cmdr-99");
    enemy.x = unit.x - 100;
    enemy.y = unit.y;
    enemy.target = { x: enemy.x, y: enemy.y };
    enemy.trail = [{ x: enemy.x, y: enemy.y }];
    expect(
      world.applyCommand("cmdr-99", 1, {
        type: "cast",
        spell: "volley",
        target: { x: unit.x, y: unit.y },
      }),
    ).toBeUndefined();
    world.step();
    expect(unit.hp).toBeCloseTo(unit.maxHp - 18 * 0.8, 4);
  });

  it("keeps vitality out of the class multiplier and resyncs on respawn", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-12",
      accountId: "cmdr-12",
      name: "Bone",
      kind: "human",
      restore: {
        x: 0,
        y: 0,
        hp: 220,
        essence: 0,
        alive: true,
        unitCount: UNIT.countPerCommander,
        level: 3,
        xp: 0,
        upgrades: { vitality: 2 },
        character: "boneknight",
      },
    });
    const commander = world.commanders.get("cmdr-12")!;
    expect(commander.maxHp).toBe(220);
    commander.hp = 0;
    commander.alive = false;
    commander.respawnAtTick = world.tick + 2;
    world.step();
    world.step();
    world.step();
    expect(commander.alive).toBe(true);
    expect(commander.maxHp).toBe(170);
    expect(commander.hp).toBe(170);
    expect(commander.upgrades).toEqual({});
  });

  it("fires a bolt that hits for class-scaled spell damage; entry room blocks firing", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-11",
      accountId: "cmdr-11",
      name: "Hex",
      kind: "human",
      character: "warlock",
    });
    const commander = world.commanders.get("cmdr-11")!;
    commander.weapon = "bolt";
    expect(
      world.applyCommand("cmdr-11", 1, {
        type: "shoot",
        target: { x: commander.x + 200, y: commander.y },
      }),
    ).toBeUndefined();
    expect(world.projectiles.size).toBe(0);
    toArena(world, "cmdr-11");
    const monster = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    for (const e of world.entities.values()) {
      if (e.ownerId === commander.id) e.hp = 0;
      if (e.kind === "monster" && e.id !== monster.id) e.hp = 0;
    }
    monster.x = commander.x + 130;
    monster.y = commander.y;
    const hpBefore = monster.hp;
    expect(
      world.applyCommand("cmdr-11", 2, {
        type: "shoot",
        target: { x: monster.x, y: monster.y },
      }),
    ).toBeUndefined();
    expect(world.projectiles.size).toBe(1);
    for (let i = 0; i < 25 && monster.hp === hpBefore; i++) world.step();
    expect(monster.hp).toBeCloseTo(hpBefore - BOLT.damage * 1.3, 4);
  });

  it("rate-limits bolts to the configured cooldown", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-10",
      accountId: "cmdr-10",
      name: "Necro",
      kind: "human",
      character: "necromancer",
    });
    const commander = toArena(world, "cmdr-10");
    commander.weapon = "bolt";
    for (const e of world.entities.values()) {
      if (e.ownerId === commander.id || e.kind === "monster") e.hp = 0;
    }
    const target = { x: commander.x + 400, y: commander.y };
    world.applyCommand("cmdr-10", 1, { type: "shoot", target });
    world.applyCommand("cmdr-10", 2, { type: "shoot", target });
    expect(world.projectiles.size).toBe(1);
    for (let i = 0; i < BOLT.cooldownTicks; i++) world.step();
    world.applyCommand("cmdr-10", 3, { type: "shoot", target });
    expect(world.projectiles.size).toBe(2);
  });

  it("regenerates command faster for warlocks", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-10",
      accountId: "cmdr-10",
      name: "Necro",
      kind: "human",
      character: "necromancer",
    });
    world.spawnCommander({
      id: "cmdr-11",
      accountId: "cmdr-11",
      name: "Hex",
      kind: "human",
      character: "warlock",
    });
    const necro = world.commanders.get("cmdr-10")!;
    const hex = world.commanders.get("cmdr-11")!;
    necro.command = 0;
    hex.command = 0;
    for (let i = 0; i < 30; i++) world.step();
    expect(necro.command).toBeGreaterThan(0);
    expect(hex.command).toBeCloseTo(necro.command * 1.6, 4);
  });

  it("migrates legacy checkpoints without a stored class", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-8",
      accountId: "cmdr-8",
      name: "Legacy",
      kind: "human",
      character: "necromancer",
    });
    const data = world.serialize();
    for (const c of data.commanders) {
      delete (c as { character?: unknown }).character;
      delete (c as { nextShotAt?: unknown }).nextShotAt;
    }
    const restored = SimWorld.restore(data);
    const commander = restored.commanders.get("cmdr-8")!;
    expect(commander.character).toBe("boneknight");
    expect(commander.maxHp).toBe(170);
    expect(commander.hp).toBe(120);
    expect(commander.nextShotAt).toBe(0);
  });
});

describe("steer and weapons", () => {
  function toArena(world: SimWorld, commanderId: string) {
    const commander = world.commanders.get(commanderId)!;
    const tile = world.map.tileSize;
    const arena = world.map.rooms.find((r) => r.id === "arena")!;
    commander.x = (arena.x + arena.w / 2) * tile;
    commander.y = (arena.y + arena.h / 2) * tile;
    commander.target = { x: commander.x, y: commander.y };
    commander.path = [];
    commander.trail = [{ x: commander.x, y: commander.y }];
    return commander;
  }

  function spawnTwin(world: SimWorld, id = "cmdr-20") {
    world.spawnCommander({
      id,
      accountId: id,
      name: "Twin",
      kind: "human",
      character: "necromancer",
    });
    return toArena(world, id);
  }

  function clearField(world: SimWorld, commanderId: string) {
    for (const e of world.entities.values()) {
      if (e.ownerId === commanderId || e.kind === "monster") e.hp = 0;
    }
  }

  it("steer moves the commander directly and expires without a heartbeat", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    const startX = commander.x;
    let seq = 0;
    for (let i = 0; i < 24; i++) {
      if (i % 4 === 0) {
        expect(world.applyCommand(commander.id, ++seq, { type: "steer", dx: 1, dy: 0 })).toBe(
          undefined,
        );
      }
      world.step();
    }
    expect(commander.x).toBeGreaterThan(startX + 25);
    for (let i = 0; i < 20; i++) world.step();
    const stoppedX = commander.x;
    for (let i = 0; i < 10; i++) world.step();
    expect(Math.abs(commander.x - stoppedX)).toBeLessThan(2);
  });

  it("steer does not cancel an existing swarm order", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    expect(
      world.applyCommand(commander.id, 1, {
        type: "defend",
        target: { x: commander.x + 180, y: commander.y },
      }),
    ).toBeUndefined();
    expect(commander.stance).toBe("defend");
    const targetBefore = { ...commander.target };
    const pathBefore = commander.path.length;
    expect(world.applyCommand(commander.id, 2, { type: "steer", dx: -1, dy: 0 })).toBeUndefined();
    world.step();
    expect(commander.stance).toBe("defend");
    expect(commander.target).toEqual(targetBefore);
    expect(commander.path.length).toBe(pathBefore);
  });

  it("death resets unlocked weapons to the class starter kit", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    commander.weapons = ["bolt", "lance"];
    commander.weapon = "lance";
    commander.upgrades = { lance: 1 };
    commander.hp = 0;
    commander.alive = false;
    commander.respawnAtTick = world.tick + 2;
    world.step();
    world.step();
    world.step();
    expect(commander.alive).toBe(true);
    expect(commander.weapons).toEqual(["bolt", "wisp"]);
    expect(commander.weapon).toBe("wisp");
  });

  it("spends essence to field-raise a replacement below the swarm cap", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    const owned = () =>
      [...world.entities.values()].filter((e) => e.ownerId === commander.id).length;
    expect(world.applyCommand(commander.id, 1, { type: "raiseUnit" })).toBe("swarm_at_cap");
    const first = [...world.entities.values()].find((e) => e.ownerId === commander.id)!;
    world.entities.delete(first.id);
    commander.essence = 3;
    expect(world.applyCommand(commander.id, 2, { type: "raiseUnit" })).toBe("insufficient_essence");
    commander.essence = 4;
    expect(world.applyCommand(commander.id, 3, { type: "raiseUnit" })).toBeUndefined();
    expect(commander.essence).toBe(0);
    expect(owned()).toBe(UNIT.countPerCommander + 4);
    const second = [...world.entities.values()].find((e) => e.ownerId === commander.id)!;
    world.entities.delete(second.id);
    commander.essence = 8;
    expect(world.applyCommand(commander.id, 4, { type: "raiseUnit" })).toBe("raise_on_cooldown");
    commander.x = 144;
    commander.y = 592;
    commander.target = { x: commander.x, y: commander.y };
    commander.path = [];
    commander.trail = [{ x: commander.x, y: commander.y }];
    expect(world.applyCommand(commander.id, 5, { type: "raiseUnit" })).toBe(
      "sanctuary_regrows_free",
    );
  });

  it("rejects switching to an unowned weapon", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    expect(world.applyCommand(commander.id, 1, { type: "switchWeapon", weapon: "lance" })).toBe(
      "weapon_not_owned",
    );
    expect(commander.weapon).toBe("wisp");
    expect(commander.weapons).toEqual(["bolt", "wisp"]);
  });

  it("draft-picked Scatter Wand auto-equips and fires 3 pellets", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.pendingDrafts = 1;
    commander.pendingUpgrades = ["scatter", "might", "swift"];
    expect(
      world.applyCommand(commander.id, 1, { type: "chooseUpgrade", upgrade: "scatter" }),
    ).toBeUndefined();
    expect(commander.weapons).toEqual(["bolt", "wisp", "scatter"]);
    expect(commander.weapon).toBe("scatter");
    expect(world.commanderSnapshots().find((c) => c.id === commander.id)?.weapon).toBe("scatter");
    expect(
      world.applyCommand(commander.id, 2, {
        type: "shoot",
        target: { x: commander.x + 200, y: commander.y },
      }),
    ).toBeUndefined();
    expect(world.projectiles.size).toBe(3);
    expect(
      world.applyCommand(commander.id, 3, { type: "switchWeapon", weapon: "bolt" }),
    ).toBeUndefined();
    expect(commander.weapon).toBe("bolt");
  });

  it("Soul Lance pierces four skeletons in a line and stops before the fifth", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    commander.pendingDrafts = 1;
    commander.pendingUpgrades = ["lance", "might", "swift"];
    expect(
      world.applyCommand(commander.id, 1, { type: "chooseUpgrade", upgrade: "lance" }),
    ).toBeUndefined();
    const line = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 5);
    expect(line).toHaveLength(5);
    const keep = new Set(line.map((s) => s.id));
    for (const e of world.entities.values()) {
      if (e.ownerId === commander.id) e.hp = 0;
      if (e.kind === "monster" && !keep.has(e.id)) e.hp = 0;
    }
    line.forEach((s, i) => {
      s.x = commander.x + 60 + i * 36;
      s.y = commander.y;
    });
    const hps = line.map((s) => s.hp);
    expect(
      world.applyCommand(commander.id, 2, {
        type: "shoot",
        target: { x: line[4]!.x, y: line[4]!.y },
      }),
    ).toBeUndefined();
    for (let i = 0; i < 25; i++) {
      line.forEach((s, j) => {
        s.x = commander.x + 60 + j * 36;
        s.y = commander.y;
      });
      world.step();
    }
    for (let i = 0; i < 4; i++) expect(line[i]!.hp).toBeCloseTo(hps[i]! - 11, 4);
    expect(line[4]!.hp).toBe(hps[4]);
  });

  it("drafts never offer a weapon the commander already owns", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.weapons = ["bolt", "scatter"];
    commander.weapon = "scatter";
    const offered = new Set<string>();
    for (let i = 0; i < 40; i++) {
      commander.pendingUpgrades = [];
      commander.pendingDrafts = 1;
      world.step();
      for (const u of commander.pendingUpgrades) offered.add(u);
    }
    expect(offered.has("scatter")).toBe(false);
    expect(offered.size).toBeGreaterThan(3);
  });

  it("preserves weapons across serialize, and migrates legacy saves", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world, "cmdr-21");
    commander.weapons = ["bolt", "lance"];
    commander.weapon = "lance";
    commander.upgrades = { lance: 1 };
    const restored = SimWorld.restore(world.serialize());
    expect(restored.commanders.get("cmdr-21")!.weapons).toEqual(["bolt", "wisp", "lance"]);
    expect(restored.commanders.get("cmdr-21")!.weapon).toBe("lance");

    const legacy = world.serialize();
    for (const c of legacy.commanders) {
      delete (c as { weapons?: unknown }).weapons;
      delete (c as { weapon?: unknown }).weapon;
      delete (c as { steerX?: unknown }).steerX;
    }
    const migrated = SimWorld.restore(legacy).commanders.get("cmdr-21")!;
    expect(migrated.weapons).toEqual(["bolt", "wisp", "lance"]);
    expect(migrated.weapon).toBe("wisp");
    expect(migrated.steerX).toBe(0);
  });

  it("commander accelerates to full steer speed and coasts to a stop", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    const startX = commander.x;
    let seq = 0;
    const steerEast = () =>
      world.applyCommand(commander.id, ++seq, { type: "steer", dx: 1, dy: 0 });
    steerEast();
    for (let i = 0; i < 3; i++) world.step();
    expect(commander.x - startX).toBeGreaterThan(3);
    expect(commander.x - startX).toBeLessThan(14);
    let windowStartX = 0;
    for (let i = 3; i < 24; i++) {
      if (i % 4 === 0) steerEast();
      world.step();
      if (i === 13) windowStartX = commander.x;
    }
    const steadySpeed = (commander.x - windowStartX) / (10 / 30);
    expect(steadySpeed).toBeGreaterThan(165);
    expect(steadySpeed).toBeLessThan(215);
    expect(commander.vx).toBeGreaterThan(175);
    expect(
      world.applyCommand(commander.id, ++seq, { type: "steer", dx: 0, dy: 0 }),
    ).toBeUndefined();
    const releaseX = commander.x;
    const coastXs = [releaseX];
    for (let i = 0; i < 34; i++) {
      world.step();
      coastXs.push(commander.x);
    }
    const coastPeak = Math.max(...coastXs);
    expect(coastPeak - releaseX).toBeGreaterThan(3);
    expect(coastPeak - releaseX).toBeLessThan(20);
    expect(commander.x).toBeGreaterThanOrEqual(coastPeak - 0.5);
    expect(commander.vx).toBe(0);
  });

  it("releasing steer while wall-pinned does not walk back to the stale target", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    let seq = 0;
    const steerEast = () =>
      world.applyCommand(commander.id, ++seq, { type: "steer", dx: 1, dy: 0 });
    steerEast();
    // With 3-tile corridors the eastward run now continues into extraction;
    // steer until actually wall-pinned instead of assuming the old wall at 90 ticks.
    const startX = commander.x;
    for (let i = 0; i < 600; i++) {
      if (i % 4 === 0) steerEast();
      world.step();
      if (i > 60 && commander.vx === 0 && commander.x > startX + 100) break;
    }
    expect(commander.vx).toBe(0);
    expect(
      world.applyCommand(commander.id, ++seq, { type: "steer", dx: 0, dy: 0 }),
    ).toBeUndefined();
    const pinnedX = commander.x;
    for (let i = 0; i < 30; i++) world.step();
    expect(Math.abs(commander.x - pinnedX)).toBeLessThanOrEqual(1);
  });

  it("PvP grace blocks commander-sourced damage for 8s after spawn, then expires", () => {
    const world = new SimWorld(42);
    const fresh = spawnTwin(world, "cmdr-30");
    const enemy = spawnTwin(world, "cmdr-31");
    enemy.weapon = "bolt";
    enemy.x = fresh.x - 100;
    enemy.y = fresh.y;
    enemy.target = { x: enemy.x, y: enemy.y };
    enemy.path = [];
    enemy.trail = [{ x: enemy.x, y: enemy.y }];
    clearField(world, fresh.id);
    clearField(world, enemy.id);
    const freshSnap = world.commanderSnapshots().find((c) => c.id === fresh.id);
    expect(freshSnap?.pvpGrace).toBe(true);
    expect(freshSnap?.pvpGraceTicks).toBeGreaterThan(0);
    expect(freshSnap?.pvpGraceTicks).toBeLessThanOrEqual(240);
    expect(
      world.applyCommand(enemy.id, 1, {
        type: "shoot",
        target: { x: fresh.x, y: fresh.y },
      }),
    ).toBeUndefined();
    const events = Array.from({ length: 12 }, () => world.step()).flat();
    expect(events.some((e) => e.type === "damage" && e.targetId === fresh.id && e.blocked)).toBe(
      true,
    );
    expect(world.commanderSnapshots().find((c) => c.id === enemy.id)?.pvpGrace).toBeUndefined();
    expect(fresh.hp).toBe(fresh.maxHp);
    fresh.spawnedAtTick = world.tick - 500;
    enemy.nextShotAt = 0;
    expect(
      world.applyCommand(enemy.id, 2, {
        type: "shoot",
        target: { x: fresh.x, y: fresh.y },
      }),
    ).toBeUndefined();
    for (let i = 0; i < 12; i++) world.step();
    expect(fresh.hp).toBeCloseTo(fresh.maxHp - BOLT.damage, 4);
  });

  it("PvP grace holds while inside Sanctuary and counts down only after exit", () => {
    const world = new SimWorld(42);
    const fresh = spawnTwin(world, "cmdr-40");
    clearField(world, fresh.id);
    fresh.x = 144;
    fresh.y = 592;
    fresh.target = { x: 144, y: 592 };
    fresh.path = [];
    fresh.trail = [{ x: 144, y: 592 }];
    fresh.spawnedAtTick = world.tick;
    for (let i = 0; i < 300; i++) world.step();
    expect(world.commanderSnapshots().find((c) => c.id === fresh.id)?.pvpGrace).toBe(true);
    fresh.x = 960;
    fresh.y = 520;
    fresh.target = { x: 960, y: 520 };
    fresh.path = [];
    fresh.trail = [{ x: 960, y: 520 }];
    fresh.hp = fresh.maxHp;
    for (let chunk = 0; chunk < 6; chunk++) {
      clearField(world, fresh.id);
      for (let i = 0; i < 50; i++) world.step();
      fresh.hp = fresh.maxHp;
    }
    expect(world.commanderSnapshots().find((c) => c.id === fresh.id)?.pvpGrace).toBeUndefined();
  });

  it("holding east from spawn exits the Sanctuary through the corridor", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-41",
      accountId: "cmdr-41",
      name: "Exiter",
      kind: "human",
      character: "necromancer",
    });
    const commander = world.commanders.get("cmdr-41")!;
    clearField(world, commander.id);
    let seq = 0;
    for (let i = 0; i < 240; i++) {
      if (i % 4 === 0) {
        expect(
          world.applyCommand(commander.id, ++seq, { type: "steer", dx: 1, dy: 0 }),
        ).toBeUndefined();
      }
      world.step();
    }
    expect(commander.x).toBeGreaterThan(500);
  });

  it("monsters do not aggro commanders hugging the Sanctuary doorway", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-32",
      accountId: "cmdr-32",
      name: "Door",
      kind: "human",
      character: "necromancer",
    });
    const commander = world.commanders.get("cmdr-32")!;
    commander.x = world.entryRect.x + world.entryRect.w + 30;
    commander.target = { x: commander.x, y: commander.y };
    commander.path = [];
    commander.trail = [{ x: commander.x, y: commander.y }];
    const skeleton = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    for (const e of world.entities.values()) {
      if (e.ownerId === commander.id) e.hp = 0;
      if (e.kind === "monster" && e.id !== skeleton.id) e.hp = 0;
    }
    skeleton.x = commander.x + 70;
    skeleton.y = commander.y;
    skeleton.homeX = skeleton.x;
    skeleton.homeY = skeleton.y;
    for (let i = 0; i < 30; i++) world.step();
    expect(commander.hp).toBe(commander.maxHp);
  });

  it("ambient bots stop gaining XP at level 3", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-33",
      accountId: "cmdr-33",
      name: "Botty",
      kind: "bot",
      character: "necromancer",
    });
    const bot = toArena(world, "cmdr-33");
    bot.level = 2;
    bot.xp = xpForLevel(2) - 1;
    const skeletons = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 2);
    expect(skeletons).toHaveLength(2);
    const keep = new Set(skeletons.map((s) => s.id));
    for (const e of world.entities.values()) {
      if (e.ownerId === bot.id) e.hp = 0;
      if (e.kind === "monster" && !keep.has(e.id)) e.hp = 0;
    }
    let seq = 0;
    const kill = (s: (typeof skeletons)[number]) => {
      s.x = bot.x + 90;
      s.y = bot.y;
      s.hp = 1;
      bot.nextShotAt = 0;
      expect(
        world.applyCommand(bot.id, ++seq, { type: "shoot", target: { x: s.x, y: s.y } }),
      ).toBeUndefined();
      for (let i = 0; i < 12; i++) world.step();
      expect(s.hp).toBeLessThanOrEqual(0);
    };
    kill(skeletons[0]!);
    expect(bot.level).toBe(3);
    kill(skeletons[1]!);
    expect(bot.level).toBe(3);
    expect(bot.xp).toBe(0);
  });

  it("RMB cohesion speed changes continuously near the old step threshold", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    for (const e of world.entities.values()) {
      if (e.kind === "monster") e.hp = 0;
    }
    expect(
      world.applyCommand(commander.id, 1, {
        type: "move",
        target: { x: commander.x + 180, y: commander.y },
      }),
    ).toBeUndefined();
    const speeds: number[] = [];
    for (let i = 0; i < 16; i++) {
      for (const e of world.entities.values()) {
        if (e.ownerId === commander.id && e.hp > 0) {
          e.x = commander.x - 150;
          e.y = commander.y;
        }
      }
      world.step();
      speeds.push(commander.vx);
    }
    expect(Math.min(...speeds.slice(8))).toBeGreaterThan(125);
    expect(Math.max(...speeds.slice(8))).toBeLessThan(180);
  });

  it("grace reduces PvP damage to units and ends when its owner attacks", () => {
    const world = new SimWorld(42);
    const fresh = spawnTwin(world, "cmdr-34");
    const enemy = spawnTwin(world, "cmdr-35");
    enemy.x = fresh.x - 100;
    enemy.y = fresh.y;
    enemy.target = { x: enemy.x, y: enemy.y };
    enemy.path = [];
    enemy.trail = [{ x: enemy.x, y: enemy.y }];
    const freshUnit = [...world.entities.values()].find((e) => e.ownerId === fresh.id)!;
    const enemyUnit = [...world.entities.values()].find((e) => e.ownerId === enemy.id)!;
    for (const e of world.entities.values()) {
      if (e.kind === "monster") e.hp = 0;
      if (e.kind === "unit" && e.id !== freshUnit.id && e.id !== enemyUnit.id) e.hp = 0;
    }
    freshUnit.x = fresh.x;
    freshUnit.y = fresh.y;
    freshUnit.cooldown = 999;
    enemyUnit.x = freshUnit.x - 20;
    enemyUnit.y = freshUnit.y;
    enemyUnit.cooldown = 0;
    const hp = freshUnit.hp;
    world.step();
    expect(freshUnit.hp).toBeCloseTo(hp - UNIT.damage * 0.35, 4);
    expect(world.commanderSnapshots().find((c) => c.id === enemy.id)?.pvpGrace).toBeUndefined();
    fresh.nextShotAt = 0;
    expect(
      world.applyCommand(fresh.id, 1, {
        type: "shoot",
        target: { x: fresh.x + 100, y: fresh.y },
      }),
    ).toBeUndefined();
    expect(world.commanderSnapshots().find((c) => c.id === fresh.id)?.pvpGrace).toBeUndefined();
  });

  it("ambient bot units do not acquire victims inside the Sanctuary margin", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "cmdr-36",
      accountId: "cmdr-36",
      name: "HumanDoor",
      kind: "human",
      character: "necromancer",
    });
    world.spawnCommander({
      id: "cmdr-37",
      accountId: "cmdr-37",
      name: "BotDoor",
      kind: "bot",
      character: "necromancer",
    });
    const human = world.commanders.get("cmdr-36")!;
    const bot = world.commanders.get("cmdr-37")!;
    human.x = world.entryRect.x + world.entryRect.w + 30;
    human.target = { x: human.x, y: human.y };
    human.path = [];
    human.trail = [{ x: human.x, y: human.y }];
    bot.x = human.x + 70;
    bot.y = human.y;
    bot.target = { x: bot.x, y: bot.y };
    bot.path = [];
    bot.trail = [{ x: bot.x, y: bot.y }];
    const humanUnit = [...world.entities.values()].find((e) => e.ownerId === human.id)!;
    const botUnit = [...world.entities.values()].find((e) => e.ownerId === bot.id)!;
    for (const e of world.entities.values()) {
      if (e.kind === "monster") e.hp = 0;
      if (e.kind === "unit" && e.id !== humanUnit.id && e.id !== botUnit.id) e.hp = 0;
    }
    humanUnit.x = human.x;
    humanUnit.y = human.y;
    humanUnit.cooldown = 999;
    botUnit.x = humanUnit.x + 20;
    botUnit.y = humanUnit.y;
    botUnit.cooldown = 0;
    const hp = humanUnit.hp;
    for (let i = 0; i < 5; i++) world.step();
    expect(humanUnit.hp).toBe(hp);
  });

  it("Soul Orbit blades damage nearby enemies with a per-target rehit cooldown", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.weapons = ["bolt", "orbit"];
    commander.weapon = "orbit";
    const skeleton = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    skeleton.hp = 34;
    skeleton.homeX = commander.x + 72;
    skeleton.homeY = commander.y;
    for (let i = 0; i < 20; i++) {
      skeleton.x = commander.x + 72;
      skeleton.y = commander.y;
      world.step();
    }
    expect(skeleton.hp).toBeLessThan(34);
    expect(skeleton.hp).toBeGreaterThanOrEqual(34 - 18);
    expect(SimWorld.restore(world.serialize()).commanders.get(commander.id)!.orbitHits).toEqual({});
  });

  it("Wisp Swarm bolts home onto an off-axis target", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.weapons = ["bolt", "wisp"];
    commander.weapon = "wisp";
    const skeleton = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    skeleton.hp = 34;
    skeleton.homeX = commander.x + 150;
    skeleton.homeY = commander.y - 80;
    expect(
      world.applyCommand(commander.id, 1, {
        type: "shoot",
        target: { x: commander.x + 300, y: commander.y },
      }),
    ).toBeUndefined();
    for (let i = 0; i < 30; i++) {
      skeleton.x = commander.x + 150;
      skeleton.y = commander.y - 80;
      world.step();
    }
    expect(skeleton.hp).toBeLessThanOrEqual(34 - 6);
  });

  it("Grave Scythe slash cuts through multiple targets in a line", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.weapons = ["bolt", "scythe"];
    commander.weapon = "scythe";
    const pair = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 2);
    expect(pair).toHaveLength(2);
    const spots = [
      { x: commander.x + 60, y: commander.y - 15 },
      { x: commander.x + 85, y: commander.y + 15 },
    ];
    pair.forEach((s, i) => {
      s.hp = 34;
      s.homeX = spots[i]!.x;
      s.homeY = spots[i]!.y;
    });
    expect(
      world.applyCommand(commander.id, 1, {
        type: "shoot",
        target: { x: commander.x + 300, y: commander.y },
      }),
    ).toBeUndefined();
    for (let i = 0; i < 8; i++) {
      pair.forEach((s, j) => {
        s.x = spots[j]!.x;
        s.y = spots[j]!.y;
      });
      world.step();
    }
    for (const s of pair) expect(s.hp).toBeLessThanOrEqual(34 - 13);
  });

  it("evolution draft offers Storm Wand at 2 Arcane stacks and replaces the base weapon", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.weapons = ["bolt"];
    commander.upgrades = { arcane: 2 };
    const offered = new Set<string>();
    for (let i = 0; i < 40; i++) {
      commander.pendingUpgrades = [];
      commander.pendingDrafts = 1;
      world.step();
      for (const u of commander.pendingUpgrades) offered.add(u);
    }
    expect(offered.has("storm")).toBe(true);
    expect(offered.has("hellscatter")).toBe(false);
    commander.pendingDrafts = 1;
    commander.pendingUpgrades = ["storm"];
    expect(
      world.applyCommand(commander.id, 1, { type: "chooseUpgrade", upgrade: "storm" }),
    ).toBeUndefined();
    expect(commander.weapons).toEqual(["storm"]);
    expect(commander.weapon).toBe("storm");
  });

  it("expired draft auto-pick never equips a weapon the player did not choose", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.weapons = ["bolt"];
    commander.weapon = "bolt";
    commander.pendingDrafts = 1;
    commander.pendingUpgrades = ["orbit", "might", "swift"];
    commander.pendingExpiresAt = 0;
    world.step();
    expect(commander.weapons).toEqual(["bolt"]);
    expect(commander.weapon).toBe("bolt");
    expect(commander.upgrades.might).toBe(1);
  });

  it("Storm Wand hits chain 50% damage to a second nearby foe", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.weapons = ["storm"];
    commander.weapon = "storm";
    const pair = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 2);
    const first = pair[0]!;
    const second = pair[1]!;
    const spots = [
      { x: commander.x + 90, y: commander.y },
      { x: commander.x + 120, y: commander.y + 40 },
    ];
    pair.forEach((s, i) => {
      s.hp = 34;
      s.homeX = spots[i]!.x;
      s.homeY = spots[i]!.y;
    });
    expect(
      world.applyCommand(commander.id, 1, {
        type: "shoot",
        target: { x: spots[0]!.x, y: spots[0]!.y },
      }),
    ).toBeUndefined();
    for (let i = 0; i < 12; i++) {
      pair.forEach((s, j) => {
        s.x = spots[j]!.x;
        s.y = spots[j]!.y;
      });
      world.step();
    }
    expect(first.hp).toBeCloseTo(34 - BOLT.damage, 4);
    expect(second.hp).toBeCloseTo(34 - BOLT.damage * 0.5, 4);
  });

  it("units spread targets instead of piling onto one enemy", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    const units = [...world.entities.values()].filter((e) => e.ownerId === commander.id);
    const unitA = units[0]!;
    const unitB = units[1]!;
    const pair = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 2);
    const skelA = pair[0]!;
    const skelB = pair[1]!;
    for (const e of world.entities.values()) {
      if (e.kind === "monster" && e.id !== skelA.id && e.id !== skelB.id) e.hp = 0;
      if (e.kind === "unit" && e.id !== unitA.id && e.id !== unitB.id) e.hp = 0;
    }
    unitA.x = commander.x - 85;
    unitA.y = commander.y;
    unitB.x = commander.x - 55;
    unitB.y = commander.y;
    skelA.x = commander.x - 90;
    skelA.y = commander.y;
    skelA.homeX = skelA.x;
    skelA.homeY = skelA.y;
    skelB.x = commander.x - 10;
    skelB.y = commander.y;
    skelB.homeX = skelB.x;
    skelB.homeY = skelB.y;
    for (let i = 0; i < 30; i++) world.step();
    expect(skelA.hp).toBeLessThan(34);
    expect(skelB.hp).toBeLessThan(34);
  });

  it("aggroed monsters alert nearby pack members beyond normal aggro range", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.x = 960;
    commander.y = 480;
    commander.target = { x: commander.x, y: commander.y };
    commander.path = [];
    commander.trail = [{ x: commander.x, y: commander.y }];
    const pair = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 2);
    const near = pair[0]!;
    const far = pair[1]!;
    near.hp = 34;
    near.x = 1172;
    near.y = 692;
    near.homeX = 1172;
    near.homeY = 692;
    far.hp = 34;
    far.x = 1290;
    far.y = 810;
    far.homeX = 1290;
    far.homeY = 810;
    for (let i = 0; i < 30; i++) world.step();
    expect(far.x).toBeLessThan(1290 - 20);
  });

  it("elite monsters spawn with scaled stats and always drop a utility pickup", () => {
    const world = new SimWorld(42);
    const monsters = [...world.entities.values()].filter((e) => e.kind === "monster");
    const elites = monsters.filter((e) => e.elite);
    expect(elites.length).toBeGreaterThanOrEqual(1);
    const elite = elites[0]!;
    const base = elite.tag === "bone-warden" ? MONSTER.boneWarden : MONSTER.skeleton;
    expect(elite.maxHp).toBe(Math.round(base.maxHp * 2.2));
    expect(elite.damage).toBeCloseTo(base.damage * 1.3, 4);
    const ex = elite.x;
    const ey = elite.y;
    elite.hp = 0;
    world.step();
    const utility = [...world.pickups.values()].filter(
      (p) => p.templateId !== "essence" && Math.hypot(p.x - ex, p.y - ey) < 40,
    );
    expect(utility.length).toBeGreaterThanOrEqual(1);
  });

  it("attack wedge keeps its heading after the commander stops", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    for (const e of world.entities.values()) {
      if (e.kind === "monster") e.hp = 0;
    }
    commander.stance = "attack";
    commander.heading = -Math.PI / 2;
    for (let i = 0; i < 120; i++) world.step();
    const units = [...world.entities.values()].filter(
      (e) => e.ownerId === commander.id && e.hp > 0,
    );
    expect(units.length).toBeGreaterThanOrEqual(10);
    const centroidY = units.reduce((sum, u) => sum + (u.y - commander.y), 0) / units.length;
    const radii = units
      .map((u) => Math.hypot(u.x - commander.x, u.y - commander.y))
      .sort((a, b) => a - b);
    const median = radii[Math.floor(radii.length / 2)]!;
    expect(centroidY).toBeLessThan(-4);
    expect(median).toBeGreaterThanOrEqual(28);
  });

  it("defend stance leashes units instead of chasing distant enemies", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    const unit = [...world.entities.values()].find((e) => e.ownerId === commander.id)!;
    const skeleton = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    for (const e of world.entities.values()) {
      if (e.kind === "monster" && e.id !== skeleton.id) e.hp = 0;
      if (e.kind === "unit" && e.id !== unit.id) e.hp = 0;
    }
    commander.stance = "defend";
    unit.x = commander.x;
    unit.y = commander.y;
    skeleton.hp = 34;
    skeleton.homeX = commander.x + 141;
    skeleton.homeY = commander.y + 141;
    for (let i = 0; i < 60; i++) {
      skeleton.x = commander.x + 141;
      skeleton.y = commander.y + 141;
      world.step();
    }
    expect(skeleton.hp).toBe(34);
    expect(Math.hypot(unit.x - commander.x, unit.y - commander.y)).toBeLessThanOrEqual(130);
  });

  it("eight units spread claims across three skeletons", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    const units = [...world.entities.values()]
      .filter((e) => e.ownerId === commander.id)
      .slice(0, 8);
    const keepUnits = new Set(units.map((u) => u.id));
    const skeletons = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 3);
    const keepSkeletons = new Set(skeletons.map((s) => s.id));
    for (const e of world.entities.values()) {
      if (e.kind === "monster" && !keepSkeletons.has(e.id)) e.hp = 0;
      if (e.kind === "unit" && !keepUnits.has(e.id)) e.hp = 0;
    }
    for (const u of units) {
      u.x = commander.x - 60;
      u.y = commander.y;
    }
    const spots = [
      { x: commander.x - 90, y: commander.y },
      { x: commander.x - 10, y: commander.y },
      { x: commander.x + 70, y: commander.y },
    ];
    skeletons.forEach((s, i) => {
      s.hp = 34;
      s.x = spots[i]!.x;
      s.y = spots[i]!.y;
      s.homeX = spots[i]!.x;
      s.homeY = spots[i]!.y;
    });
    for (let i = 0; i < 45; i++) world.step();
    for (const s of skeletons) expect(s.hp).toBeLessThan(34);
  });

  it("alerted monsters investigate the alert point without a visible victim", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.x = 200;
    commander.y = 688;
    commander.target = { x: commander.x, y: commander.y };
    commander.path = [];
    commander.trail = [{ x: commander.x, y: commander.y }];
    const skeleton = [...world.entities.values()].find((e) => e.tag === "skeleton")!;
    skeleton.hp = 34;
    skeleton.x = 1290;
    skeleton.y = 810;
    skeleton.homeX = 1290;
    skeleton.homeY = 810;
    skeleton.alertUntilTick = world.tick + 90;
    skeleton.alertX = 960;
    skeleton.alertY = 480;
    const d0 = Math.hypot(skeleton.x - 960, skeleton.y - 480);
    for (let i = 0; i < 30; i++) world.step();
    expect(Math.hypot(skeleton.x - 960, skeleton.y - 480)).toBeLessThan(d0 - 40);
  });

  it("expires stale pickups, caps pickup flooding, and preserves the relic", () => {
    const world = new SimWorld(42);
    const relic = [...world.pickups.values()].find((p) => p.templateId === "relic")!;
    world.pickups.set("pickup-old-vial", {
      id: "pickup-old-vial",
      templateId: "vial",
      x: 100,
      y: 100,
      bornTick: -4000,
    });
    for (let i = 0; i < 270; i++) {
      world.pickups.set(`pickup-flood-essence-${i}`, {
        id: `pickup-flood-essence-${i}`,
        templateId: "essence",
        x: 100 + (i % 20),
        y: 120,
        bornTick: 0,
      });
    }
    for (let i = 0; i < 140; i++) {
      world.pickups.set(`pickup-flood-vial-${i}`, {
        id: `pickup-flood-vial-${i}`,
        templateId: "vial",
        x: 100 + (i % 20),
        y: 140,
        bornTick: 0,
      });
    }
    world.step();
    const pickups = [...world.pickups.values()];
    expect(world.pickups.has("pickup-old-vial")).toBe(false);
    expect(pickups.filter((p) => p.templateId === "essence")).toHaveLength(250);
    expect(
      pickups.filter((p) => p.templateId !== "essence" && p.templateId !== "relic"),
    ).toHaveLength(120);
    expect(world.pickups.has(relic.id)).toBe(true);
  });

  it("Hellscatter fires five pellets", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.weapons = ["hellscatter"];
    commander.weapon = "hellscatter";
    expect(
      world.applyCommand(commander.id, 1, {
        type: "shoot",
        target: { x: commander.x + 300, y: commander.y },
      }),
    ).toBeUndefined();
    expect(world.projectiles.size).toBe(5);
  });

  it("Phantom Lance pierces a line of skeletons", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.weapons = ["phantom"];
    commander.weapon = "phantom";
    const line = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 6);
    expect(line).toHaveLength(6);
    const spots = line.map((_, i) => ({ x: commander.x + 60 + i * 30, y: commander.y }));
    line.forEach((s, i) => {
      s.hp = 34;
      s.homeX = spots[i]!.x;
      s.homeY = spots[i]!.y;
    });
    expect(
      world.applyCommand(commander.id, 1, {
        type: "shoot",
        target: { x: spots[0]!.x, y: spots[0]!.y },
      }),
    ).toBeUndefined();
    for (let i = 0; i < 15; i++) {
      line.forEach((s, j) => {
        s.x = spots[j]!.x;
        s.y = spots[j]!.y;
      });
      world.step();
    }
    const damaged = line.filter((s) => s.hp <= 34 - 11);
    expect(damaged.length).toBeGreaterThanOrEqual(5);
  });

  it("protects units inside Sanctuary and grants < level 2 newbie shield against bots", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "newbie",
      accountId: "newbie",
      name: "Newbie",
      kind: "human",
      character: "necromancer",
    });
    world.spawnCommander({
      id: "bot-rival",
      accountId: "bot-rival",
      name: "Bot",
      kind: "bot",
      character: "boneknight",
    });
    const newbie = world.commanders.get("newbie")!;
    const bot = world.commanders.get("bot-rival")!;
    // Anti-pile spawn selection places commanders at distinct spawn points
    expect(Math.hypot(newbie.x - bot.x, newbie.y - bot.y)).toBeGreaterThanOrEqual(20);

    // Units owned by a commander in Sanctuary cannot take damage
    const newbieUnits = [...world.entities.values()].filter((e) => e.ownerId === newbie.id);
    expect(newbieUnits.length).toBeGreaterThan(0);
    const unit0 = newbieUnits[0]!;
    const initialUnitHp = unit0.hp;

    // Move bot into Arena and try to shoot at newbie's unit in Sanctuary
    toArena(world, bot.id);
    bot.x = unit0.x + 120;
    bot.y = unit0.y;
    world.applyCommand(bot.id, 1, { type: "shoot", target: { x: unit0.x, y: unit0.y } });
    for (let i = 0; i < 20; i++) world.step();
    expect(unit0.hp).toBe(initialUnitHp);
  });

  it("emits visible chainFx on Storm Wand bounces and knocks back monsters on Grave Scythe", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);
    commander.weapons = ["storm", "scythe"];
    commander.weapon = "storm";

    const skels = [...world.entities.values()].filter((e) => e.tag === "skeleton").slice(0, 2);
    expect(skels).toHaveLength(2);
    skels[0]!.hp = 34;
    skels[0]!.x = commander.x + 70;
    skels[0]!.y = commander.y;
    skels[1]!.hp = 34;
    skels[1]!.x = commander.x + 120;
    skels[1]!.y = commander.y + 20;

    world.applyCommand(commander.id, 1, {
      type: "shoot",
      target: { x: skels[0]!.x, y: skels[0]!.y },
    });
    let sawChainFx = false;
    for (let i = 0; i < 15; i++) {
      world.step();
      if (world.chainEffects().length > 0) sawChainFx = true;
    }
    expect(sawChainFx).toBe(true);

    // Switch to Grave Scythe and verify physical knockback impulse on hit
    commander.weapon = "scythe";
    commander.nextShotAt = 0;
    skels[0]!.hp = 34;
    skels[0]!.x = commander.x + 20;
    skels[0]!.y = commander.y;
    skels[0]!.slowUntil = world.tick + 60;
    const xBefore = skels[0]!.x;
    world.applyCommand(commander.id, 2, {
      type: "shoot",
      target: { x: skels[0]!.x, y: skels[0]!.y },
    });
    world.step();
    expect(skels[0]!.x).toBeGreaterThan(xBefore + 3);
  });

  it("scales weapon projectile speed, reach, and cleave radius by class and level", () => {
    const world = new SimWorld(42);
    world.spawnCommander({
      id: "warlock-1",
      accountId: "warlock-1",
      name: "Hex",
      kind: "human",
      character: "warlock",
    });
    world.spawnCommander({
      id: "knight-1",
      accountId: "knight-1",
      name: "Knight",
      kind: "human",
      character: "boneknight",
    });
    const warlock = toArena(world, "warlock-1");
    const knight = toArena(world, "knight-1");
    clearField(world, warlock.id);
    clearField(world, knight.id);

    warlock.level = 5;
    knight.level = 5;
    world.applyCommand(warlock.id, 1, {
      type: "shoot",
      target: { x: warlock.x + 400, y: warlock.y },
    });
    world.applyCommand(knight.id, 1, {
      type: "shoot",
      target: { x: knight.x + 400, y: knight.y },
    });

    const snaps = world.projectileSnapshots();
    const lanceSnap = snaps.find((p) => p.ownerId === warlock.id)!;
    const scytheSnap = snaps.find((p) => p.ownerId === knight.id)!;
    expect(lanceSnap.weapon).toBe("lance");
    expect(lanceSnap.vx).toBeGreaterThan(750);
    expect(scytheSnap.weapon).toBe("scythe");
    expect(scytheSnap.radius).toBeGreaterThan(28);
  });

  it("spawns escalating hunter waves and triggers an immediate Relic Siege wave on Moon Relic pickup", () => {
    const world = new SimWorld(42);
    const commander = spawnTwin(world);
    clearField(world, commander.id);

    // Advance to the first scheduled catacomb surge at tick 1200
    world.tick = 1199;
    const events1 = world.step();
    expect(events1.some((e) => e.type === "wave_spawned" && e.wave === 1)).toBe(true);
    const status1 = world.waveStatus();
    expect(status1.number).toBe(1);
    expect(status1.activeHunters).toBeGreaterThanOrEqual(4);
    expect(status1.targetCommanderId).toBe(commander.id);

    // Drop the Moon Relic at the commander's feet and step to trigger Relic Siege
    world.pickups.set("relic-siege-test", {
      id: "relic-siege-test",
      templateId: "relic",
      x: commander.x,
      y: commander.y,
    });
    const events2 = world.step();
    expect(commander.carryingItemId).toBe("relic-siege-test");
    expect(events2.some((e) => e.type === "wave_spawned" && e.title === "Relic Siege Pack")).toBe(
      true,
    );
    expect(world.waveStatus().number).toBe(2);
    expect(world.waveStatus().title).toBe("Relic Siege Pack");
  });
});
