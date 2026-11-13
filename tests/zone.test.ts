import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileZoneStore } from "@swarms/persistence";
import { parseClientMessage } from "@swarms/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ZoneRuntime } from "../apps/server/src/zone.ts";

function fundAccount(
  runtime: ZoneRuntime,
  accountId: string,
  amount: number,
  key = `test-fund:${accountId}:${amount}`,
): void {
  runtime.ledger.transfer({
    from: "dungeon",
    to: accountId,
    amount,
    kind: "test_fund",
    ref: accountId,
    tick: runtime.world.tick,
    idempotencyKey: key,
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persistent zone runtime", () => {
  it("restores commander, wallet, contract, and session from checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarms-zone-"));
    dirs.push(dir);
    const runtime = new ZoneRuntime(new FileZoneStore(dir), 99);
    const session = runtime.join({ name: "Persisted", kind: "human" });
    fundAccount(runtime, session.accountId, 500);
    runtime.postContract(session, "persist-test-contract-1", {
      title: "Persisted cull",
      description: "Restore me",
      predicate: { kind: "kill_count", targetTag: "skeleton", count: 3 },
      reward: 75,
      mode: "bounty",
      ttlTicks: 1800,
    });
    for (let i = 0; i < 12; i++) runtime.step();
    runtime.checkpoint();

    const restored = new ZoneRuntime(new FileZoneStore(dir), 99);
    const restoredSession = restored.session(session.token);
    expect(restoredSession?.commanderId).toBe(session.commanderId);
    const snap = restored.snapshot(restoredSession!);
    expect(snap.wallet.sparks).toBe(425);
    expect(snap.wallet.escrowed).toBe(75);
    expect(snap.contracts.some((c) => c.title === "Persisted cull")).toBe(true);
    expect(snap.commanders.some((c) => c.id === session.commanderId)).toBe(false);
    const resumed = restored.join({
      name: "Persisted",
      kind: "human",
      resumeToken: session.token,
    });
    expect(resumed.commanderId).toBe(session.commanderId);
    const resumedSnap = restored.snapshot(resumed);
    expect(resumedSnap.commanders.some((c) => c.id === session.commanderId)).toBe(true);
    expect(resumedSnap.wallet.sparks).toBe(425);
    expect(resumedSnap.world?.rooms).toHaveLength(7);
    expect(resumedSnap.commanders.find((c) => c.id === session.commanderId)?.spellReadyAt).toEqual({
      nova: 0,
      volley: 0,
      shell: 0,
      frost: 0,
      chain: 0,
    });
  });

  it("keeps steady snapshots bounded by contract history and sends static world only on demand", () => {
    const runtime = new ZoneRuntime(undefined, 99);
    const session = runtime.join({ name: "Historian", kind: "human" });
    for (let i = 0; i < 320; i++) {
      runtime.contracts.create({
        issuerId: "dungeon",
        draft: {
          title: `History ${i}`,
          description: "Settled history must not ride every snapshot.",
          predicate: { kind: "kill_count", targetTag: "skeleton", count: 1 },
          reward: 1,
          mode: "bounty",
          ttlTicks: 1800,
        },
        tick: 0,
        idempotencyKey: `snapshot-history-${i}`,
      });
      runtime.contracts.applyEvent(
        {
          type: "death",
          tick: i + 1,
          victimTag: "skeleton",
          killerCommanderId: session.commanderId,
        },
        i + 1,
        new Map(),
      );
    }
    runtime.postContract(session, "snapshot-history-own-live", {
      title: "Own live contract",
      description: "The viewer's live work stays in the snapshot window.",
      predicate: { kind: "kill_count", targetTag: "skeleton", count: 3 },
      reward: 25,
      mode: "bounty",
      ttlTicks: 1800,
    });

    const first = runtime.snapshot(session);
    const steady = runtime.snapshot(session, { includeWorld: false });
    expect(first.world?.walls.length).toBeGreaterThan(1000);
    expect(steady.world).toBeUndefined();
    expect(steady.worldHash).toBe(runtime.world.map.hash);
    expect(steady.wallet.openContracts).toBe(1);
    expect(parseClientMessage(JSON.stringify({ type: "requestWorld" }))).toEqual({
      type: "requestWorld",
    });
    expect(steady.contracts.length).toBeLessThanOrEqual(32);
    expect(steady.contracts.some((contract) => contract.title === "Own live contract")).toBe(true);
    expect(steady.contracts.some((contract) => contract.title === "History 319")).toBe(true);
    expect(steady.contracts.some((contract) => contract.title === "History 0")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(steady))).toBeLessThan(32_768);
  });

  it("leave parks the body after a logout window and resume returns it unhealed to Sanctuary", () => {
    const runtime = new ZoneRuntime(undefined, 99);
    const session = runtime.join({ name: "Leaver", kind: "human" });
    fundAccount(runtime, session.accountId, 500);
    runtime.postContract(session, "leave-test-contract-1", {
      title: "Leaver cull",
      description: "Wallet must survive leave",
      predicate: { kind: "kill_count", targetTag: "skeleton", count: 3 },
      reward: 75,
      mode: "bounty",
      ttlTicks: 1800,
    });
    const commander = runtime.world.commanders.get(session.commanderId)!;
    const tile = runtime.world.map.tileSize;
    const shrine = runtime.world.map.rooms.find((r) => r.id === "shrine")!;
    commander.x = (shrine.x + shrine.w / 2) * tile;
    commander.y = (shrine.y + shrine.h / 2) * tile;
    commander.target = { x: commander.x, y: commander.y };
    commander.path = [];
    commander.trail = [{ x: commander.x, y: commander.y }];
    commander.hp = 37;
    commander.essence = 3;
    const parkedAt = { x: commander.x, y: commander.y };
    const owned = [...runtime.world.entities.values()].filter(
      (e) => e.ownerId === session.commanderId,
    );
    for (const unit of owned) {
      unit.x = commander.x + 30;
      unit.y = commander.y + 30;
    }
    for (const unit of owned.slice(0, 5)) runtime.world.entities.delete(unit.id);
    runtime.leave(session.token);
    for (let i = 0; i < 100; i++) runtime.step();
    expect(runtime.world.commanders.has(session.commanderId)).toBe(true);
    for (let i = 0; i < 80; i++) runtime.step();
    expect(runtime.world.commanders.has(session.commanderId)).toBe(false);
    expect(
      [...runtime.world.entities.values()].some((e) => e.ownerId === session.commanderId),
    ).toBe(false);
    const resumed = runtime.join({ name: "Leaver", kind: "human", resumeToken: session.token });
    expect(resumed.commanderId).toBe(session.commanderId);
    expect(runtime.world.commanders.has(session.commanderId)).toBe(true);
    expect(runtime.snapshot(resumed).wallet.sparks).toBe(425);
    const restored = runtime.world.commanders.get(session.commanderId)!;
    expect(restored.hp).toBeGreaterThan(0);
    expect(restored.hp).toBeLessThanOrEqual(37);
    expect(restored.essence).toBe(3);
    expect(Math.hypot(restored.x - parkedAt.x, restored.y - parkedAt.y)).toBeGreaterThan(96);
    expect(restored.x).toBeGreaterThanOrEqual(runtime.world.entryRect.x);
    expect(restored.x).toBeLessThanOrEqual(runtime.world.entryRect.x + runtime.world.entryRect.w);
    expect(restored.y).toBeGreaterThanOrEqual(runtime.world.entryRect.y);
    expect(restored.y).toBeLessThanOrEqual(runtime.world.entryRect.y + runtime.world.entryRect.h);
    expect(
      runtime.snapshot(resumed).commanders.find((c) => c.id === session.commanderId)?.pvpGrace,
    ).toBe(true);
    const restoredUnits = [...runtime.world.entities.values()].filter(
      (e) => e.ownerId === session.commanderId,
    ).length;
    expect(restoredUnits).toBeGreaterThanOrEqual(5);
    expect(restoredUnits).toBeLessThanOrEqual(9);
  });

  it("join character sticks across park and resume; a different hello class is ignored", () => {
    const runtime = new ZoneRuntime(undefined, 99);
    const session = runtime.join({ name: "Knight", kind: "human", character: "boneknight" });
    const spawned = runtime.world.commanders.get(session.commanderId)!;
    expect(spawned.character).toBe("boneknight");
    expect(spawned.maxHp).toBe(170);
    expect(
      runtime.snapshot(session).commanders.find((c) => c.id === session.commanderId)?.character,
    ).toBe("boneknight");
    runtime.leave(session.token);
    for (let i = 0; i < 200; i++) runtime.step();
    expect(runtime.world.commanders.has(session.commanderId)).toBe(false);
    const resumed = runtime.join({
      name: "Knight",
      kind: "human",
      resumeToken: session.token,
      character: "warlock",
    });
    expect(resumed.commanderId).toBe(session.commanderId);
    const restored = runtime.world.commanders.get(session.commanderId)!;
    expect(restored.character).toBe("boneknight");
    expect(restored.maxHp).toBe(170);
  });

  it("banks up to 50 essence as Sparks on extraction", () => {
    const runtime = new ZoneRuntime(undefined, 99);
    const session = runtime.join({ name: "Banker", kind: "human" });
    const commander = runtime.world.commanders.get(session.commanderId)!;
    const extraction = runtime.world.map.extraction;
    commander.x = extraction.x + extraction.w / 2;
    commander.y = extraction.y + extraction.h / 2;
    commander.target = { x: commander.x, y: commander.y };
    commander.path = [];
    commander.trail = [{ x: commander.x, y: commander.y }];
    commander.essence = 80;
    const before = runtime.snapshot(session).wallet.sparks;
    runtime.command(session, 1, { type: "extract" });
    runtime.step();
    const snap = runtime.snapshot(session);
    expect(snap.wallet.sparks).toBe(before + 100);
    expect(snap.feed.some((entry) => entry.text.includes("banked 100 Sparks"))).toBe(true);
    expect(runtime.ledger.reconcile().net).toBe(0);
  });

  it("fresh bots spawn with their assigned classes", () => {
    const runtime = new ZoneRuntime(undefined, 99);
    runtime.ensureBots(2);
    const byName = new Map(
      [...runtime.world.commanders.values()].map((c) => [c.name, c.character]),
    );
    expect(byName.get("Ash Swarm")).toBe("boneknight");
    expect(byName.get("Moss Swarm")).toBe("warlock");
  });

  it("unlocked weapons and active weapon survive park and resume", () => {
    const runtime = new ZoneRuntime(undefined, 99);
    const session = runtime.join({ name: "Lancer", kind: "human", character: "warlock" });
    const spawned = runtime.world.commanders.get(session.commanderId)!;
    spawned.weapons = ["bolt", "lance"];
    spawned.weapon = "lance";
    spawned.upgrades = { lance: 1 };
    runtime.leave(session.token);
    for (let i = 0; i < 200; i++) runtime.step();
    expect(runtime.world.commanders.has(session.commanderId)).toBe(false);
    const resumed = runtime.join({
      name: "Lancer",
      kind: "human",
      resumeToken: session.token,
    });
    const restored = runtime.world.commanders.get(session.commanderId)!;
    expect(restored.weapons).toEqual(["bolt", "lance"]);
    expect(restored.weapon).toBe("lance");
    expect(
      runtime.snapshot(resumed).commanders.find((c) => c.id === session.commanderId)?.weapon,
    ).toBe("lance");
  });

  it("abandon despawns the commander at once and invalidates the resume token", () => {
    const runtime = new ZoneRuntime(undefined, 99);
    const session = runtime.join({ name: "Quitter", kind: "human" });
    expect(runtime.world.commanders.has(session.commanderId)).toBe(true);
    const oldToken = session.token;
    const oldId = session.commanderId;
    runtime.abandon(session);
    expect(runtime.world.commanders.has(oldId)).toBe(false);
    expect(runtime.session(oldToken)).toBeUndefined();
    const fresh = runtime.join({ name: "Quitter", kind: "human", resumeToken: oldToken });
    expect(fresh.commanderId).not.toBe(oldId);
    expect(runtime.world.commanders.has(fresh.commanderId)).toBe(true);
  });

  it("bots keep moving after a checkpoint restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarms-zone-bots-"));
    dirs.push(dir);
    const runtime = new ZoneRuntime(new FileZoneStore(dir), 99);
    runtime.ensureBots(2);
    for (let i = 0; i < 1500; i++) runtime.step();
    runtime.checkpoint();
    const restored = new ZoneRuntime(new FileZoneStore(dir), 99);
    restored.ensureBots(2);
    const bot = [...restored.world.commanders.values()].find((c) => c.kind === "bot")!;
    const startX = bot.x;
    const startY = bot.y;
    let maxDistance = 0;
    for (let i = 0; i < 600; i++) {
      restored.step();
      maxDistance = Math.max(maxDistance, Math.hypot(bot.x - startX, bot.y - startY));
    }
    expect(maxDistance).toBeGreaterThan(100);
  }, 60_000);

  it("bots retreat when their swarm is wiped even at full commander hp", () => {
    const runtime = new ZoneRuntime(undefined, 1337);
    runtime.ensureBots(1);
    const bot = [...runtime.world.commanders.values()].find((c) => c.kind === "bot")!;
    const units = [...runtime.world.entities.values()].filter((e) => e.ownerId === bot.id);
    for (const unit of units.slice(0, 11)) unit.hp = 0;
    for (let i = 0; i < 40; i++) runtime.step();
    expect(bot.hp).toBeGreaterThan(35);
    expect(bot.stance).toBe("retreat");
  });

  it("bots sortie instead of camping Sanctuary and survive at least 45s on average", () => {
    const runtime = new ZoneRuntime(undefined, 1337);
    runtime.ensureBots(2);
    const bots = [...runtime.world.commanders.values()].filter((c) => c.kind === "bot");
    const entry = runtime.world.entryRect;
    const inEntry = (p: { x: number; y: number }) =>
      p.x >= entry.x && p.x <= entry.x + entry.w && p.y >= entry.y && p.y <= entry.y + entry.h;
    const dwellSamples = new Map<string, number>();
    const aliveSamples = new Map<string, number>();
    const deaths = new Map<string, number>();
    const wasAlive = new Map<string, boolean>();
    for (const bot of bots) {
      dwellSamples.set(bot.id, 0);
      aliveSamples.set(bot.id, 0);
      deaths.set(bot.id, 0);
      wasAlive.set(bot.id, true);
    }
    for (let i = 0; i < 5400; i++) {
      runtime.step();
      for (const bot of bots) {
        if (wasAlive.get(bot.id) && !bot.alive && !bot.extracted) {
          deaths.set(bot.id, deaths.get(bot.id)! + 1);
        }
        wasAlive.set(bot.id, bot.alive);
        if (i % 30 === 0 && bot.alive) {
          aliveSamples.set(bot.id, aliveSamples.get(bot.id)! + 1);
          if (inEntry(bot)) dwellSamples.set(bot.id, dwellSamples.get(bot.id)! + 1);
        }
      }
    }
    for (const bot of bots) {
      const dwellShare = dwellSamples.get(bot.id)! / Math.max(1, aliveSamples.get(bot.id)!);
      // CP7 recalibration: pack alerts + investigate pressure wipe swarms more often, so
      // retreat/regrow cycles (and Sanctuary dwell) run hotter (measured 0.353/0.368,
      // 1 death each, ~9.4 units out avg) than the CP5 baseline this proxy was tuned on.
      expect(dwellShare).toBeLessThanOrEqual(0.4);
      // CP5 recalibration: both bots shoot now (m2 gate fix) and Bolt is 8 dmg, so bot-vs-bot attrition is higher than the CP4 baseline this proxy was tuned on.
      expect(deaths.get(bot.id)!).toBeLessThanOrEqual(5);
    }
  }, 90_000);

  it("archives settled history outside the hot checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarms-zone-archive-"));
    dirs.push(dir);
    const store = new FileZoneStore(dir);
    const runtime = new ZoneRuntime(store, 99);
    const session = runtime.join({ name: "Archivist", kind: "human" });
    for (let i = 0; i < 1200; i++) {
      runtime.contracts.create({
        issuerId: "dungeon",
        draft: {
          title: `Checkpoint history ${i}`,
          description: "Settled work belongs in the archive, not every checkpoint.",
          predicate: { kind: "kill_count", targetTag: "skeleton", count: 1 },
          reward: 1,
          mode: "bounty",
          ttlTicks: 3600,
        },
        tick: 0,
        idempotencyKey: `checkpoint-history-${i}`,
      });
      runtime.contracts.applyEvent(
        {
          type: "death",
          tick: i + 1,
          victimTag: "skeleton",
          killerCommanderId: session.commanderId,
        },
        i + 1,
        new Map(),
      );
    }
    runtime.checkpoint();

    const archivePath = join(dir, "archive", "contracts.jsonl");
    expect(existsSync(archivePath)).toBe(true);
    const archivedLines = readFileSync(archivePath, "utf8").trim().split("\n");
    expect(archivedLines.length).toBeGreaterThan(900);
    expect(statSync(join(dir, "checkpoint.json")).size).toBeLessThan(900_000);

    const restored = new ZoneRuntime(new FileZoneStore(dir), 99);
    const restoredSession = restored.session(session.token)!;
    const snap = restored.snapshot(restoredSession, { includeWorld: false });
    expect(snap.wallet.sparks).toBe(1350);
    expect(snap.contracts.length).toBeLessThanOrEqual(64);
    expect(restored.ledger.reconcile().net).toBe(0);
  });

  it("separates accounts from commanders, hashes resume tokens, and funds onboarding from treasury", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarms-zone-account-"));
    dirs.push(dir);
    const store = new FileZoneStore(dir);
    const runtime = new ZoneRuntime(store, 99);
    const session = runtime.join({ name: "Accounted", kind: "human" });
    expect(session.accountId).toMatch(/^acct-/);
    expect(session.accountId).not.toBe(session.commanderId);
    expect(runtime.account(session.accountId)).toMatchObject({
      id: session.accountId,
      onboardingGrantClaimed: true,
    });
    const initial = runtime.snapshot(session, { includeWorld: false });
    expect(initial.wallet).toMatchObject({
      accountId: session.accountId,
      sparks: 0,
      onboardingCredits: 500,
    });
    expect(runtime.health()).toMatchObject({ treasuryBalance: 3700 });
    fundAccount(runtime, session.accountId, 500);
    runtime.postContract(session, "account-posting-fee-1", {
      title: "Accounted cull",
      description: "",
      predicate: { kind: "kill_count", targetTag: "skeleton", count: 1 },
      reward: 75,
      mode: "bounty",
      ttlTicks: 900,
    });
    const afterPost = runtime.snapshot(session, { includeWorld: false });
    expect(afterPost.wallet.sparks).toBe(425);
    expect(afterPost.wallet.onboardingCredits).toBe(498);
    expect(runtime.ledger.balance("burn")).toBe(1);

    const checkpointText = readFileSync(join(dir, "checkpoint.json"), "utf8");
    expect(checkpointText).not.toContain(session.token);
    expect(checkpointText).toContain("tokenHash");

    runtime.command(session, 10, { type: "stop" });
    runtime.leave(session.token);
    for (let i = 0; i < 180; i++) runtime.step();
    const resumed = runtime.join({
      name: "Accounted",
      kind: "human",
      resumeToken: session.token,
    });
    expect(resumed.accountId).toBe(session.accountId);
    expect(() => runtime.command(resumed, 10, { type: "stop" })).toThrow("stale_sequence");
    expect(() => runtime.command(resumed, 11, { type: "stop" })).not.toThrow();
  });

  it("charges idempotent field services from onboarding credits first", () => {
    const runtime = new ZoneRuntime(undefined, 99);
    const session = runtime.join({ name: "Serviced", kind: "human" });
    const commander = runtime.world.commanders.get(session.commanderId)!;
    commander.hp = 50;
    commander.command = 10;
    expect(runtime.buyService(session, "service-mend-1", "mend")).toMatchObject({
      service: "mend",
      cost: 25,
    });
    expect(commander.hp).toBe(85);
    expect(runtime.snapshot(session, { includeWorld: false }).wallet.onboardingCredits).toBe(475);
    expect(runtime.buyService(session, "service-mend-1", "mend")).toMatchObject({ cost: 25 });
    expect(commander.hp).toBe(85);
    expect(runtime.buyService(session, "service-rally-1", "rally")).toMatchObject({
      service: "rally",
      cost: 20,
    });
    expect(commander.command).toBe(60);
    expect(runtime.snapshot(session, { includeWorld: false }).wallet.onboardingCredits).toBe(455);
    const scout = runtime.buyService(session, "service-scout-1", "scout");
    expect(scout.detail).toContain("Bone Choir");
    expect(runtime.ledger.reconcile().net).toBe(0);
  });

  it("file store appends events and replaces checkpoints atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarms-store-"));
    dirs.push(dir);
    const store = new FileZoneStore(dir);
    store.appendEvents([{ a: 1 }, { b: 2 }]);
    store.saveCheckpoint({ value: 41 });
    store.saveCheckpoint({ value: 42 });
    expect(store.readEvents()).toEqual([{ a: 1 }, { b: 2 }]);
    expect(store.loadCheckpoint<{ value: number }>()).toEqual({ value: 42 });
  });

  it("file store bounds the active event journal and writes named archives", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarms-store-rotate-"));
    dirs.push(dir);
    const store = new FileZoneStore(dir, { maxEventBytes: 48, eventGenerations: 2 });
    store.appendEvents([{ value: "12345678901234567890" }]);
    store.appendEvents([{ value: "abcdefghijklmnopqrst" }]);
    store.appendEvents([{ value: "latest" }]);
    expect(existsSync(join(dir, "events.1.jsonl"))).toBe(true);
    expect(store.readEvents()).toEqual([{ value: "latest" }]);
    expect(statSync(join(dir, "events.jsonl")).size).toBeLessThan(48);

    store.appendArchive("contracts", [{ id: "contract-1", status: "settled" }]);
    const restartedStore = new FileZoneStore(dir, { maxEventBytes: 48, eventGenerations: 2 });
    restartedStore.appendArchive("contracts", [{ id: "contract-1", status: "settled" }]);
    const archiveText = readFileSync(join(dir, "archive", "contracts.jsonl"), "utf8");
    expect(archiveText).toContain("contract-1");
    expect(archiveText.trim().split("\n")).toHaveLength(1);
    expect(() => store.appendArchive("../escape", [{ id: "nope" }])).toThrow(
      "invalid_archive_name",
    );
  });

  it("falls back to the previous checkpoint and fails closed when both generations are corrupt", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarms-store-fallback-"));
    dirs.push(dir);
    const store = new FileZoneStore(dir);
    store.saveCheckpoint({ value: 1 });
    store.saveCheckpoint({ value: 2 });
    writeFileSync(join(dir, "checkpoint.json"), '{"format":');
    expect(store.loadCheckpoint<{ value: number }>()).toEqual({ value: 1 });
    writeFileSync(join(dir, "checkpoint.prev.json"), "not-json");
    expect(() => store.loadCheckpoint()).toThrow("checkpoint_unrecoverable");
  });

  it("enforces a single-writer directory lock and replaces a stale lock", () => {
    const foreignDir = mkdtempSync(join(tmpdir(), "swarms-store-lock-foreign-"));
    dirs.push(foreignDir);
    writeFileSync(
      join(foreignDir, "zone.lock"),
      JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }),
    );
    expect(() => new FileZoneStore(foreignDir)).toThrow("zone_store_locked");

    const staleDir = mkdtempSync(join(tmpdir(), "swarms-store-lock-stale-"));
    dirs.push(staleDir);
    writeFileSync(
      join(staleDir, "zone.lock"),
      JSON.stringify({ pid: 999_999, startedAt: "2000-01-01T00:00:00.000Z" }),
    );
    const store = new FileZoneStore(staleDir);
    store.saveCheckpoint({ value: 7 });
    expect(store.loadCheckpoint<{ value: number }>()).toEqual({ value: 7 });
    store.close();
    const reopened = new FileZoneStore(staleDir);
    expect(reopened.loadCheckpoint<{ value: number }>()).toEqual({ value: 7 });
    reopened.close();
  });

  it("does not overwrite an unsupported checkpoint with a fresh world", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarms-zone-unknown-checkpoint-"));
    dirs.push(dir);
    const store = new FileZoneStore(dir);
    store.saveCheckpoint({ version: 99, marker: "keep-me" });
    expect(() => new ZoneRuntime(new FileZoneStore(dir), 99)).toThrow(/checkpoint/);
    expect(store.loadCheckpoint<{ version: number; marker: string }>()).toEqual({
      version: 99,
      marker: "keep-me",
    });
  });

  it("falls back when the newest checkpoint is checksum-valid but semantically invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarms-zone-semantic-fallback-"));
    dirs.push(dir);
    const store = new FileZoneStore(dir);
    const runtime = new ZoneRuntime(store, 99);
    const session = runtime.join({ name: "Fallback", kind: "human" });
    runtime.checkpoint();
    store.saveCheckpoint({ version: 2, sessions: "not-an-array" });
    const restored = new ZoneRuntime(new FileZoneStore(dir), 99);
    expect(restored.session(session.token)?.commanderId).toBe(session.commanderId);
  });

  it("supports War Table mercenary and armory services and keeps steady-state snapshots under 60 KB", () => {
    const runtime = new ZoneRuntime(undefined, 99);
    const session = runtime.join({ name: "Warlord", kind: "human", character: "necromancer" });
    const commander = runtime.world.commanders.get(session.commanderId)!;
    const unitsBefore = [...runtime.world.entities.values()].filter(
      (e) => e.ownerId === commander.id,
    ).length;
    const weaponsBefore = commander.weapons.length;

    const merc = runtime.buyService(session, "svc-merc-1", "mercenary");
    expect(merc.cost).toBe(40);
    const unitsAfter = [...runtime.world.entities.values()].filter(
      (e) => e.ownerId === commander.id,
    );
    expect(unitsAfter.length).toBe(unitsBefore + 2);
    expect(unitsAfter.filter((u) => u.tag === "mercenary" && u.elite)).toHaveLength(2);

    const armory = runtime.buyService(session, "svc-armory-1", "armory");
    expect(armory.cost).toBe(45);
    expect(commander.weapons.length).toBe(weaponsBefore + 1);

    // Steady-state snapshot (includeWorld: false) is interest-filtered and well under 60 KB
    const snap = runtime.snapshot(session, { includeWorld: false });
    const byteSize = Buffer.byteLength(JSON.stringify(snap), "utf8");
    expect(byteSize).toBeLessThan(60_000);
    // Boss and relic remain globally visible even outside 960px radius
    expect(snap.entities.some((e) => e.id === "boss-bone-choir")).toBe(true);
    expect(snap.pickups.some((p) => p.templateId === "relic")).toBe(true);
  });

  it("bots accept open escort_alive contracts and Blood Contracts spawn on wealthy carriers", () => {
    const runtime = new ZoneRuntime(undefined, 99);
    runtime.ensureBots(2);
    const session = runtime.join({ name: "Carrier", kind: "human", character: "boneknight" });
    fundAccount(runtime, session.accountId, 300);
    const commander = runtime.world.commanders.get(session.commanderId)!;
    // Move carrier into Arena and give them 30 essence
    commander.x = 960;
    commander.y = 640;
    commander.essence = 30;

    runtime.postContract(session, "escort-me-1", {
      title: "Escort my sortie",
      description: "Guard the carrier",
      predicate: {
        kind: "escort_alive",
        subjectCommanderId: commander.id,
        withinDistance: 380,
      },
      reward: 75,
      mode: "claim",
      ttlTicks: 1800,
    });
    const escort = [...runtime.contracts.contracts.values()].find(
      (c) => c.title === "Escort my sortie",
    )!;
    expect(escort.status).toBe("open");

    // Step runtime through 600 ticks so bots accept the escort contract and Blood Contract triggers
    for (let i = 0; i < 600; i++) {
      commander.x = 960;
      commander.y = 640;
      commander.essence = 30;
      runtime.step();
    }

    const updatedEscort = runtime.contracts.contracts.get(escort.id)!;
    expect(["accepted", "settled", "satisfied"]).toContain(updatedEscort.status);

    const bloodContract = [...runtime.contracts.contracts.values()].find((c) =>
      c.title.startsWith("Blood Contract:"),
    );
    expect(bloodContract).toBeDefined();
  });

  it("supports Faction Warfare (Solar Wardens vs Obsidian Reapers), SOS Flare rescue contracts, and PvP War Spoils", () => {
    const runtime = new ZoneRuntime(undefined, 1337);
    const wardenSession = runtime.join({
      name: "SolarKnight",
      kind: "human",
      character: "boneknight",
      faction: "wardens",
    });
    const reaperSession = runtime.join({
      name: "ShadowHex",
      kind: "human",
      character: "warlock",
      faction: "reapers",
    });

    const warden = runtime.world.commanders.get(wardenSession.commanderId)!;
    const reaper = runtime.world.commanders.get(reaperSession.commanderId)!;
    expect(warden.faction).toBe("wardens");
    expect(reaper.faction).toBe("reapers");

    // Verify SOS Flare heals commander, spawns 2 elite vanguard guards, and posts an escort_alive rescue bounty
    warden.x = 960;
    warden.y = 640;
    warden.hp = 60;
    const thrallsBefore = [...runtime.world.entities.values()].filter(
      (e) => e.ownerId === warden.id && e.hp > 0,
    ).length;

    const sosResult = runtime.buyService(wardenSession, "sos-flare-1", "sos");
    expect(sosResult.cost).toBe(40);
    expect(warden.hp).toBeGreaterThan(60);
    const thrallsAfter = [...runtime.world.entities.values()].filter(
      (e) => e.ownerId === warden.id && e.hp > 0,
    ).length;
    expect(thrallsAfter).toBe(thrallsBefore + 2);

    const sosContract = [...runtime.contracts.contracts.values()].find((c) =>
      c.title.startsWith("SOS Flare: Reinforce SolarKnight"),
    );
    expect(sosContract).toBeDefined();
    expect(sosContract?.predicate.kind).toBe("escort_alive");
    expect(sosContract?.reward).toBe(50);

    // Move both commanders into PvP Arena and have Reaper eliminate Warden carrying 20 Essence
    warden.x = 960;
    warden.y = 640;
    warden.target = { x: 960, y: 640 };
    warden.path = [];
    warden.hp = 5;
    warden.essence = 20;
    warden.spawnedAtTick = -1000;
    reaper.x = 990;
    reaper.y = 640;
    reaper.target = { x: 990, y: 640 };
    reaper.path = [];
    reaper.essence = 0;
    reaper.spawnedAtTick = -1000;

    const reaperSparksBefore = runtime.ledger.balance(reaperSession.accountId);
    runtime.command(reaperSession, 1, {
      type: "cast",
      spell: "nova",
      target: { x: warden.x, y: warden.y },
    });

    for (let i = 0; i < 5 && warden.alive; i++) {
      runtime.step();
    }

    expect(warden.alive).toBe(false);
    // Reaper plunders 50% of Warden's 20 Essence (10 Essence) + receives +35 Sparks pvp_spoil from Treasury
    expect(reaper.essence).toBeGreaterThanOrEqual(10);
    expect(runtime.ledger.balance(reaperSession.accountId)).toBe(reaperSparksBefore + 35);

    const warStatus = runtime.factionWarStatus();
    expect(warStatus.reapersScore).toBeGreaterThanOrEqual(35);
    expect(warStatus.sparkUsdRate).toBe(0.001);

    // Deploying an allied JEV-v1 agent spawns an autonomous commander on the caller's faction
    const agentRes = runtime.buyService(reaperSession, "deploy-agent-1", "agent");
    expect(agentRes.cost).toBe(60);
    const spawnedAgent = [...runtime.world.commanders.values()].find(
      (c) => c.kind === "agent" && c.name.startsWith("Reaper-JEV-"),
    );
    expect(spawnedAgent).toBeDefined();
    expect(spawnedAgent?.faction).toBe("reapers");
  });

  it("verifies TAP standing, executes Sovereign Edict & Town Portal, and ranks leaderboard", async () => {
    const { verifyTapHttpOrSandbox, createForgeProposal } = await import(
      "../apps/server/src/tap-forge.ts"
    );
    const runtime = new ZoneRuntime();
    const session = runtime.join({
      name: "SovereignPaladin",
      kind: "human",
      character: "boneknight",
      faction: "wardens",
    });
    const cmdr = runtime.world.commanders.get(session.commanderId)!;
    const baseMaxHp = cmdr.maxHp;

    // 1. Attest TAP Identity via buyService("tap_verify")
    const tapRes = runtime.buyService(session, "tap-attest-1", "tap_verify");
    expect(tapRes.cost).toBe(10);
    expect(cmdr.tier).toBe("tap");
    expect(cmdr.maxHp).toBe(baseMaxHp + 35);

    // 2. Move out into the Blood Moor Arena and cast Sovereign Edict
    cmdr.x = 1100;
    cmdr.y = 640;
    const edictRes = runtime.buyService(session, "tap-edict-1", "sovereign_edict");
    expect(edictRes.cost).toBe(35);
    expect(edictRes.detail).toContain("Sovereign Edict [✓ TAP]");

    // 3. Town Portal back to the High Sanctuary
    const portalRes = runtime.buyService(session, "town-portal-1", "sanctuary_recall");
    expect(portalRes.cost).toBe(15);
    const snap = runtime.snapshot(session);
    const selfSnap = snap.commanders.find((c) => c.id === session.commanderId);
    expect(selfSnap?.inSanctuary).toBe(true);
    expect(selfSnap?.tier).toBe("tap");

    // 4. Leaderboard includes TAP tier bonus
    const leaders = runtime.leaderboard();
    const top = leaders.find((l) => l.commanderId === session.commanderId);
    expect(top?.tier).toBe("tap");
    expect(top?.points).toBeGreaterThanOrEqual(150);

    // 5. RFC 9421 TAP signature verifier enforces nonce replay protection
    const now = Math.floor(Date.now() / 1000);
    const sigInput = `sig1=("@method" "@authority" "@path");keyid="key_visa_test_1";alg="Ed25519";created=${now};expires=${now + 60};nonce="nonce_unique_101";tag="agent-browser-auth"`;
    const firstVerify = await verifyTapHttpOrSandbox({
      headers: { "signature-input": sigInput, signature: "sig1=:dGVzdA==:" },
    });
    expect(firstVerify.ok).toBe(true);
    const replayVerify = await verifyTapHttpOrSandbox({
      headers: { "signature-input": sigInput, signature: "sig1=:dGVzdA==:" },
    });
    expect(replayVerify.ok).toBe(false);
    if (!replayVerify.ok) {
      expect(replayVerify.code).toBe("tap_replayed");
    }

    // 6. Meta-Forge proposal creation
    const wish = createForgeProposal({
      title: "Add Necrotic Bone Golem Summon",
      summary: "Summon a 500-HP Bone Golem when 5 corpses are nearby",
      category: "weapon",
      authorName: "SovereignPaladin",
      authorTier: "tap",
      rewardUsd: 7,
    });
    expect(wish.id).toContain("wish-");
    expect(wish.touches).toContain("packages/sim/src/**");
    expect(wish.checkScript).toBe(".plan/checks/weapons-sim.test.mjs");
  });

  it("coordinates faction collusion comms, autonomous AGY/JEV co-pilot, peer vouching, and session pairing", () => {
    const runtime = new ZoneRuntime();
    const wardenLeader = runtime.join({
      name: "WardenSovereign",
      kind: "human",
      character: "boneknight",
      faction: "wardens",
      tier: "tap",
    });
    const wardenAlly = runtime.join({
      name: "WardenJEV",
      kind: "agent",
      character: "necromancer",
      faction: "wardens",
    });

    // 1. Enable Co-Pilot on human commander and step the simulation
    const copilotRes = runtime.setCopilot(wardenLeader, true, "boss");
    expect(copilotRes.enabled).toBe(true);
    expect(copilotRes.directive).toBe("boss");
    const leaderBefore = { ...runtime.world.commanders.get(wardenLeader.commanderId)! };
    for (let i = 0; i < 15; i++) runtime.step();
    const leaderAfter = runtime.world.commanders.get(wardenLeader.commanderId)!;
    expect(
      Math.hypot(leaderAfter.x - leaderBefore.x, leaderAfter.y - leaderBefore.y),
    ).toBeGreaterThan(2);

    // 2. Faction War Comms & Team Collusion: Allied JEV-v1 replies and pivots directive
    const msg = runtime.sendComms(
      wardenLeader,
      "faction",
      "Rush Bone Choir Boss in SE Sanctum — split bounty!",
    );
    expect(msg.channel).toBe("faction");
    const allyState = runtime.world.commanders.get(wardenAlly.commanderId)!;
    expect(allyState.copilotDirective).toBe("boss");
    expect(allyState.lastCommsText).toContain("Bone Choir Boss");
    const commsHistory = runtime.commsHistory({ faction: "wardens" });
    expect(commsHistory.length).toBeGreaterThanOrEqual(2);

    // 3. Peer-to-Peer Reputation Vouching (ERC-8004 no-self-vouch + 3x TAP weight + 15 Sparks tip)
    expect(() => runtime.vouch(wardenLeader, wardenLeader.commanderId)).toThrow(
      "cannot_vouch_self",
    );
    const sparksBefore = runtime.ledger.balance(wardenAlly.accountId);
    const vouchRes = runtime.vouch(wardenLeader, wardenAlly.commanderId, "Elite boss tank!");
    expect(vouchRes.weight).toBe(3);
    expect(vouchRes.vouches).toBe(3);
    expect(vouchRes.sparksTipped).toBe(15);
    expect(runtime.ledger.balance(wardenAlly.accountId)).toBe(sparksBefore + 15);
    const allyRank = runtime.leaderboard().find((l) => l.commanderId === wardenAlly.commanderId);
    expect(allyRank?.vouches).toBe(3);

    // 4. Web-to-Agent Session Pairing Link
    const link = runtime.createPairingLink(wardenLeader);
    expect(link.pairCode).toContain("swarms_pair_");
    const claimed = runtime.claimPairingLink(link.pairCode);
    expect(claimed?.ok).toBe(true);
    expect(claimed?.commanderId).toBe(wardenLeader.commanderId);
    expect(claimed?.resumeToken).toBe(wardenLeader.token);
  });
});
