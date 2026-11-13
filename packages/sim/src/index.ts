import {
  CHARACTER_IDS,
  CHARACTERS,
  type CharacterId,
  COMMANDER,
  characterForCommanderId,
  LEVELS,
  MONSTER,
  PICKUPS,
  SPELLS,
  UNIT,
  UPGRADE_IDS,
  type UpgradeId,
  WEAPON_IDS,
  WEAPONS,
  type WeaponId,
  xpForLevel,
} from "@swarms/content";
import type {
  AgentTier,
  CommanderSnapshot,
  EntitySnapshot,
  FactionId,
  GameCommand,
  PickupSnapshot,
  ProjectileSnapshot,
  SpellEffect,
  SpellId,
  Vec2,
  WaveStatus,
} from "@swarms/protocol";
import { clamp, distance, TICK_SECONDS } from "@swarms/protocol";
import { type DungeonMap, generateDungeon, insideRect, isWall } from "@swarms/worldgen";

export const PVP_GRACE_TICKS = 240;
export const CAST_RANGE = 720;
export const BOT_LEVEL_CAP = 3;
const RAISE_COOLDOWN_TICKS = 15;
const MAX_ESSENCE_PICKUPS = 250;
const MAX_UTILITY_PICKUPS = 120;
const COMMANDER_ACCEL = 1400;
const COMMANDER_DECEL = 1800;
const ARRIVE_BRAKE_ACCEL = 1200;
const WEAPON_UNLOCK_IDS: UpgradeId[] = ["scatter", "lance", "orbit", "wisp", "scythe"];
const EVOLUTIONS: Partial<Record<UpgradeId, { base: WeaponId; boon: UpgradeId }>> = {
  storm: { base: "bolt", boon: "arcane" },
  hellscatter: { base: "scatter", boon: "might" },
  phantom: { base: "lance", boon: "swift" },
};

export type Stance = "follow" | "attack" | "defend" | "retreat" | "stop";

export interface CommanderState {
  id: string;
  accountId: string;
  name: string;
  kind: "human" | "agent" | "bot";
  teamId: string;
  x: number;
  y: number;
  hp: number;
  command: number;
  essence: number;
  alive: boolean;
  extracted: boolean;
  target: Vec2;
  stance: Stance;
  lastSeq: number;
  spellReadyAt: Record<SpellId, number>;
  hasteUntil: number;
  fangUntil: number;
  shellUntil: number;
  frenzyUntil: number;
  slowUntil: number;
  character: CharacterId;
  faction: FactionId;
  nextShotAt: number;
  raiseReadyAtTick: number;
  steerX: number;
  steerY: number;
  steerUntilTick: number;
  steerActive: boolean;
  vx: number;
  vy: number;
  coasting: boolean;
  spawnedAtTick: number;
  lastGraceBlockTick: number;
  orbitHits: Record<string, number>;
  heading: number;
  weapons: WeaponId[];
  weapon: WeaponId;
  maxHp: number;
  level: number;
  xp: number;
  pendingDrafts: number;
  pendingUpgrades: UpgradeId[];
  pendingExpiresAt: number;
  upgrades: Partial<Record<UpgradeId, number>>;
  carryingItemId?: string | undefined;
  respawnAtTick: number;
  path: Vec2[];
  trail: Vec2[];
  tier?: AgentTier;
  tapKeyId?: string;
  tapRegistry?: string;
  kills?: number;
}

export interface BattleEntity {
  id: string;
  kind: "unit" | "monster";
  ownerId?: string;
  tag: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  radius: number;
  speed: number;
  damage: number;
  attackRange: number;
  cooldown: number;
  slot: number;
  lastAttackerCommanderId?: string;
  homeX?: number;
  homeY?: number;
  slowUntil?: number;
  elite?: boolean;
  alertUntilTick?: number;
  alertX?: number;
  alertY?: number;
  targetId?: string | undefined;
  waveHunter?: boolean;
  huntTargetId?: string;
}

export interface ProjectileState {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  expiresAtTick: number;
  radius: number;
  pierce: number;
  hitIds: string[];
  weapon: WeaponId;
  homing?: boolean;
}

export interface PickupState {
  id: string;
  templateId: keyof typeof PICKUPS;
  x: number;
  y: number;
  bornTick?: number;
}

export type SimEvent =
  | { type: "commander_spawned"; tick: number; commanderId: string }
  | {
      type: "damage";
      tick: number;
      targetId: string;
      amount: number;
      sourceCommanderId?: string;
      blocked?: boolean;
    }
  | {
      type: "death";
      tick: number;
      victimId: string;
      victimKind: "commander" | "unit" | "monster";
      victimTag?: string;
      victimCommanderId?: string;
      killerCommanderId?: string;
    }
  | {
      type: "pickup";
      tick: number;
      commanderId: string;
      itemId: string;
      templateId: string;
    }
  | {
      type: "item_delivered";
      tick: number;
      commanderId: string;
      itemId: string;
      templateId: string;
      destination: "shrine" | "extraction";
    }
  | { type: "commander_extracted"; tick: number; commanderId: string; essence?: number }
  | { type: "spell_cast"; tick: number; commanderId: string; spell: SpellId }
  | { type: "level_up"; tick: number; commanderId: string; level: number }
  | {
      type: "upgrade_chosen";
      tick: number;
      commanderId: string;
      upgrade: UpgradeId;
      auto: boolean;
    }
  | {
      type: "wave_spawned";
      tick: number;
      wave: number;
      title: string;
      count: number;
      targetCommanderId: string;
    };

export interface SerializedSim {
  seed: number;
  tick: number;
  nextEntity: number;
  nextPickup: number;
  commanders: CommanderState[];
  entities: BattleEntity[];
  pickups: PickupState[];
}

function entityId(prefix: string, n: number): string {
  return `${prefix}-${n}`;
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function freshSpellReady(): Record<SpellId, number> {
  return { nova: 0, volley: 0, shell: 0, frost: 0, chain: 0 };
}

function unitCapOf(character: CharacterId, upgrades: Partial<Record<UpgradeId, number>>): number {
  return UNIT.countPerCommander + CHARACTERS[character].unitCapBonus + 2 * (upgrades.brood ?? 0);
}

function starterWeaponFor(character: CharacterId): WeaponId {
  return CHARACTERS[character].starterWeapon;
}

function starterWeaponsFor(character: CharacterId): WeaponId[] {
  return ["bolt", starterWeaponFor(character)];
}

function baseMaxHpFor(
  character: CharacterId,
  upgrades: Partial<Record<UpgradeId, number>>,
): number {
  return (
    Math.round(COMMANDER.maxHp * CHARACTERS[character].maxHpMul) + 25 * (upgrades.vitality ?? 0)
  );
}

function unitHpFor(character: CharacterId): number {
  return Math.round(UNIT.maxHp * CHARACTERS[character].unitHpMul);
}

export class SimWorld {
  readonly map: DungeonMap;
  readonly entryRect: { x: number; y: number; w: number; h: number };
  readonly arenaCenter: Vec2;
  tick = 0;
  private nextEntity = 1;
  private nextPickup = 1;
  readonly commanders = new Map<string, CommanderState>();
  readonly entities = new Map<string, BattleEntity>();
  readonly pickups = new Map<string, PickupState>();
  private pendingCasts: Array<{ commanderId: string; spell: SpellId; target: Vec2 }> = [];
  private chainFx: Array<{ points: Vec2[]; tick: number; expiresAtTick: number }> = [];
  readonly projectiles = new Map<string, ProjectileState>();
  private pendingEvents: SimEvent[] = [];
  waveNumber = 0;
  waveTitle = "Dormant Catacombs";
  nextWaveTick = 1200;
  lastWaveTargetId: string | undefined;
  private lastRelicSiegeTick = -9999;

  constructor(readonly seed = 1337) {
    this.map = generateDungeon(seed);
    const entry = this.map.rooms.find((room) => room.tag === "entry")!;
    this.entryRect = {
      x: entry.x * this.map.tileSize,
      y: entry.y * this.map.tileSize,
      w: entry.w * this.map.tileSize,
      h: entry.h * this.map.tileSize,
    };
    const arena = this.map.rooms.find((room) => room.id === "arena")!;
    this.arenaCenter = {
      x: (arena.x + arena.w / 2) * this.map.tileSize,
      y: (arena.y + arena.h / 2) * this.map.tileSize,
    };
    this.spawnMonsters();
    this.spawnPickup("relic", this.map.relicSpawn.x + 54, this.map.relicSpawn.y);
    this.spawnPickup("haste", this.map.width * 0.55, this.map.height * 0.48);
    this.spawnPickup("fang", this.map.width * 0.38, this.map.height * 0.72);
  }

  private spawnPickup(templateId: PickupState["templateId"], x: number, y: number): void {
    const id = entityId("pickup", this.nextPickup++);
    this.pickups.set(id, { id, templateId, x, y, bornTick: this.tick });
  }

  private makeMonster(spawn: { tag: string; x: number; y: number }): BattleEntity {
    const stats = spawn.tag === "bone-warden" ? MONSTER.boneWarden : MONSTER.skeleton;
    const id = entityId("monster", this.nextEntity++);
    const elite = hashString(`${id}:elite`) % 100 < 8;
    const maxHp = elite ? Math.round(stats.maxHp * 2.2) : stats.maxHp;
    return {
      id,
      kind: "monster",
      tag: spawn.tag,
      x: spawn.x,
      y: spawn.y,
      hp: maxHp,
      maxHp,
      radius: stats.radius,
      speed: elite ? stats.speed * 1.05 : stats.speed,
      damage: elite ? stats.damage * 1.3 : stats.damage,
      attackRange: stats.attackRange,
      cooldown: 0,
      slot: 0,
      homeX: spawn.x,
      homeY: spawn.y,
      ...(elite ? { elite: true } : {}),
    };
  }

  private spawnMonsters(): void {
    for (const spawn of this.map.monsterSpawns) {
      const monster = this.makeMonster(spawn);
      this.entities.set(monster.id, monster);
    }
    this.spawnBoss();
  }

  private spawnBoss(): void {
    const boss = MONSTER.boneChoir;
    this.entities.set("boss-bone-choir", {
      id: "boss-bone-choir",
      kind: "monster",
      tag: "bone-choir",
      x: this.map.bossSpawn.x,
      y: this.map.bossSpawn.y,
      hp: boss.maxHp,
      maxHp: boss.maxHp,
      radius: boss.radius,
      speed: boss.speed,
      damage: boss.damage,
      attackRange: boss.attackRange,
      cooldown: 0,
      slot: 0,
      homeX: this.map.bossSpawn.x,
      homeY: this.map.bossSpawn.y,
    });
  }

  spawnCommander(input: {
    id: string;
    accountId: string;
    name: string;
    kind: CommanderState["kind"];
    character?: CharacterId;
    faction?: FactionId;
    restore?: {
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
    };
  }): SimEvent[] {
    const existing = this.commanders.get(input.id);
    if (existing) return [];
    const fallbackSpawn =
      this.map.spawnPoints.find(
        (sp) => ![...this.commanders.values()].some((c) => Math.hypot(c.x - sp.x, c.y - sp.y) < 20),
      ) ?? this.map.spawnPoints[this.commanders.size % this.map.spawnPoints.length]!;
    const restore = input.restore;
    const spawn =
      restore && this.canStand(restore.x, restore.y, COMMANDER.radius)
        ? { x: restore.x, y: restore.y }
        : fallbackSpawn;
    const alive = restore ? restore.alive && restore.hp > 0 : true;
    const upgrades: Partial<Record<UpgradeId, number>> = { ...(restore?.upgrades ?? {}) };
    const character: CharacterId =
      restore?.character ?? input.character ?? characterForCommanderId(input.id);
    const faction: FactionId =
      restore?.faction ?? input.faction ?? (this.commanders.size % 2 === 0 ? "wardens" : "reapers");
    const maxHp = baseMaxHpFor(character, upgrades);
    const ownedWeapons: WeaponId[] = starterWeaponsFor(character);
    for (const id of restore?.weapons ?? []) {
      if (WEAPON_IDS.includes(id) && !ownedWeapons.includes(id)) ownedWeapons.push(id);
    }
    if ((upgrades.scatter ?? 0) > 0 && !ownedWeapons.includes("scatter"))
      ownedWeapons.push("scatter");
    if ((upgrades.lance ?? 0) > 0 && !ownedWeapons.includes("lance")) ownedWeapons.push("lance");
    const activeWeapon: WeaponId =
      restore?.weapon && ownedWeapons.includes(restore.weapon)
        ? restore.weapon
        : starterWeaponFor(character);
    const commander: CommanderState = {
      id: input.id,
      accountId: input.accountId,
      name: input.name,
      kind: input.kind,
      teamId: input.id,
      x: spawn.x,
      y: spawn.y,
      hp: alive ? Math.min(maxHp, Math.max(1, restore?.hp ?? maxHp)) : 0,
      command: 65,
      essence: restore?.essence ?? 0,
      alive,
      extracted: false,
      target: { ...spawn },
      stance: "follow",
      lastSeq: restore?.lastSeq ?? -1,
      spellReadyAt: freshSpellReady(),
      hasteUntil: 0,
      fangUntil: 0,
      shellUntil: 0,
      frenzyUntil: 0,
      slowUntil: 0,
      character,
      faction,
      nextShotAt: 0,
      raiseReadyAtTick: 0,
      steerX: 0,
      steerY: 0,
      steerUntilTick: 0,
      steerActive: false,
      vx: 0,
      vy: 0,
      coasting: false,
      spawnedAtTick: this.tick,
      lastGraceBlockTick: 0,
      orbitHits: {},
      heading: 0,
      weapons: ownedWeapons,
      weapon: activeWeapon,
      maxHp,
      level: Math.max(1, restore?.level ?? 1),
      xp: Math.max(0, restore?.xp ?? 0),
      pendingDrafts: 0,
      pendingUpgrades: [],
      pendingExpiresAt: 0,
      upgrades,
      respawnAtTick: alive ? 0 : this.tick + 150,
      path: [],
      trail: [{ x: spawn.x, y: spawn.y }],
    };
    this.commanders.set(commander.id, commander);
    const unitCount = alive
      ? Math.min(
          unitCapOf(character, upgrades),
          Math.max(0, restore?.unitCount ?? unitCapOf(character, upgrades)),
        )
      : 0;
    for (let i = 0; i < unitCount; i++) {
      const angle = (i / Math.max(1, unitCount)) * Math.PI * 2;
      const id = entityId("unit", this.nextEntity++);
      this.entities.set(id, {
        id,
        kind: "unit",
        ownerId: commander.id,
        tag: "swarmling",
        x: spawn.x + Math.cos(angle) * 42,
        y: spawn.y + Math.sin(angle) * 42,
        hp: unitHpFor(character),
        maxHp: unitHpFor(character),
        radius: UNIT.radius,
        speed: UNIT.speed,
        damage: UNIT.damage,
        attackRange: UNIT.attackRange,
        cooldown: 0,
        slot: i,
      });
    }
    return [{ type: "commander_spawned", tick: this.tick, commanderId: commander.id }];
  }

  removeCommander(commanderId: string): void {
    const commander = this.commanders.get(commanderId);
    if (!commander) return;
    if (commander.carryingItemId) this.spawnPickup("relic", commander.x, commander.y);
    for (const entity of [...this.entities.values()]) {
      if (entity.ownerId === commanderId) this.entities.delete(entity.id);
    }
    for (const bolt of [...this.projectiles.values()]) {
      if (bolt.ownerId === commanderId) this.projectiles.delete(bolt.id);
    }
    this.commanders.delete(commanderId);
  }

  private inEntry(pos: Vec2): boolean {
    return insideRect(pos, this.entryRect);
  }

  private inEntryMargin(pos: Vec2, margin: number): boolean {
    const r = this.entryRect;
    return (
      pos.x >= r.x - margin &&
      pos.x <= r.x + r.w + margin &&
      pos.y >= r.y - margin &&
      pos.y <= r.y + r.h + margin
    );
  }

  private hasLineOfSight(a: Vec2, b: Vec2): boolean {
    const dist = distance(a, b);
    const steps = Math.max(1, Math.ceil(dist / 10));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (isWall(this.map, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
    }
    return true;
  }

  private castTargetError(
    commander: CommanderState,
    spell: SpellId,
    target: Vec2,
    tolerance = 0,
  ): string | undefined {
    if (spell === "shell" || spell === "frost") return undefined;
    const clamped = this.clampToWorld(target);
    const range = (commander.character === "warlock" ? CAST_RANGE * 1.15 : CAST_RANGE) + tolerance;
    if (distance(commander, clamped) > range) return "cast_out_of_range";
    if (!this.hasLineOfSight(commander, clamped)) return "cast_no_line_of_sight";
    return undefined;
  }

  applyCommand(commanderId: string, seq: number, command: GameCommand): string | undefined {
    const commander = this.commanders.get(commanderId);
    if (!commander) return "unknown_commander";
    if (!commander.alive) return "commander_dead";
    if (commander.extracted) return "commander_extracted";
    if (seq <= commander.lastSeq) return "stale_sequence";
    commander.lastSeq = seq;
    switch (command.type) {
      case "move":
        this.setCommanderTarget(commander, command.target);
        commander.stance = "follow";
        return undefined;
      case "attackMove":
        this.setCommanderTarget(commander, command.target);
        commander.stance = "attack";
        return undefined;
      case "defend":
        this.setCommanderTarget(commander, command.target);
        commander.stance = "defend";
        return undefined;
      case "retreat":
        this.setCommanderTarget(commander, this.map.spawnPoints[0]!);
        commander.stance = "retreat";
        return undefined;
      case "stop":
        commander.coasting = false;
        commander.target = { x: commander.x, y: commander.y };
        commander.path = [];
        commander.stance = "stop";
        return undefined;
      case "extract":
        if (!insideRect(commander, this.map.extraction)) return "not_at_extraction";
        commander.extracted = true;
        commander.alive = false;
        commander.respawnAtTick = this.tick + 150;
        for (const entity of [...this.entities.values()]) {
          if (entity.ownerId === commander.id) this.entities.delete(entity.id);
        }
        if (commander.carryingItemId) {
          this.pendingEvents.push({
            type: "item_delivered",
            tick: this.tick,
            commanderId: commander.id,
            itemId: commander.carryingItemId,
            templateId: "relic",
            destination: "extraction",
          });
          commander.carryingItemId = undefined;
        }
        this.pendingEvents.push({
          type: "commander_extracted",
          tick: this.tick,
          commanderId: commander.id,
          essence: commander.essence,
        });
        return undefined;
      case "cast": {
        const spell = SPELLS[command.spell];
        const isHexChain = commander.character === "warlock" && command.spell === "chain";
        const cost = isHexChain ? 32 : spell.cost;
        const targetError = this.castTargetError(commander, command.spell, command.target);
        if (targetError) return targetError;
        if (commander.command < cost) return "insufficient_command";
        if (this.tick < commander.spellReadyAt[command.spell]) return "spell_on_cooldown";
        commander.command -= cost;
        const baseCooldownTicks = isHexChain ? 120 : spell.cooldownTicks;
        const cooldown = Math.max(
          30,
          Math.round(baseCooldownTicks * 0.88 ** this.stacks(commander, "arcane")),
        );
        commander.spellReadyAt[command.spell] = this.tick + cooldown;
        if (command.spell !== "shell" && !this.inEntry(commander)) this.expireGrace(commander);
        this.pendingCasts.push({
          commanderId: commander.id,
          spell: command.spell,
          target: this.clampToWorld(command.target),
        });
        return undefined;
      }
      case "chooseUpgrade": {
        if (!commander.pendingUpgrades.includes(command.upgrade)) return "upgrade_not_offered";
        if (commander.pendingDrafts <= 0) return "no_pending_upgrade";
        this.applyUpgrade(commander, command.upgrade, false, this.pendingEvents);
        commander.pendingDrafts -= 1;
        commander.pendingUpgrades = [];
        commander.pendingExpiresAt = 0;
        return undefined;
      }
      case "shoot": {
        if (this.inEntry(commander)) return undefined;
        if (commander.weapon === "orbit") return undefined;
        if (this.tick < commander.nextShotAt) return undefined;
        const dx = command.target.x - commander.x;
        const dy = command.target.y - commander.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return undefined;
        this.expireGrace(commander);
        const weapon = WEAPONS[commander.weapon];
        const charStats = CHARACTERS[commander.character];
        const levelBonus = Math.max(0, commander.level - 1);
        const speed = weapon.speed * charStats.weaponSpeedMul;
        const lifeTicks = Math.round(
          weapon.lifeTicks * charStats.weaponRangeMul * (1 + Math.min(0.24, levelBonus * 0.03)),
        );
        const radius =
          Math.round(
            weapon.radius * charStats.weaponSizeMul * (1 + Math.min(0.16, levelBonus * 0.02)) * 10,
          ) / 10;
        commander.nextShotAt = this.tick + weapon.cooldownTicks;
        const baseAngle = Math.atan2(dy, dx);
        for (let i = 0; i < weapon.pellets; i++) {
          const angle = baseAngle + (i - (weapon.pellets - 1) / 2) * weapon.spreadRad;
          const ux = Math.cos(angle);
          const uy = Math.sin(angle);
          const id = `bolt-${this.nextEntity++}`;
          this.projectiles.set(id, {
            id,
            ownerId: commander.id,
            x: commander.x + ux * (COMMANDER.radius + 6),
            y: commander.y + uy * (COMMANDER.radius + 6),
            vx: ux * speed,
            vy: uy * speed,
            damage: weapon.damage * charStats.spellMul,
            expiresAtTick: this.tick + lifeTicks,
            radius,
            pierce: weapon.pierce,
            hitIds: [],
            weapon: commander.weapon,
            ...(commander.weapon === "wisp" ? { homing: true } : {}),
          });
        }
        return undefined;
      }
      case "steer": {
        const len = Math.hypot(command.dx, command.dy);
        const scale = len > 1 ? 1 / len : 1;
        commander.steerX = command.dx * scale;
        commander.steerY = command.dy * scale;
        commander.steerUntilTick = this.tick + 12;
        if (len > 0) commander.coasting = false;
        return undefined;
      }
      case "switchWeapon": {
        if (!commander.weapons.includes(command.weapon)) return "weapon_not_owned";
        commander.weapon = command.weapon;
        return undefined;
      }
      case "raiseUnit": {
        if (this.inEntry(commander)) return "sanctuary_regrows_free";
        if (this.tick < commander.raiseReadyAtTick) return "raise_on_cooldown";
        const owned = [...this.entities.values()].filter((e) => e.ownerId === commander.id).length;
        if (owned >= unitCapOf(commander.character, commander.upgrades)) return "swarm_at_cap";
        const cost = CHARACTERS[commander.character].raiseCost;
        if (commander.essence < cost) return "insufficient_essence";
        if (!this.spawnUnitFor(commander)) return "swarm_at_cap";
        commander.essence -= cost;
        commander.raiseReadyAtTick = this.tick + RAISE_COOLDOWN_TICKS;
        this.expireGrace(commander);
        return undefined;
      }
    }
  }

  private setCommanderTarget(commander: CommanderState, target: Vec2): void {
    commander.coasting = false;
    commander.target = this.clampToWorld(target);
    commander.path = this.computePath(commander, commander.target);
  }

  private nearestFloorTile(tx: number, ty: number): { x: number; y: number } {
    let best = { x: tx, y: ty };
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let y = 1; y < this.map.heightTiles - 1; y++) {
      for (let x = 1; x < this.map.widthTiles - 1; x++) {
        if (this.map.wallSet.has(`${x},${y}`)) continue;
        const d = Math.abs(x - tx) + Math.abs(y - ty);
        if (d < bestDistance) {
          best = { x, y };
          bestDistance = d;
        }
      }
    }
    return best;
  }

  private computePath(from: Vec2, to: Vec2): Vec2[] {
    const tile = this.map.tileSize;
    const start = this.nearestFloorTile(Math.floor(from.x / tile), Math.floor(from.y / tile));
    const goal = this.nearestFloorTile(Math.floor(to.x / tile), Math.floor(to.y / tile));
    const key = (x: number, y: number) => `${x},${y}`;
    const queue: Array<{ x: number; y: number }> = [start];
    const came = new Map<string, string>();
    const seen = new Set([key(start.x, start.y)]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor]!;
      if (current.x === goal.x && current.y === goal.y) break;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        const nk = key(nx, ny);
        if (seen.has(nk) || this.map.wallSet.has(nk)) continue;
        seen.add(nk);
        came.set(nk, key(current.x, current.y));
        queue.push({ x: nx, y: ny });
      }
    }
    if (!seen.has(key(goal.x, goal.y))) return [to];
    const tiles: Array<{ x: number; y: number }> = [];
    let current: string | undefined = key(goal.x, goal.y);
    while (current && current !== key(start.x, start.y)) {
      const [x, y] = current.split(",").map(Number);
      tiles.push({ x: x!, y: y! });
      current = came.get(current);
    }
    tiles.reverse();
    const simplified = tiles.filter((_, i) => i % 2 === 1 || i === tiles.length - 1);
    return [...simplified.map((t) => ({ x: (t.x + 0.5) * tile, y: (t.y + 0.5) * tile })), to];
  }

  private respawnDeadCommanders(events: SimEvent[]): void {
    const commanderList = [...this.commanders.values()];
    commanderList.forEach((commander, index) => {
      if (commander.alive || this.tick < commander.respawnAtTick || commander.respawnAtTick === 0)
        return;
      for (const entity of [...this.entities.values()]) {
        if (entity.ownerId === commander.id) this.entities.delete(entity.id);
      }
      const spawn = this.map.spawnPoints[index % this.map.spawnPoints.length]!;
      commander.x = spawn.x;
      commander.y = spawn.y;
      commander.hp = baseMaxHpFor(commander.character, {});
      commander.command = 65;
      commander.essence = 0;
      commander.alive = true;
      commander.extracted = false;
      commander.target = { ...spawn };
      commander.path = [];
      commander.trail = [{ ...spawn }];
      commander.stance = "follow";
      commander.carryingItemId = undefined;
      commander.spellReadyAt = freshSpellReady();
      commander.hasteUntil = 0;
      commander.fangUntil = 0;
      commander.shellUntil = 0;
      commander.frenzyUntil = 0;
      commander.slowUntil = 0;
      commander.maxHp = baseMaxHpFor(commander.character, {});
      commander.nextShotAt = 0;
      commander.raiseReadyAtTick = 0;
      commander.level = 1;
      commander.xp = 0;
      commander.pendingDrafts = 0;
      commander.pendingUpgrades = [];
      commander.pendingExpiresAt = 0;
      commander.upgrades = {};
      commander.weapons = starterWeaponsFor(commander.character);
      commander.weapon = starterWeaponFor(commander.character);
      commander.steerX = 0;
      commander.steerY = 0;
      commander.steerUntilTick = 0;
      commander.steerActive = false;
      commander.vx = 0;
      commander.vy = 0;
      commander.coasting = false;
      commander.spawnedAtTick = this.tick;
      commander.lastGraceBlockTick = 0;
      commander.orbitHits = {};
      const respawnCap = unitCapOf(commander.character, commander.upgrades);
      for (let i = 0; i < respawnCap; i++) {
        const angle = (i / respawnCap) * Math.PI * 2;
        const id = entityId("unit", this.nextEntity++);
        this.entities.set(id, {
          id,
          kind: "unit",
          ownerId: commander.id,
          tag: "swarmling",
          x: spawn.x + Math.cos(angle) * 42,
          y: spawn.y + Math.sin(angle) * 42,
          hp: unitHpFor(commander.character),
          maxHp: unitHpFor(commander.character),
          radius: UNIT.radius,
          speed: UNIT.speed,
          damage: UNIT.damage,
          attackRange: UNIT.attackRange,
          cooldown: 0,
          slot: i,
        });
      }
      events.push({ type: "commander_spawned", tick: this.tick, commanderId: commander.id });
    });
  }

  private stacks(commander: CommanderState, upgrade: UpgradeId): number {
    return commander.upgrades[upgrade] ?? 0;
  }

  private swiftMul(commander: CommanderState): number {
    return 1 + 0.08 * this.stacks(commander, "swift");
  }

  private graceTicksLeft(commander: CommanderState): number {
    return Math.max(0, PVP_GRACE_TICKS - (this.tick - commander.spawnedAtTick));
  }

  private isGraced(commander: CommanderState): boolean {
    return this.graceTicksLeft(commander) > 0;
  }

  private expireGrace(commander: CommanderState): void {
    if (this.isGraced(commander)) commander.spawnedAtTick = this.tick - PVP_GRACE_TICKS;
  }

  private notePvPOffense(
    sourceCommanderId: string | undefined,
    targetCommanderId: string | undefined,
  ): void {
    if (!sourceCommanderId || !targetCommanderId || sourceCommanderId === targetCommanderId) return;
    const source = this.commanders.get(sourceCommanderId);
    if (source) this.expireGrace(source);
  }

  private slowMul(slowUntil: number | undefined): number {
    return slowUntil !== undefined && this.tick < slowUntil ? SPELLS.frost.slowFactor : 1;
  }

  private commanderSpeed(commander: CommanderState, cohesionScale = 1): number {
    return (
      COMMANDER.speed *
      cohesionScale *
      (this.tick < commander.hasteUntil ? 1.3 : 1) *
      this.swiftMul(commander) *
      this.slowMul(commander.slowUntil) *
      CHARACTERS[commander.character].speedMul
    );
  }

  private grantXp(commander: CommanderState, amount: number, events: SimEvent[]): void {
    if (!commander.alive || amount <= 0) return;
    if (commander.kind === "bot" && commander.level >= BOT_LEVEL_CAP) {
      commander.xp = 0;
      return;
    }
    commander.xp += amount;
    while (commander.xp >= xpForLevel(commander.level)) {
      commander.xp -= xpForLevel(commander.level);
      commander.level += 1;
      commander.pendingDrafts += 1;
      events.push({
        type: "level_up",
        tick: this.tick,
        commanderId: commander.id,
        level: commander.level,
      });
      if (commander.kind === "bot" && commander.level >= BOT_LEVEL_CAP) {
        commander.xp = 0;
        break;
      }
    }
  }

  private rollDraft(commander: CommanderState): UpgradeId[] {
    const pool = UPGRADE_IDS.filter((id) => {
      const evo = EVOLUTIONS[id];
      if (evo) {
        return (
          commander.kind !== "bot" &&
          commander.weapons.includes(evo.base) &&
          !commander.weapons.includes(id as WeaponId) &&
          this.stacks(commander, evo.boon) >= 2
        );
      }
      if (WEAPON_UNLOCK_IDS.includes(id)) {
        if (commander.kind === "bot") return false;
        if (commander.weapons.includes(id as WeaponId)) return false;
        const evolved = (Object.keys(EVOLUTIONS) as UpgradeId[]).find(
          (e) => EVOLUTIONS[e]?.base === id,
        );
        if (evolved && commander.weapons.includes(evolved as WeaponId)) return false;
      }
      return true;
    });
    const affinities = CHARACTERS[commander.character].draftAffinity as readonly UpgradeId[];
    const draftScore = (id: UpgradeId): number => {
      const hash = hashString(`${commander.id}:${commander.level}:${this.tick}:${id}`);
      const uniform = ((hash % 9999) + 1) / 10000;
      return -Math.log(uniform) / (affinities.includes(id) ? 2.2 : 1);
    };
    return [...pool].sort((a, b) => draftScore(a) - draftScore(b)).slice(0, 3);
  }

  private autoPick(commander: CommanderState): UpgradeId {
    const offered = commander.pendingUpgrades;
    if (commander.hp < commander.maxHp * 0.4 && offered.includes("vitality")) return "vitality";
    const owned = [...this.entities.values()].filter(
      (e) => e.ownerId === commander.id && e.hp > 0,
    ).length;
    if (owned < unitCapOf(commander.character, commander.upgrades) / 2 && offered.includes("brood"))
      return "brood";
    const nonWeapon = offered.find((id) => !WEAPON_UNLOCK_IDS.includes(id) && !EVOLUTIONS[id]);
    return nonWeapon ?? offered[0] ?? "might";
  }

  private applyUpgrade(
    commander: CommanderState,
    upgrade: UpgradeId,
    auto: boolean,
    events: SimEvent[],
  ): void {
    commander.upgrades[upgrade] = this.stacks(commander, upgrade) + 1;
    if (upgrade === "vitality") {
      commander.maxHp += 25;
      commander.hp = Math.min(commander.maxHp, commander.hp + 25);
    }
    if (WEAPON_UNLOCK_IDS.includes(upgrade)) {
      const weaponId = upgrade as WeaponId;
      if (!commander.weapons.includes(weaponId)) commander.weapons.push(weaponId);
      commander.weapon = weaponId;
    }
    const evo = EVOLUTIONS[upgrade];
    if (evo) {
      const evoId = upgrade as WeaponId;
      const idx = commander.weapons.indexOf(evo.base);
      if (idx >= 0) commander.weapons[idx] = evoId;
      else if (!commander.weapons.includes(evoId)) commander.weapons.push(evoId);
      commander.weapon = evoId;
    }
    events.push({
      type: "upgrade_chosen",
      tick: this.tick,
      commanderId: commander.id,
      upgrade,
      auto,
    });
  }

  private processDrafts(events: SimEvent[]): void {
    for (const commander of this.commanders.values()) {
      if (!commander.alive || commander.pendingDrafts <= 0) continue;
      if (commander.pendingUpgrades.length === 0) {
        commander.pendingUpgrades = this.rollDraft(commander);
        commander.pendingExpiresAt = this.tick + LEVELS.draftTicks;
      }
      if (commander.kind === "bot" || this.tick >= commander.pendingExpiresAt) {
        this.applyUpgrade(commander, this.autoPick(commander), true, events);
        commander.pendingDrafts -= 1;
        commander.pendingUpgrades = [];
        commander.pendingExpiresAt = 0;
      }
    }
  }

  step(): SimEvent[] {
    const events: SimEvent[] = [...this.pendingEvents.splice(0)];
    this.tick++;
    this.chainFx = this.chainFx.filter((fx) => fx.expiresAtTick > this.tick);
    this.respawnDeadCommanders(events);
    for (const cast of this.pendingCasts.splice(0)) this.resolveCast(cast, events);
    this.moveCommanders();
    this.sanctuary();
    this.moveUnits(events);
    this.separateUnits();
    this.updateProjectiles(events);
    this.updateOrbits(events);
    this.moveMonsters(events);
    this.updatePickups(events);
    this.removeDead(events);
    this.processDrafts(events);
    if (this.tick % 900 === 0) this.respawnMonsters();
    if (this.tick >= this.nextWaveTick) {
      this.nextWaveTick = this.tick + 1200;
      const result = this.spawnHunterWave();
      if (result.count > 0 && result.targetCommanderId) {
        events.push({
          type: "wave_spawned",
          tick: this.tick,
          wave: result.wave,
          title: result.title,
          count: result.count,
          targetCommanderId: result.targetCommanderId,
        });
      }
    }
    for (const commander of this.commanders.values()) {
      if (commander.alive) {
        const tapRegenMul = commander.tier === "tap" ? 1.25 : 1;
        commander.command = clamp(
          commander.command +
            COMMANDER.commandRegenPerSecond *
              TICK_SECONDS *
              CHARACTERS[commander.character].regenMul *
              tapRegenMul,
          0,
          COMMANDER.maxCommand,
        );
      }
    }
    return events;
  }

  private clampToWorld(target: Vec2): Vec2 {
    return {
      x: clamp(target.x, this.map.tileSize, this.map.width - this.map.tileSize),
      y: clamp(target.y, this.map.tileSize, this.map.height - this.map.tileSize),
    };
  }

  private canStand(x: number, y: number, radius: number): boolean {
    return (
      !isWall(this.map, x, y) &&
      !isWall(this.map, x - radius, y) &&
      !isWall(this.map, x + radius, y) &&
      !isWall(this.map, x, y - radius) &&
      !isWall(this.map, x, y + radius)
    );
  }

  private moveBody(
    body: { x: number; y: number },
    target: Vec2,
    speed: number,
    radius: number,
  ): void {
    const dx = target.x - body.x;
    const dy = target.y - body.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return;
    const step = Math.min(dist, speed * TICK_SECONDS);
    const nx = body.x + (dx / dist) * step;
    const ny = body.y + (dy / dist) * step;
    if (this.canStand(nx, body.y, radius)) body.x = nx;
    if (this.canStand(body.x, ny, radius)) body.y = ny;
  }

  private moveCommanders(): void {
    for (const commander of this.commanders.values()) {
      if (!commander.alive || commander.extracted) continue;
      const steering =
        this.tick < commander.steerUntilTick && (commander.steerX !== 0 || commander.steerY !== 0);
      if (steering) commander.coasting = false;
      else if (commander.steerActive && commander.path.length === 0) {
        if (Math.hypot(commander.vx, commander.vy) > 1) commander.coasting = true;
        else commander.target = { x: commander.x, y: commander.y };
      }
      commander.steerActive = steering;
      let cohesionScale = 1;
      if (!steering) {
        const unitDistances = [...this.entities.values()]
          .filter((e) => e.ownerId === commander.id && e.hp > 0)
          .map((e) => distance(e, commander))
          .sort((a, b) => a - b);
        const medianDistance = unitDistances[Math.floor(unitDistances.length / 2)] ?? 0;
        cohesionScale = clamp(1.25 - medianDistance / 340, 0.45, 1);
      }
      const speed = this.commanderSpeed(commander, cohesionScale);
      let desiredX = 0;
      let desiredY = 0;
      if (steering) {
        desiredX = commander.steerX * speed;
        desiredY = commander.steerY * speed;
      } else if (commander.coasting) {
        desiredX = 0;
        desiredY = 0;
      } else if (commander.stance !== "stop") {
        const waypoint = commander.path[0] ?? commander.target;
        const dx = waypoint.x - commander.x;
        const dy = waypoint.y - commander.y;
        const dist = Math.hypot(dx, dy);
        const isFinal = commander.path.length <= 1;
        if (dist > 0.5 && !(isFinal && dist <= 6)) {
          const arrive = Math.min(speed, Math.sqrt(2 * ARRIVE_BRAKE_ACCEL * dist));
          desiredX = (dx / dist) * arrive;
          desiredY = (dy / dist) * arrive;
        }
        if (commander.path.length > 0 && dist < 10) commander.path.shift();
      }
      const dvx = desiredX - commander.vx;
      const dvy = desiredY - commander.vy;
      const dv = Math.hypot(dvx, dvy);
      const slowing = Math.hypot(desiredX, desiredY) < Math.hypot(commander.vx, commander.vy);
      const maxDelta = (slowing ? COMMANDER_DECEL : COMMANDER_ACCEL) * TICK_SECONDS;
      if (dv <= maxDelta) {
        commander.vx = desiredX;
        commander.vy = desiredY;
      } else {
        commander.vx += (dvx / dv) * maxDelta;
        commander.vy += (dvy / dv) * maxDelta;
      }
      const nx = commander.x + commander.vx * TICK_SECONDS;
      const ny = commander.y + commander.vy * TICK_SECONDS;
      if (this.canStand(nx, commander.y, COMMANDER.radius)) commander.x = nx;
      else commander.vx = 0;
      if (this.canStand(commander.x, ny, COMMANDER.radius)) commander.y = ny;
      else commander.vy = 0;
      if (commander.coasting && Math.hypot(commander.vx, commander.vy) < 5) {
        commander.coasting = false;
        commander.vx = 0;
        commander.vy = 0;
        commander.target = { x: commander.x, y: commander.y };
      }
      if (Math.hypot(commander.vx, commander.vy) > 40)
        commander.heading = Math.atan2(commander.vy, commander.vx);
      commander.trail.push({ x: commander.x, y: commander.y });
      if (commander.trail.length > 240) commander.trail.splice(0, commander.trail.length - 240);
    }
  }

  spawnMercenaries(commanderId: string, count = 2): number {
    const commander = this.commanders.get(commanderId);
    if (!commander?.alive || commander.extracted) return 0;
    const owned = [...this.entities.values()].filter((e) => e.ownerId === commander.id && e.hp > 0);
    const maxWithMercs = unitCapOf(commander.character, commander.upgrades) + 4;
    const allowed = Math.max(0, Math.min(count, maxWithMercs - owned.length));
    if (allowed <= 0) return 0;
    const usedSlots = new Set(owned.map((e) => e.slot));
    let spawned = 0;
    for (let m = 0; m < allowed; m++) {
      let slot = 0;
      while (usedSlots.has(slot)) slot++;
      usedSlots.add(slot);
      const baseAngle = (slot / Math.max(1, maxWithMercs)) * Math.PI * 2;
      let point = { x: commander.x, y: commander.y };
      outer: for (const radius of [36, 48, 24]) {
        for (let step = 0; step < 12; step++) {
          const angle = baseAngle + (step * Math.PI) / 6;
          const candidate = {
            x: commander.x + Math.cos(angle) * radius,
            y: commander.y + Math.sin(angle) * radius,
          };
          if (this.canStand(candidate.x, candidate.y, 10)) {
            point = candidate;
            break outer;
          }
        }
      }
      const id = entityId("unit", this.nextEntity++);
      const mercHp = Math.round(unitHpFor(commander.character) * 1.75);
      this.entities.set(id, {
        id,
        kind: "unit",
        ownerId: commander.id,
        tag: "mercenary",
        x: point.x,
        y: point.y,
        hp: mercHp,
        maxHp: mercHp,
        radius: 10,
        speed: UNIT.speed * 1.05,
        damage: Math.round(UNIT.damage * 1.45),
        attackRange: UNIT.attackRange + 8,
        cooldown: 0,
        slot,
        elite: true,
      });
      spawned++;
    }
    return spawned;
  }

  grantWeaponSeal(commanderId: string): { weapon?: WeaponId; drafted?: boolean } {
    const commander = this.commanders.get(commanderId);
    if (!commander?.alive || commander.extracted) return {};
    const unowned = WEAPON_UNLOCK_IDS.filter((id) => {
      if (commander.weapons.includes(id as WeaponId)) return false;
      const evolved = (Object.keys(EVOLUTIONS) as UpgradeId[]).find(
        (e) => EVOLUTIONS[e]?.base === id,
      );
      if (evolved && commander.weapons.includes(evolved as WeaponId)) return false;
      return true;
    });
    if (unowned.length > 0) {
      const idx =
        hashString(`${commander.id}:seal:${this.tick}:${commander.weapons.length}`) %
        unowned.length;
      const chosen = unowned[idx]!;
      this.applyUpgrade(commander, chosen, false, this.pendingEvents);
      return { weapon: chosen as WeaponId };
    }
    commander.pendingDrafts += 1;
    return { drafted: true };
  }

  promoteTapTier(commanderId: string, tapKeyId?: string, tapRegistry?: string): number {
    const commander = this.commanders.get(commanderId);
    if (!commander) return 0;
    const wasTap = commander.tier === "tap";
    commander.tier = "tap";
    commander.tapKeyId = tapKeyId ?? `tap_${commander.id.replace(/[^a-zA-Z0-9]/g, "")}`;
    commander.tapRegistry = tapRegistry ?? "visa-tap-registry";
    if (!wasTap) {
      commander.maxHp += 35;
      commander.hp = Math.min(commander.maxHp, commander.hp + 35);
      commander.command = COMMANDER.maxCommand;
    }
    return this.spawnMercenaries(commanderId, 3);
  }

  triggerSovereignEdict(commanderId: string): { hits: number; kills: number } {
    const commander = this.commanders.get(commanderId);
    if (!commander?.alive || commander.extracted) return { hits: 0, kills: 0 };
    if (commander.tier !== "tap") {
      this.promoteTapTier(commanderId);
    }
    commander.hasteUntil = Math.max(commander.hasteUntil, this.tick + 240);
    commander.frenzyUntil = Math.max(commander.frenzyUntil, this.tick + 240);
    commander.shellUntil = Math.max(commander.shellUntil, this.tick + 150);
    const radius = 220;
    const damage = 160;
    let hits = 0;
    let kills = 0;
    const spokes: Vec2[] = [{ x: commander.x, y: commander.y }];
    for (const entity of this.entities.values()) {
      if (entity.hp <= 0 || entity.ownerId === commander.id) continue;
      if (entity.ownerId) {
        const owner = this.commanders.get(entity.ownerId);
        if (owner && owner.faction === commander.faction) continue;
      }
      if (distance(commander, entity) <= radius) {
        entity.hp = Math.max(0, entity.hp - damage);
        entity.lastAttackerCommanderId = commander.id;
        hits++;
        if (entity.hp <= 0) kills++;
        if (spokes.length < 9) spokes.push({ x: entity.x, y: entity.y });
      }
    }
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      this.chainFx.push({
        points: [
          { x: commander.x, y: commander.y },
          {
            x: commander.x + Math.cos(ang) * (radius * 0.85),
            y: commander.y + Math.sin(ang) * (radius * 0.85),
          },
        ],
        tick: this.tick,
        expiresAtTick: this.tick + 18,
      });
    }
    return { hits, kills };
  }

  recallToSanctuary(commanderId: string): boolean {
    const commander = this.commanders.get(commanderId);
    if (!commander?.alive || commander.extracted) return false;
    const dest = {
      x: this.entryRect.x + this.entryRect.w * 0.5,
      y: this.entryRect.y + this.entryRect.h * 0.5,
    };
    commander.x = dest.x;
    commander.y = dest.y;
    commander.vx = 0;
    commander.vy = 0;
    commander.target = { ...dest };
    commander.path = [];
    commander.hp = Math.min(commander.maxHp, commander.hp + 90);
    commander.command = COMMANDER.maxCommand;
    commander.slowUntil = 0;
    commander.spawnedAtTick = this.tick;
    const owned = [...this.entities.values()].filter((e) => e.ownerId === commander.id && e.hp > 0);
    owned.forEach((unit, idx) => {
      const ang = (idx / Math.max(1, owned.length)) * Math.PI * 2;
      unit.x = dest.x + Math.cos(ang) * 38;
      unit.y = dest.y + Math.sin(ang) * 38;
      unit.hp = unit.maxHp;
    });
    return true;
  }

  private spawnUnitFor(commander: CommanderState): boolean {
    const owned = [...this.entities.values()].filter((e) => e.ownerId === commander.id);
    const cap = unitCapOf(commander.character, commander.upgrades);
    if (owned.length >= cap) return false;
    const usedSlots = new Set(owned.map((e) => e.slot));
    let slot = 0;
    while (usedSlots.has(slot)) slot++;
    const baseAngle = (slot / cap) * Math.PI * 2;
    let point = { x: commander.x, y: commander.y };
    outer: for (const radius of [42, 30, 18]) {
      for (let step = 0; step < 12; step++) {
        const angle = baseAngle + (step * Math.PI) / 6;
        const candidate = {
          x: commander.x + Math.cos(angle) * radius,
          y: commander.y + Math.sin(angle) * radius,
        };
        if (this.canStand(candidate.x, candidate.y, UNIT.radius)) {
          point = candidate;
          break outer;
        }
      }
    }
    const id = entityId("unit", this.nextEntity++);
    this.entities.set(id, {
      id,
      kind: "unit",
      ownerId: commander.id,
      tag: "swarmling",
      x: point.x,
      y: point.y,
      hp: unitHpFor(commander.character),
      maxHp: unitHpFor(commander.character),
      radius: UNIT.radius,
      speed: UNIT.speed,
      damage: UNIT.damage,
      attackRange: UNIT.attackRange,
      cooldown: 0,
      slot,
    });
    return true;
  }

  private sanctuary(): void {
    for (const commander of this.commanders.values()) {
      if (!commander.alive || commander.extracted || !this.inEntry(commander)) continue;
      commander.hp = Math.min(commander.maxHp, commander.hp + 25 * TICK_SECONDS);
      if (this.isGraced(commander)) commander.spawnedAtTick = this.tick;
      if (this.tick % 60 !== 0) continue;
      this.spawnUnitFor(commander);
    }
  }

  private formationOffset(commander: CommanderState, slot: number): Vec2 {
    if (commander.stance === "attack") {
      const wedge: Vec2[] = [
        { x: 52, y: 0 },
        { x: 30, y: -20 },
        { x: 30, y: 0 },
        { x: 30, y: 20 },
        { x: 8, y: -40 },
        { x: 8, y: -20 },
        { x: 8, y: 0 },
        { x: 8, y: 20 },
        { x: 8, y: 40 },
        { x: -14, y: -40 },
        { x: -14, y: -20 },
        { x: -14, y: 0 },
        { x: -14, y: 20 },
        { x: -14, y: 40 },
      ];
      const point = wedge[slot];
      if (point) return point;
      const extra = slot - wedge.length;
      const wing = Math.floor(extra / 2);
      const side = extra % 2 === 0 ? -1 : 1;
      const row = Math.floor(wing / 2);
      return {
        x: (wing % 2 === 0 ? 8 : -14) - row * 22,
        y: side * (60 + row * 20),
      };
    }
    const cap = unitCapOf(commander.character, commander.upgrades);
    const innerCount = Math.min(6, cap);
    const defend = commander.stance === "defend";
    if (slot < innerCount) {
      const angle = (slot / innerCount) * Math.PI * 2;
      const ring = defend ? 48 : 30;
      return { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring };
    }
    const outerIndex = slot - innerCount;
    const outerCount = Math.max(1, cap - innerCount);
    const angle = (outerIndex / outerCount) * Math.PI * 2 + Math.PI / outerCount;
    const ring = defend ? 82 : 54;
    return { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring };
  }

  private formationPoint(commander: CommanderState, slot: number, _from: Vec2): Vec2 {
    const base = this.formationOffset(commander, slot);
    const len = commander.trail.length;
    const anchor =
      commander.stance === "attack"
        ? commander
        : (commander.trail[Math.max(0, len - 1 - 3)] ?? commander);
    const heading = commander.heading;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const offset = { x: base.x * cos - base.y * sin, y: base.x * sin + base.y * cos };
    for (const scale of [1, 0.66, 0.33]) {
      const point = { x: anchor.x + offset.x * scale, y: anchor.y + offset.y * scale };
      if (this.canStand(point.x, point.y, UNIT.radius)) return point;
    }
    return { x: anchor.x, y: anchor.y };
  }

  private formationTargetFor(unit: BattleEntity, owner: CommanderState): Vec2 {
    const point = this.formationPoint(owner, unit.slot, unit);
    if (this.hasLineOfSight(unit, point)) return point;
    const trail = owner.trail;
    for (let i = trail.length - 1; i >= 0; i--) {
      const crumb = trail[i]!;
      if (this.hasLineOfSight(unit, crumb)) {
        const prev = trail[Math.max(0, i - 1)] ?? owner;
        const dx = crumb.x - prev.x;
        const dy = crumb.y - prev.y;
        const len = Math.hypot(dx, dy);
        const lane = ((unit.slot % 3) - 1) * 14;
        if (len > 0.5 && lane !== 0) {
          const nx = -dy / len;
          const ny = dx / len;
          const candidate = { x: crumb.x + nx * lane, y: crumb.y + ny * lane };
          if (
            this.canStand(candidate.x, candidate.y, unit.radius) &&
            this.hasLineOfSight(unit, candidate)
          ) {
            return candidate;
          }
        }
        return crumb;
      }
    }
    return point;
  }

  private separateUnits(): void {
    const units = [...this.entities.values()].filter((e) => e.kind === "unit" && e.hp > 0);
    for (let i = 0; i < units.length; i++) {
      const a = units[i]!;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j]!;
        if (a.ownerId !== b.ownerId) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist === 0 || dist >= 18) continue;
        const push = Math.min((18 - dist) / 2, 2.5);
        const ux = (dx / dist) * push;
        const uy = (dy / dist) * push;
        if (this.canStand(a.x - ux, a.y, a.radius)) a.x -= ux;
        if (this.canStand(a.x, a.y - uy, a.radius)) a.y -= uy;
        if (this.canStand(b.x + ux, b.y, b.radius)) b.x += ux;
        if (this.canStand(b.x, b.y + uy, b.radius)) b.y += uy;
      }
    }
  }

  private nearestEnemyForUnit(
    unit: BattleEntity,
    owner: CommanderState,
  ): BattleEntity | CommanderState | undefined {
    if (this.inEntry(unit) || this.inEntry(owner)) return undefined;
    let best: BattleEntity | CommanderState | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    const crowdPenalty = (targetId: string): number => {
      let n = 0;
      for (const e of this.entities.values()) {
        if (e.kind !== "unit" || e.ownerId !== unit.ownerId || e.id === unit.id || e.hp <= 0)
          continue;
        if (e.targetId === targetId) n++;
      }
      return n * 60;
    };
    for (const entity of this.entities.values()) {
      if (entity.hp <= 0 || entity.ownerId === unit.ownerId) continue;
      if (entity.kind === "unit" && this.inEntry(entity)) continue;
      if (owner.kind === "bot" && entity.kind === "unit") {
        if (this.inEntryMargin(entity, 64)) continue;
        const targetOwner = entity.ownerId ? this.commanders.get(entity.ownerId) : undefined;
        if (targetOwner && targetOwner.kind !== "bot" && targetOwner.level < 3) continue;
      }
      if (distance(entity, owner) > (owner.stance === "defend" ? 110 : 170)) continue;
      const d = distance(unit, entity);
      if (d >= 420) continue;
      const score = d + crowdPenalty(entity.id);
      if (score < bestScore && this.hasLineOfSight(unit, entity)) {
        best = entity;
        bestScore = score;
      }
    }
    for (const commander of this.commanders.values()) {
      if (!commander.alive || commander.id === unit.ownerId) continue;
      if (this.inEntry(commander)) continue;
      if (owner.kind === "bot") {
        if (this.inEntryMargin(commander, 64)) continue;
        if (commander.kind !== "bot" && commander.level < 3) continue;
      }
      if (distance(commander, owner) > (owner.stance === "defend" ? 110 : 170)) continue;
      const d = distance(unit, commander);
      if (d >= 420) continue;
      const score = d + crowdPenalty(commander.id);
      if (score < bestScore && this.hasLineOfSight(unit, commander)) {
        best = commander;
        bestScore = score;
      }
    }
    return best;
  }

  private nearestVictimForMonster(
    monster: BattleEntity,
  ): BattleEntity | CommanderState | undefined {
    let best: BattleEntity | CommanderState | undefined;
    let bestDistance =
      monster.alertUntilTick !== undefined && this.tick < monster.alertUntilTick ? 620 : 460;
    for (const entity of this.entities.values()) {
      if (entity.kind !== "unit" || entity.hp <= 0 || this.inEntryMargin(entity, 64)) continue;
      const d = distance(monster, entity);
      if (d < bestDistance && this.hasLineOfSight(monster, entity)) {
        best = entity;
        bestDistance = d;
      }
    }
    for (const commander of this.commanders.values()) {
      if (!commander.alive || this.inEntryMargin(commander, 64)) continue;
      const d = distance(monster, commander);
      if (d < bestDistance && this.hasLineOfSight(monster, commander)) {
        best = commander;
        bestDistance = d;
      }
    }
    return best;
  }

  private knockbackEntity(target: BattleEntity, from: Vec2, pushPx: number): void {
    if (target.kind !== "monster" || target.id === "boss-bone-choir" || target.hp <= 0) return;
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return;
    const nx = target.x + (dx / dist) * pushPx;
    const ny = target.y + (dy / dist) * pushPx;
    if (this.canStand(nx, target.y, target.radius)) target.x = nx;
    if (this.canStand(target.x, ny, target.radius)) target.y = ny;
  }

  private damageEntity(
    target: BattleEntity,
    amount: number,
    sourceCommanderId: string | undefined,
    events: SimEvent[],
  ): void {
    if (target.hp <= 0) return;
    const owner = target.ownerId ? this.commanders.get(target.ownerId) : undefined;
    if (target.kind === "unit" && (this.inEntry(target) || (owner && this.inEntry(owner)))) return;
    let finalAmount = amount;
    if (
      owner?.character === "boneknight" &&
      target.kind === "unit" &&
      distance(target, owner) <= 130
    ) {
      finalAmount *= 0.8;
    }
    if (owner && this.tick < owner.shellUntil) finalAmount *= 0.35;
    if (owner && sourceCommanderId && sourceCommanderId !== owner.id && this.isGraced(owner))
      finalAmount *= 0.35;
    if (sourceCommanderId) target.lastAttackerCommanderId = sourceCommanderId;
    target.hp -= finalAmount;
    events.push({
      type: "damage",
      tick: this.tick,
      targetId: target.id,
      amount: finalAmount,
      ...(sourceCommanderId ? { sourceCommanderId } : {}),
    });
    if (owner) this.notePvPOffense(sourceCommanderId, owner.id);
  }

  private damageCommander(
    target: CommanderState,
    amount: number,
    sourceCommanderId: string | undefined,
    events: SimEvent[],
  ): void {
    if (!target.alive) return;
    if (this.inEntry(target)) return;
    if (sourceCommanderId && sourceCommanderId !== target.id && this.isGraced(target)) {
      this.notePvPOffense(sourceCommanderId, target.id);
      target.lastGraceBlockTick = this.tick;
      events.push({
        type: "damage",
        tick: this.tick,
        targetId: target.id,
        amount: 0,
        sourceCommanderId,
        blocked: true,
      });
      return;
    }
    const finalAmount = this.tick < target.shellUntil ? amount * 0.35 : amount;
    target.hp -= finalAmount;
    events.push({
      type: "damage",
      tick: this.tick,
      targetId: target.id,
      amount: finalAmount,
      ...(sourceCommanderId ? { sourceCommanderId } : {}),
    });
    this.notePvPOffense(sourceCommanderId, target.id);
    if (target.hp > 0) return;
    target.hp = 0;
    target.alive = false;
    target.respawnAtTick = this.tick + 300;
    target.level = 1;
    target.xp = 0;
    target.upgrades = {};
    target.maxHp = baseMaxHpFor(target.character, {});
    target.weapons = starterWeaponsFor(target.character);
    target.weapon = starterWeaponFor(target.character);
    target.raiseReadyAtTick = 0;
    target.steerX = 0;
    target.steerY = 0;
    target.steerUntilTick = 0;
    target.steerActive = false;
    target.vx = 0;
    target.vy = 0;
    target.coasting = false;
    target.lastGraceBlockTick = 0;
    target.orbitHits = {};
    target.pendingDrafts = 0;
    target.pendingUpgrades = [];
    target.pendingExpiresAt = 0;
    target.hasteUntil = 0;
    target.fangUntil = 0;
    target.shellUntil = 0;
    target.frenzyUntil = 0;
    target.slowUntil = 0;
    for (const entity of [...this.entities.values()]) {
      if (entity.ownerId === target.id) this.entities.delete(entity.id);
    }
    if (target.carryingItemId) {
      this.spawnPickup("relic", target.x, target.y);
      target.carryingItemId = undefined;
    }
    for (let i = 0; i < 5; i++) {
      this.spawnPickup("essence", target.x + i * 9 - 18, target.y + (i % 3) * 9 - 9);
    }
    if (sourceCommanderId && sourceCommanderId !== target.id) {
      const killer = this.commanders.get(sourceCommanderId);
      if (killer) {
        this.grantXp(killer, LEVELS.monsterXp.commander, events);
        const lootedEssence = Math.floor(target.essence * 0.5);
        if (lootedEssence > 0) {
          killer.essence += lootedEssence;
          target.essence -= lootedEssence;
        }
      }
    }
    events.push({
      type: "death",
      tick: this.tick,
      victimId: target.id,
      victimKind: "commander",
      victimCommanderId: target.id,
      ...(sourceCommanderId ? { killerCommanderId: sourceCommanderId } : {}),
    });
  }

  private attack(
    attacker: BattleEntity,
    target: BattleEntity | CommanderState,
    sourceCommanderId: string | undefined,
    events: SimEvent[],
  ): void {
    if (attacker.cooldown > 0) return;
    if (!this.hasLineOfSight(attacker, target)) return;
    const owner = attacker.ownerId ? this.commanders.get(attacker.ownerId) : undefined;
    const frenzied = owner !== undefined && this.tick < owner.frenzyUntil;
    attacker.cooldown =
      attacker.kind === "unit"
        ? frenzied
          ? Math.ceil(UNIT.attackCooldownTicks / 2)
          : UNIT.attackCooldownTicks
        : 24;
    let damage = attacker.damage;
    if (owner) {
      if (this.tick < owner.fangUntil) damage *= 1.45;
      damage *= 1 + 0.18 * this.stacks(owner, "might");
      damage *= CHARACTERS[owner.character].unitDamageMul;
      if (frenzied) damage *= 1.3;
    }
    if ("accountId" in target) this.damageCommander(target, damage, sourceCommanderId, events);
    else this.damageEntity(target, damage, sourceCommanderId, events);
  }

  private moveUnits(events: SimEvent[]): void {
    for (const unit of this.entities.values()) {
      if (unit.kind !== "unit" || unit.hp <= 0 || !unit.ownerId) continue;
      const owner = this.commanders.get(unit.ownerId);
      if (!owner?.alive) continue;
      unit.cooldown = Math.max(0, unit.cooldown - 1);
      const ownerDistance = distance(unit, owner);
      unit.targetId = undefined;
      if (ownerDistance > 480) {
        const point = this.formationPoint(owner, unit.slot, owner);
        unit.x = point.x;
        unit.y = point.y;
        continue;
      }
      if (ownerDistance > 170) {
        this.moveBody(unit, this.formationTargetFor(unit, owner), unit.speed * 1.9, unit.radius);
        continue;
      }
      const enemy = this.nearestEnemyForUnit(unit, owner);
      if (enemy) {
        unit.targetId = enemy.id;
        const range = unit.attackRange + ("radius" in enemy ? enemy.radius : COMMANDER.radius);
        if (distance(unit, enemy) <= range) {
          this.attack(unit, enemy, owner.id, events);
          continue;
        }
        if (
          owner.stance !== "retreat" &&
          ownerDistance <= (owner.stance === "defend" ? 130 : 140)
        ) {
          this.moveBody(
            unit,
            enemy,
            unit.speed *
              (this.tick < owner.hasteUntil ? 1.25 : 1) *
              this.swiftMul(owner) *
              this.slowMul(unit.slowUntil),
            unit.radius,
          );
          continue;
        }
      }
      const point = this.formationTargetFor(unit, owner);
      const catchUp = distance(unit, point) > 90 ? 1.75 : 1.3;
      this.moveBody(
        unit,
        point,
        unit.speed *
          catchUp *
          (this.tick < owner.hasteUntil ? 1.25 : 1) *
          this.swiftMul(owner) *
          this.slowMul(unit.slowUntil),
        unit.radius,
      );
    }
  }

  private moveMonsters(events: SimEvent[]): void {
    for (const monster of this.entities.values()) {
      if (monster.kind !== "monster" || monster.hp <= 0) continue;
      monster.cooldown = Math.max(0, monster.cooldown - 1);
      if (this.inEntry(monster)) {
        this.moveBody(
          monster,
          this.arenaCenter,
          monster.speed * this.slowMul(monster.slowUntil),
          monster.radius,
        );
        continue;
      }
      if (monster.waveHunter && monster.huntTargetId) {
        const hunted = this.commanders.get(monster.huntTargetId);
        if (
          hunted?.alive &&
          !this.inEntryMargin(hunted, 64) &&
          this.tick < (monster.alertUntilTick ?? 0)
        ) {
          monster.alertX = hunted.x;
          monster.alertY = hunted.y;
          monster.homeX = hunted.x;
          monster.homeY = hunted.y;
        }
      }
      if (monster.homeX === undefined || monster.homeY === undefined) {
        monster.homeX = monster.x;
        monster.homeY = monster.y;
      }
      const home = { x: monster.homeX, y: monster.homeY };
      const victim = this.nearestVictimForMonster(monster);
      if (victim) {
        for (const other of this.entities.values()) {
          if (other.kind !== "monster" || other.id === monster.id) continue;
          if (distance(other, monster) <= 180 && this.hasLineOfSight(monster, other)) {
            other.alertUntilTick = this.tick + 90;
            other.alertX = victim.x;
            other.alertY = victim.y;
          }
        }
      }
      const alerted = monster.alertUntilTick !== undefined && this.tick < monster.alertUntilTick;
      const leash = alerted ? 720 : 480;
      if (!victim && alerted && monster.alertX !== undefined && distance(monster, home) <= leash) {
        const alertPoint = { x: monster.alertX, y: monster.alertY ?? monster.y };
        if (distance(monster, alertPoint) > 24) {
          this.moveBody(
            monster,
            alertPoint,
            monster.speed * this.slowMul(monster.slowUntil),
            monster.radius,
          );
          continue;
        }
      }
      if (!victim || distance(monster, home) > leash) {
        if (distance(monster, home) > 8) {
          this.moveBody(
            monster,
            home,
            monster.speed * this.slowMul(monster.slowUntil),
            monster.radius,
          );
        }
        continue;
      }
      const range = monster.attackRange + ("radius" in victim ? victim.radius : COMMANDER.radius);
      if (distance(monster, victim) <= range) this.attack(monster, victim, undefined, events);
      else
        this.moveBody(
          monster,
          victim,
          monster.speed * this.slowMul(monster.slowUntil),
          monster.radius,
        );
    }
  }

  private resolveCast(
    cast: { commanderId: string; spell: SpellId; target: Vec2 },
    events: SimEvent[],
  ): void {
    const commander = this.commanders.get(cast.commanderId);
    if (!commander?.alive) return;
    if (this.castTargetError(commander, cast.spell, cast.target, 24)) return;
    const spell = SPELLS[cast.spell];
    events.push({
      type: "spell_cast",
      tick: this.tick,
      commanderId: commander.id,
      spell: cast.spell,
    });
    if (cast.spell === "shell") {
      commander.shellUntil = this.tick + (commander.character === "boneknight" ? 120 : 90);
      return;
    }
    if (cast.spell === "frost") {
      const frost = SPELLS.frost;
      for (const entity of this.entities.values()) {
        if (entity.hp <= 0 || entity.ownerId === commander.id) continue;
        if (
          distance(entity, commander) <= frost.radius + entity.radius &&
          this.hasLineOfSight(commander, entity)
        ) {
          this.damageEntity(
            entity,
            frost.damage * CHARACTERS[commander.character].spellMul,
            commander.id,
            events,
          );
          if (entity.hp > 0) entity.slowUntil = this.tick + frost.slowTicks;
        }
      }
      for (const enemy of this.commanders.values()) {
        if (!enemy.alive || enemy.id === commander.id) continue;
        if (
          distance(enemy, commander) <= frost.radius + COMMANDER.radius &&
          this.hasLineOfSight(commander, enemy)
        ) {
          this.damageCommander(
            enemy,
            frost.damage * CHARACTERS[commander.character].spellMul,
            commander.id,
            events,
          );
          if (enemy.alive) enemy.slowUntil = this.tick + frost.slowTicks;
        }
      }
      return;
    }
    if (cast.spell === "chain") {
      const chain = SPELLS.chain;
      const struck = new Set<string>();
      const points: Vec2[] = [{ x: commander.x, y: commander.y }];
      let from: Vec2 = cast.target;
      let reach: number = chain.radius;
      let damage: number = chain.damage * CHARACTERS[commander.character].spellMul;
      const hops = commander.character === "warlock" ? chain.hops + 1 : chain.hops;
      for (let hop = 0; hop < hops; hop++) {
        let bestEntity: BattleEntity | undefined;
        let bestCommander: CommanderState | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const entity of this.entities.values()) {
          if (entity.hp <= 0 || entity.ownerId === commander.id || struck.has(entity.id)) continue;
          const d = distance(entity, from);
          if (d <= reach + entity.radius && d < bestDistance && this.hasLineOfSight(from, entity)) {
            bestEntity = entity;
            bestCommander = undefined;
            bestDistance = d;
          }
        }
        for (const enemy of this.commanders.values()) {
          if (!enemy.alive || enemy.id === commander.id || struck.has(enemy.id)) continue;
          const d = distance(enemy, from);
          if (
            d <= reach + COMMANDER.radius &&
            d < bestDistance &&
            this.hasLineOfSight(from, enemy)
          ) {
            bestCommander = enemy;
            bestEntity = undefined;
            bestDistance = d;
          }
        }
        if (bestEntity) {
          struck.add(bestEntity.id);
          from = { x: bestEntity.x, y: bestEntity.y };
          points.push({ ...from });
          this.damageEntity(bestEntity, damage, commander.id, events);
        } else if (bestCommander) {
          struck.add(bestCommander.id);
          from = { x: bestCommander.x, y: bestCommander.y };
          points.push({ ...from });
          this.damageCommander(bestCommander, damage, commander.id, events);
        } else {
          break;
        }
        reach = chain.hopRadius;
        damage *= chain.falloff;
      }
      if (points.length > 1) {
        this.chainFx.push({ points, tick: this.tick, expiresAtTick: this.tick + 9 });
      }
      return;
    }
    let hits = 0;
    for (const entity of this.entities.values()) {
      if (entity.hp <= 0 || entity.ownerId === commander.id) continue;
      if (
        distance(entity, cast.target) <= spell.radius + entity.radius &&
        this.hasLineOfSight(cast.target, entity)
      ) {
        hits++;
        this.damageEntity(
          entity,
          spell.damage * CHARACTERS[commander.character].spellMul,
          commander.id,
          events,
        );
        if (cast.spell === "nova") this.knockbackEntity(entity, cast.target, 10);
      }
    }
    for (const enemy of this.commanders.values()) {
      if (!enemy.alive || enemy.id === commander.id) continue;
      if (
        distance(enemy, cast.target) <= spell.radius + COMMANDER.radius &&
        this.hasLineOfSight(cast.target, enemy)
      ) {
        hits++;
        this.damageCommander(
          enemy,
          spell.damage * CHARACTERS[commander.character].spellMul,
          commander.id,
          events,
        );
      }
    }
    if (cast.spell === "nova" && commander.character === "necromancer" && hits > 0) {
      this.spawnUnitFor(commander);
    }
  }

  private chainStorm(from: Vec2, bolt: ProjectileState, events: SimEvent[]): void {
    let bestEntity: BattleEntity | undefined;
    let bestCommander: CommanderState | undefined;
    let bestD = 130;
    for (const entity of this.entities.values()) {
      if (entity.hp <= 0 || entity.ownerId === bolt.ownerId) continue;
      if (bolt.hitIds.includes(entity.id)) continue;
      const d = distance(entity, from);
      if (d < bestD) {
        bestD = d;
        bestEntity = entity;
        bestCommander = undefined;
      }
    }
    for (const enemy of this.commanders.values()) {
      if (!enemy.alive || enemy.id === bolt.ownerId) continue;
      if (bolt.hitIds.includes(enemy.id)) continue;
      const d = distance(enemy, from);
      if (d < bestD) {
        bestD = d;
        bestCommander = enemy;
        bestEntity = undefined;
      }
    }
    if (bestEntity) {
      this.chainFx.push({
        points: [
          { x: from.x, y: from.y },
          { x: bestEntity.x, y: bestEntity.y },
        ],
        tick: this.tick,
        expiresAtTick: this.tick + 8,
      });
      this.damageEntity(bestEntity, bolt.damage * 0.5, bolt.ownerId, events);
    } else if (bestCommander) {
      this.chainFx.push({
        points: [
          { x: from.x, y: from.y },
          { x: bestCommander.x, y: bestCommander.y },
        ],
        tick: this.tick,
        expiresAtTick: this.tick + 8,
      });
      this.damageCommander(bestCommander, bolt.damage * 0.5, bolt.ownerId, events);
    }
  }

  private updateOrbits(events: SimEvent[]): void {
    for (const commander of this.commanders.values()) {
      if (!commander.alive || commander.weapon !== "orbit") continue;
      if (this.inEntry(commander)) continue;
      const charStats = CHARACTERS[commander.character];
      const damage = WEAPONS.orbit.damage * charStats.spellMul;
      const orbitDist = 72 * charStats.weaponSizeMul;
      const bladeHitR = 22 * charStats.weaponSizeMul;
      for (let i = 0; i < 2; i++) {
        const angle = this.tick * 0.11 + i * Math.PI;
        const bx = commander.x + Math.cos(angle) * orbitDist;
        const by = commander.y + Math.sin(angle) * orbitDist;
        for (const entity of this.entities.values()) {
          if (entity.hp <= 0 || entity.ownerId === commander.id) continue;
          if (this.tick - (commander.orbitHits[entity.id] ?? -999) < 12) continue;
          if (Math.hypot(entity.x - bx, entity.y - by) <= bladeHitR + entity.radius) {
            commander.orbitHits[entity.id] = this.tick;
            this.damageEntity(entity, damage, commander.id, events);
          }
        }
        for (const enemy of this.commanders.values()) {
          if (!enemy.alive || enemy.id === commander.id) continue;
          if (this.tick - (commander.orbitHits[enemy.id] ?? -999) < 12) continue;
          if (Math.hypot(enemy.x - bx, enemy.y - by) <= bladeHitR + COMMANDER.radius) {
            commander.orbitHits[enemy.id] = this.tick;
            this.damageCommander(enemy, damage, commander.id, events);
          }
        }
      }
      if (this.tick % 30 === 0) {
        for (const id of Object.keys(commander.orbitHits)) {
          if (this.tick - commander.orbitHits[id]! > 90) delete commander.orbitHits[id];
        }
      }
    }
  }

  private updateProjectiles(events: SimEvent[]): void {
    for (const bolt of [...this.projectiles.values()]) {
      if (this.tick >= bolt.expiresAtTick) {
        this.projectiles.delete(bolt.id);
        continue;
      }
      const shooter = this.commanders.get(bolt.ownerId);
      if (bolt.homing) {
        let bestX = 0;
        let bestY = 0;
        let bestD = shooter?.character === "necromancer" ? 380 : 340;
        let found = false;
        for (const entity of this.entities.values()) {
          if (entity.hp <= 0 || entity.ownerId === bolt.ownerId) continue;
          const d = distance(entity, bolt);
          if (d < bestD) {
            bestD = d;
            bestX = entity.x;
            bestY = entity.y;
            found = true;
          }
        }
        for (const enemy of this.commanders.values()) {
          if (!enemy.alive || enemy.id === bolt.ownerId) continue;
          const d = distance(enemy, bolt);
          if (d < bestD) {
            bestD = d;
            bestX = enemy.x;
            bestY = enemy.y;
            found = true;
          }
        }
        if (found && this.hasLineOfSight(bolt, { x: bestX, y: bestY })) {
          const speed = Math.hypot(bolt.vx, bolt.vy);
          const cur = Math.atan2(bolt.vy, bolt.vx);
          const want = Math.atan2(bestY - bolt.y, bestX - bolt.x);
          let diff = want - cur;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const turn = Math.max(-0.18, Math.min(0.18, diff));
          const ang = cur + turn;
          bolt.vx = Math.cos(ang) * speed;
          bolt.vy = Math.sin(ang) * speed;
        }
      }
      const nx = bolt.x + bolt.vx * TICK_SECONDS;
      const ny = bolt.y + bolt.vy * TICK_SECONDS;
      if (!this.hasLineOfSight(bolt, { x: nx, y: ny }) || !this.canStand(nx, ny, bolt.radius)) {
        this.projectiles.delete(bolt.id);
        continue;
      }
      bolt.x = nx;
      bolt.y = ny;
      let consumed = false;
      const pushDist = shooter?.character === "boneknight" ? 9 : 6;
      for (const entity of this.entities.values()) {
        if (entity.hp <= 0 || entity.ownerId === bolt.ownerId) continue;
        if (bolt.hitIds.includes(entity.id)) continue;
        if (distance(entity, bolt) <= bolt.radius + entity.radius) {
          this.damageEntity(entity, bolt.damage, bolt.ownerId, events);
          if (bolt.weapon === "scythe" || bolt.weapon === "hellscatter") {
            this.knockbackEntity(
              entity,
              { x: entity.x - bolt.vx, y: entity.y - bolt.vy },
              pushDist,
            );
          }
          bolt.hitIds.push(entity.id);
          if (bolt.weapon === "storm" && bolt.hitIds.length === 1)
            this.chainStorm(entity, bolt, events);
          consumed = bolt.hitIds.length > bolt.pierce;
          if (consumed) break;
        }
      }
      if (!consumed && bolt.hitIds.length <= bolt.pierce) {
        for (const enemy of this.commanders.values()) {
          if (!enemy.alive || enemy.id === bolt.ownerId) continue;
          if (bolt.hitIds.includes(enemy.id)) continue;
          if (distance(enemy, bolt) <= bolt.radius + COMMANDER.radius) {
            this.damageCommander(enemy, bolt.damage, bolt.ownerId, events);
            bolt.hitIds.push(enemy.id);
            if (bolt.weapon === "storm" && bolt.hitIds.length === 1)
              this.chainStorm(enemy, bolt, events);
            consumed = bolt.hitIds.length > bolt.pierce;
            if (consumed) break;
          }
        }
      }
      if (consumed) this.projectiles.delete(bolt.id);
    }
  }

  private prunePickups(): void {
    let essenceCount = 0;
    let utilityCount = 0;
    for (const pickup of this.pickups.values()) {
      if (pickup.templateId === "relic") continue;
      const ttl = PICKUPS[pickup.templateId].ttlTicks;
      if (ttl > 0 && this.tick - (pickup.bornTick ?? 0) > ttl) {
        this.pickups.delete(pickup.id);
        continue;
      }
      if (pickup.templateId === "essence") essenceCount++;
      else utilityCount++;
    }
    const removeOldest = (matches: (pickup: PickupState) => boolean, excess: number): void => {
      for (const pickup of this.pickups.values()) {
        if (excess <= 0) break;
        if (!matches(pickup)) continue;
        this.pickups.delete(pickup.id);
        excess--;
      }
    };
    removeOldest(
      (pickup) => pickup.templateId === "essence",
      Math.max(0, essenceCount - MAX_ESSENCE_PICKUPS),
    );
    removeOldest(
      (pickup) => pickup.templateId !== "essence" && pickup.templateId !== "relic",
      Math.max(0, utilityCount - MAX_UTILITY_PICKUPS),
    );
  }

  private updatePickups(events: SimEvent[]): void {
    this.prunePickups();
    for (const pickup of [...this.pickups.values()]) {
      let nearest: CommanderState | undefined;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const commander of this.commanders.values()) {
        if (!commander.alive) continue;
        const d = distance(commander, pickup);
        if (d < nearestDistance) {
          nearest = commander;
          nearestDistance = d;
        }
      }
      if (!nearest) continue;
      const magnetRadius = 110 + 45 * this.stacks(nearest, "magnet");
      if (
        pickup.templateId === "essence" &&
        nearestDistance < magnetRadius &&
        nearestDistance > 24
      ) {
        this.moveBody(pickup, nearest, 260, 2);
        nearestDistance = distance(nearest, pickup);
      }
      if (nearestDistance > COMMANDER.radius + PICKUPS[pickup.templateId].radius + 8) continue;
      if (pickup.templateId === "vial" && nearest.hp >= nearest.maxHp) continue;
      this.pickups.delete(pickup.id);
      if (pickup.templateId === "essence") nearest.essence += 1;
      if (pickup.templateId === "haste")
        nearest.hasteUntil = this.tick + PICKUPS.haste.durationTicks;
      if (pickup.templateId === "fang") nearest.fangUntil = this.tick + PICKUPS.fang.durationTicks;
      if (pickup.templateId === "frenzy")
        nearest.frenzyUntil = this.tick + PICKUPS.frenzy.durationTicks;
      if (pickup.templateId === "vial")
        nearest.hp = Math.min(nearest.maxHp, nearest.hp + PICKUPS.vial.heal);
      if (pickup.templateId === "relic") {
        nearest.carryingItemId = pickup.id;
        if (this.tick - this.lastRelicSiegeTick >= 450) {
          this.lastRelicSiegeTick = this.tick;
          const siege = this.spawnHunterWave(nearest.id, "Relic Siege Pack");
          if (siege.count > 0 && siege.targetCommanderId) {
            events.push({
              type: "wave_spawned",
              tick: this.tick,
              wave: siege.wave,
              title: siege.title,
              count: siege.count,
              targetCommanderId: siege.targetCommanderId,
            });
          }
        }
      }
      events.push({
        type: "pickup",
        tick: this.tick,
        commanderId: nearest.id,
        itemId: pickup.id,
        templateId: pickup.templateId,
      });
    }
    for (const commander of this.commanders.values()) {
      if (!commander.alive || !commander.carryingItemId) continue;
      if (!insideRect(commander, this.map.shrine)) continue;
      events.push({
        type: "item_delivered",
        tick: this.tick,
        commanderId: commander.id,
        itemId: commander.carryingItemId,
        templateId: "relic",
        destination: "shrine",
      });
      commander.carryingItemId = undefined;
      this.spawnPickup("relic", this.map.relicSpawn.x + 54, this.map.relicSpawn.y);
    }
  }

  private removeDead(events: SimEvent[]): void {
    for (const entity of [...this.entities.values()]) {
      if (entity.hp > 0) continue;
      this.entities.delete(entity.id);
      if (entity.kind === "monster") {
        this.spawnPickup("essence", entity.x, entity.y);
        const isBoss = entity.id === "boss-bone-choir";
        const isWarden = entity.tag === "bone-warden";
        const roll = hashString(`${entity.id}:${this.tick}`);
        if (isBoss) {
          for (let i = 0; i < 8; i++)
            this.spawnPickup("essence", entity.x + i * 8 - 28, entity.y + (i % 4) * 8 - 12);
          this.spawnPickup("frenzy", entity.x + 20, entity.y);
          this.spawnPickup("vial", entity.x - 20, entity.y);
        } else if (entity.elite || roll % 100 < (isWarden ? 25 : 6)) {
          const utility = (["vial", "haste", "fang", "frenzy"] as const)[(roll >>> 3) % 4]!;
          this.spawnPickup(utility, entity.x, entity.y);
        }
        if (entity.lastAttackerCommanderId) {
          const killer = this.commanders.get(entity.lastAttackerCommanderId);
          if (killer) {
            killer.kills = (killer.kills ?? 0) + 1;
            const xp = isBoss
              ? LEVELS.monsterXp.boss
              : isWarden
                ? LEVELS.monsterXp.warden
                : LEVELS.monsterXp.skeleton;
            this.grantXp(killer, xp, events);
          }
        }
      }
      events.push({
        type: "death",
        tick: this.tick,
        victimId: entity.id,
        victimKind: entity.kind,
        victimTag: entity.tag,
        ...(entity.ownerId ? { victimCommanderId: entity.ownerId } : {}),
        ...(entity.lastAttackerCommanderId
          ? { killerCommanderId: entity.lastAttackerCommanderId }
          : {}),
      });
    }
  }

  private respawnMonsters(): void {
    if (!this.entities.has("boss-bone-choir")) this.spawnBoss();
    let aliveCount = [...this.entities.values()].filter((e) => e.kind === "monster").length;
    if (aliveCount >= this.map.monsterSpawns.length) return;
    for (const spawn of this.map.monsterSpawns) {
      if (aliveCount >= this.map.monsterSpawns.length) break;
      const occupied = [...this.entities.values()].some(
        (e) => e.kind === "monster" && distance(e, spawn) < 64,
      );
      if (occupied) continue;
      const monster = this.makeMonster(spawn);
      this.entities.set(monster.id, monster);
      aliveCount++;
    }
  }

  waveStatus(): WaveStatus {
    const activeHunters = [...this.entities.values()].filter(
      (e) => e.kind === "monster" && e.hp > 0 && e.waveHunter,
    ).length;
    return {
      number: this.waveNumber,
      title: this.waveTitle,
      nextAtTick: this.nextWaveTick,
      activeHunters,
      ...(this.lastWaveTargetId ? { targetCommanderId: this.lastWaveTargetId } : {}),
    };
  }

  spawnHunterWave(
    targetCommanderId?: string,
    titleOverride?: string,
  ): { wave: number; title: string; count: number; targetCommanderId?: string } {
    const activeHunters = [...this.entities.values()].filter(
      (e) => e.kind === "monster" && e.hp > 0 && e.waveHunter,
    ).length;
    if (activeHunters >= 14) {
      return { wave: this.waveNumber, title: this.waveTitle, count: 0 };
    }
    let target: CommanderState | undefined;
    if (targetCommanderId) {
      const candidate = this.commanders.get(targetCommanderId);
      if (candidate?.alive && !this.inEntry(candidate)) target = candidate;
    } else {
      const eligible = [...this.commanders.values()].filter(
        (c) => c.alive && !c.extracted && c.kind !== "bot" && !this.inEntryMargin(c, 64),
      );
      eligible.sort(
        (a, b) =>
          (b.carryingItemId ? 150 : 0) +
          b.essence * 4 +
          b.level * 12 -
          ((a.carryingItemId ? 150 : 0) + a.essence * 4 + a.level * 12),
      );
      target = eligible[0];
    }
    if (!target) {
      return { wave: this.waveNumber, title: this.waveTitle, count: 0 };
    }

    this.waveNumber += 1;
    const titles = [
      "Crypt Skitterers",
      "Bone Warden Vanguard",
      "Catacomb Siege Pack",
      "Necrotic Legion",
    ] as const;
    const title = titleOverride ?? titles[Math.min(titles.length - 1, this.waveNumber - 1)]!;
    this.waveTitle = title;
    this.lastWaveTargetId = target.id;

    let origin: Vec2 | undefined;
    outer: for (const radius of [270, 220, 330]) {
      for (let s = 0; s < 16; s++) {
        const ang = ((s + this.waveNumber * 3) / 16) * Math.PI * 2;
        const cx = target.x + Math.cos(ang) * radius;
        const cy = target.y + Math.sin(ang) * radius;
        if (!this.inEntryMargin({ x: cx, y: cy }, 96) && this.canStand(cx, cy, 14)) {
          origin = { x: cx, y: cy };
          break outer;
        }
      }
    }
    if (!origin) {
      const fallback = this.map.monsterSpawns.find(
        (sp) => !this.inEntryMargin(sp, 96) && distance(sp, target) > 160,
      );
      origin = fallback ? { x: fallback.x, y: fallback.y } : { ...this.arenaCenter };
    }

    const skelCount = Math.min(6, 3 + Math.ceil(this.waveNumber / 2));
    const wardenCount = this.waveNumber >= 2 ? Math.min(2, Math.floor(this.waveNumber / 2)) : 0;
    const tags: string[] = [
      ...Array.from({ length: skelCount }, () => "skeleton"),
      ...Array.from({ length: wardenCount }, () => "bone-warden"),
    ];

    let spawned = 0;
    for (let i = 0; i < tags.length; i++) {
      if (activeHunters + spawned >= 14) break;
      const tag = tags[i]!;
      const ang = (i / Math.max(1, tags.length)) * Math.PI * 2;
      let px = origin.x + Math.cos(ang) * 24;
      let py = origin.y + Math.sin(ang) * 24;
      if (!this.canStand(px, py, 12)) {
        px = origin.x;
        py = origin.y;
      }
      const monster = this.makeMonster({ tag, x: px, y: py });
      if (this.waveNumber >= 3 && i === tags.length - 1 && !monster.elite) {
        monster.elite = true;
        monster.maxHp = Math.round(monster.maxHp * 1.8);
        monster.hp = monster.maxHp;
      }
      monster.waveHunter = true;
      monster.huntTargetId = target.id;
      monster.alertUntilTick = this.tick + 750;
      monster.alertX = target.x;
      monster.alertY = target.y;
      monster.homeX = target.x;
      monster.homeY = target.y;
      this.entities.set(monster.id, monster);
      spawned++;
    }

    return { wave: this.waveNumber, title, count: spawned, targetCommanderId: target.id };
  }

  projectileSnapshots(): ProjectileSnapshot[] {
    return [...this.projectiles.values()].map((bolt) => ({
      id: bolt.id,
      x: Math.round(bolt.x),
      y: Math.round(bolt.y),
      vx: Math.round(bolt.vx),
      vy: Math.round(bolt.vy),
      ownerId: bolt.ownerId,
      radius: bolt.radius,
      weapon: bolt.weapon,
    }));
  }

  commanderSnapshots(): CommanderSnapshot[] {
    return [...this.commanders.values()].map((c) => ({
      id: c.id,
      accountId: c.accountId,
      name: c.name,
      kind: c.kind,
      character: c.character,
      faction: c.faction,
      stance: c.stance,
      weapon: c.weapon,
      weapons: [...c.weapons],
      vx: Math.round(c.vx),
      vy: Math.round(c.vy),
      moveSpeed: Math.round(this.commanderSpeed(c)),
      ...(this.graceTicksLeft(c) > 0
        ? { pvpGrace: true, pvpGraceTicks: this.graceTicksLeft(c) }
        : {}),
      ...(c.lastGraceBlockTick > 0 ? { graceBlockedAtTick: c.lastGraceBlockTick } : {}),
      ...(!c.alive && c.respawnAtTick > this.tick ? { respawnAtTick: c.respawnAtTick } : {}),
      x: Math.round(c.x),
      y: Math.round(c.y),
      hp: Math.max(0, Math.ceil(c.hp)),
      maxHp: c.maxHp,
      command: Math.floor(c.command),
      maxCommand: COMMANDER.maxCommand,
      essence: c.essence,
      alive: c.alive,
      extracted: c.extracted,
      unitCount: [...this.entities.values()].filter((e) => e.ownerId === c.id && e.hp > 0).length,
      ...(c.carryingItemId ? { carryingItemId: c.carryingItemId } : {}),
      level: c.level,
      xp: c.xp,
      xpNext: xpForLevel(c.level),
      ...(c.alive && c.pendingUpgrades.length > 0
        ? { pendingUpgrades: [...c.pendingUpgrades] }
        : {}),
      upgrades: { ...c.upgrades },
      spellReadyAt: { ...c.spellReadyAt },
      ...(this.tick < c.shellUntil ? { shellActive: true } : {}),
      ...(this.tick < c.slowUntil ? { slowActive: true } : {}),
      ...(this.tick < c.hasteUntil ? { hasteActive: true } : {}),
      ...(this.tick < c.fangUntil ? { fangActive: true } : {}),
      ...(this.tick < c.frenzyUntil ? { frenzyActive: true } : {}),
      buffTicks: {
        ...(this.tick < c.shellUntil ? { shell: c.shellUntil - this.tick } : {}),
        ...(this.tick < c.hasteUntil ? { haste: c.hasteUntil - this.tick } : {}),
        ...(this.tick < c.fangUntil ? { fang: c.fangUntil - this.tick } : {}),
        ...(this.tick < c.frenzyUntil ? { frenzy: c.frenzyUntil - this.tick } : {}),
      },
      ...(c.tier ? { tier: c.tier } : {}),
      ...(c.tapKeyId ? { tapKeyId: c.tapKeyId } : {}),
      ...(c.tapRegistry ? { tapRegistry: c.tapRegistry } : {}),
      ...(c.kills ? { kills: c.kills } : {}),
      inSanctuary: this.inEntry(c),
    }));
  }

  entitySnapshots(): EntitySnapshot[] {
    const out: EntitySnapshot[] = [];
    for (const c of this.commanders.values()) {
      if (!c.alive && !c.extracted) continue;
      if (c.alive) {
        out.push({
          id: c.id,
          kind: "commander",
          x: Math.round(c.x),
          y: Math.round(c.y),
          hp: Math.max(0, Math.ceil(c.hp)),
          maxHp: c.maxHp,
          radius: COMMANDER.radius,
          ownerId: c.id,
          teamId: c.teamId,
          ...(c.carryingItemId ? { carryingItemId: c.carryingItemId } : {}),
          ...(this.tick < c.slowUntil ? { slowed: true } : {}),
        });
      }
    }
    for (const e of this.entities.values()) {
      out.push({
        id: e.id,
        kind: e.kind,
        x: Math.round(e.x),
        y: Math.round(e.y),
        hp: Math.max(0, Math.ceil(e.hp)),
        maxHp: e.maxHp,
        radius: e.radius,
        ...(e.ownerId ? { ownerId: e.ownerId, teamId: e.ownerId } : {}),
        tag: e.tag,
        ...(e.elite ? { elite: true } : {}),
        ...(e.alertUntilTick !== undefined && this.tick < e.alertUntilTick
          ? { alerted: true }
          : {}),
        ...(e.slowUntil !== undefined && this.tick < e.slowUntil ? { slowed: true } : {}),
      });
    }
    return out;
  }

  pickupSnapshots(): PickupSnapshot[] {
    return [...this.pickups.values()].map((p) => ({
      id: p.id,
      templateId: p.templateId,
      label: PICKUPS[p.templateId].label,
      x: Math.round(p.x),
      y: Math.round(p.y),
      radius: PICKUPS[p.templateId].radius,
    }));
  }

  chainEffects(): SpellEffect[] {
    return this.chainFx.map((fx) => ({
      kind: "chain" as const,
      points: fx.points.map((p) => ({ ...p })),
      tick: fx.tick,
    }));
  }

  serialize(): SerializedSim {
    return {
      seed: this.seed,
      tick: this.tick,
      nextEntity: this.nextEntity,
      nextPickup: this.nextPickup,
      commanders: [...this.commanders.values()].map((c) => ({
        ...c,
        target: { ...c.target },
        weapons: [...c.weapons],
      })),
      entities: [...this.entities.values()].map((e) => ({ ...e })),
      pickups: [...this.pickups.values()].map((p) => ({ ...p })),
    };
  }

  static restore(data: SerializedSim): SimWorld {
    const world = new SimWorld(data.seed);
    world.tick = data.tick;
    world.nextEntity = data.nextEntity;
    world.nextPickup = data.nextPickup;
    world.commanders.clear();
    world.entities.clear();
    world.pickups.clear();
    for (const c of data.commanders) {
      const character: CharacterId = CHARACTER_IDS.includes(c.character)
        ? c.character
        : characterForCommanderId(c.id);
      const maxHp = baseMaxHpFor(character, c.upgrades ?? {});
      const ownedWeapons: WeaponId[] = starterWeaponsFor(character);
      for (const id of Array.isArray(c.weapons) ? c.weapons : []) {
        if (WEAPON_IDS.includes(id) && !ownedWeapons.includes(id)) ownedWeapons.push(id);
      }
      if ((c.upgrades?.scatter ?? 0) > 0 && !ownedWeapons.includes("scatter"))
        ownedWeapons.push("scatter");
      if ((c.upgrades?.lance ?? 0) > 0 && !ownedWeapons.includes("lance"))
        ownedWeapons.push("lance");
      const activeWeapon: WeaponId =
        c.weapon && ownedWeapons.includes(c.weapon) ? c.weapon : starterWeaponFor(character);
      world.commanders.set(c.id, {
        ...c,
        target: { ...c.target },
        path: Array.isArray(c.path) ? c.path.map((p) => ({ ...p })) : [],
        trail:
          Array.isArray(c.trail) && c.trail.length > 0
            ? c.trail.map((p) => ({ ...p }))
            : [{ x: c.x, y: c.y }],
        respawnAtTick: Number(c.respawnAtTick ?? 0),
        spellReadyAt: { ...freshSpellReady(), ...(c.spellReadyAt ?? {}) },
        character,
        faction: c.faction === "reapers" || c.faction === "wardens" ? c.faction : "wardens",
        nextShotAt: 0,
        raiseReadyAtTick: Number(c.raiseReadyAtTick ?? 0),
        maxHp,
        hp: c.alive && c.hp > 0 ? Math.min(maxHp, Math.max(1, c.hp)) : c.hp,
        level: Math.max(1, Number(c.level ?? 1)),
        xp: Math.max(0, Number(c.xp ?? 0)),
        pendingDrafts: Math.max(0, Number(c.pendingDrafts ?? 0)),
        pendingUpgrades: Array.isArray(c.pendingUpgrades) ? [...c.pendingUpgrades] : [],
        pendingExpiresAt: Number(c.pendingExpiresAt ?? 0),
        upgrades: { ...(c.upgrades ?? {}) },
        frenzyUntil: Number(c.frenzyUntil ?? 0),
        slowUntil: Number(c.slowUntil ?? 0),
        steerX: 0,
        steerY: 0,
        steerUntilTick: 0,
        steerActive: false,
        vx: 0,
        vy: 0,
        coasting: false,
        spawnedAtTick: 0,
        lastGraceBlockTick: Number(c.lastGraceBlockTick ?? 0),
        orbitHits: {},
        heading: Number(c.heading ?? 0),
        weapons: ownedWeapons,
        weapon: activeWeapon,
      });
    }
    for (const e of data.entities) world.entities.set(e.id, { ...e });
    for (const p of data.pickups) world.pickups.set(p.id, { ...p });
    return world;
  }

  stateHash(): string {
    const parts: string[] = [String(this.tick)];
    for (const c of [...this.commanders.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      parts.push(`${c.id}:${Math.round(c.x)},${Math.round(c.y)},${Math.ceil(c.hp)},${c.essence}`);
    }
    for (const e of [...this.entities.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      parts.push(`${e.id}:${Math.round(e.x)},${Math.round(e.y)},${Math.ceil(e.hp)}`);
    }
    let h = 2166136261;
    const text = parts.join("|");
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
}
