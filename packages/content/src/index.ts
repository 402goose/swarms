export const COMMANDER = {
  maxHp: 120,
  radius: 14,
  speed: 190,
  maxCommand: 100,
  commandRegenPerSecond: 14,
  startingSparks: 500,
} as const;

export const ECONOMY = {
  startingOnboardingCredits: 500,
  treasuryEpochTicks: 30 * 60 * 60 * 24,
  treasuryEpochBudget: 5000,
  postingFeeBps: 200,
  postingFeeMin: 1,
  postingFeeMax: 100,
  services: {
    mend: { label: "Field Mend", cost: 25, heal: 35 },
    rally: { label: "Rally Horn", cost: 20, command: 50 },
    scout: { label: "Scout Intel", cost: 10 },
    revive: { label: "Expedite Revive", cost: 30 },
    mercenary: { label: "Hire Bone Guard", cost: 40, count: 2 },
    armory: { label: "Weapon Seal", cost: 45 },
    sos: { label: "SOS Reinforcements", cost: 40, count: 2, heal: 30, bountyReward: 50 },
    agent: { label: "Deploy JEV Agent", cost: 60 },
    swarm_war: { label: "Unleash 8-Swarm Faction War", cost: 10 },
    tap_verify: { label: "Attest TAP Identity", cost: 10 },
    sovereign_edict: { label: "Sovereign Edict (TAP)", cost: 35, damage: 160, radius: 220 },
    sanctuary_recall: { label: "Town Portal (Sanctuary)", cost: 15, heal: 90 },
  },
} as const;

export type ServiceId = keyof typeof ECONOMY.services;

export const FACTIONS = {
  wardens: {
    id: "wardens",
    label: "Solar Wardens",
    shortLabel: "WARDEN",
    role: "Order of the Seal (White Hat)",
    motto: "Seal the Catacombs · Escort Allied Swarms · Purify the North Shrine",
    color: 0x5bc0eb,
    pvpSpoilSparks: 25,
  },
  reapers: {
    id: "reapers",
    label: "Obsidian Reapers",
    shortLabel: "REAPER",
    role: "Cult of the Breach (Black Hat)",
    motto: "Plunder the Crypts · Hunt Rival Commanders · Hijack the Moon Relic",
    color: 0xff5a4e,
    pvpSpoilSparks: 35,
  },
} as const;

export type FactionId = keyof typeof FACTIONS;
export const FACTION_IDS = Object.keys(FACTIONS) as FactionId[];

export const UNIT = {
  countPerCommander: 14,
  maxHp: 42,
  radius: 8,
  speed: 225,
  attackRange: 52,
  damage: 7,
  attackCooldownTicks: 18,
} as const;

export const MONSTER = {
  skeleton: { maxHp: 34, radius: 10, speed: 92, damage: 4, attackRange: 42 },
  boneWarden: { maxHp: 62, radius: 12, speed: 78, damage: 7, attackRange: 48 },
  boneChoir: { maxHp: 900, radius: 30, speed: 55, damage: 14, attackRange: 88 },
} as const;

export const SPELLS = {
  nova: { label: "Nova", cost: 45, radius: 150, damage: 34, cooldownTicks: 180 },
  volley: { label: "Pinning Volley", cost: 30, radius: 95, damage: 18, cooldownTicks: 120 },
  shell: { label: "Phase Shell", cost: 25, radius: 130, damage: 0, cooldownTicks: 240 },
  frost: {
    label: "Frost Nova",
    cost: 35,
    radius: 140,
    damage: 10,
    cooldownTicks: 210,
    slowTicks: 90,
    slowFactor: 0.45,
  },
  chain: {
    label: "Chain Lightning",
    cost: 40,
    radius: 260,
    damage: 26,
    cooldownTicks: 150,
    hops: 4,
    hopRadius: 130,
    falloff: 0.7,
  },
} as const;

export const PICKUPS = {
  essence: { label: "Essence", radius: 7, value: 1, ttlTicks: 30 * 60 },
  haste: { label: "Haste Sigil", radius: 11, durationTicks: 30 * 20, ttlTicks: 30 * 90 },
  fang: { label: "Fang Charm", radius: 11, durationTicks: 30 * 20, ttlTicks: 30 * 90 },
  frenzy: { label: "Frenzy Idol", radius: 11, durationTicks: 30 * 15, ttlTicks: 30 * 90 },
  vial: { label: "Blood Vial", radius: 10, heal: 35, ttlTicks: 30 * 120 },
  relic: { label: "Moon Relic", radius: 13, ttlTicks: 0 },
} as const;

export const UPGRADES = {
  might: { label: "Might", desc: "Swarmlings hit 18% harder." },
  swift: { label: "Swift", desc: "You and your swarm move 8% faster." },
  brood: { label: "Brood", desc: "+2 swarmling cap. Regrows at the Sanctuary." },
  magnet: { label: "Soul Magnet", desc: "Essence flies to you from much farther." },
  vitality: { label: "Vitality", desc: "+25 max health, and mend 25 now." },
  arcane: { label: "Arcane", desc: "Spell cooldowns 12% shorter." },
  scatter: { label: "Scatter Wand", desc: "New weapon: 3 pellets per shot, short range." },
  lance: { label: "Soul Lance", desc: "New weapon: heavy bolt that pierces 4 targets." },
  orbit: { label: "Soul Orbit", desc: "New weapon: twin blades orbit you, shredding contact." },
  wisp: { label: "Wisp Swarm", desc: "New weapon: homing wisps that chase the nearest foe." },
  scythe: { label: "Grave Scythe", desc: "New weapon: wide short slash through crowds." },
  storm: { label: "Storm Wand", desc: "EVOLVE Bolt Wand: hits chain lightning to a second foe." },
  hellscatter: { label: "Hellscatter", desc: "EVOLVE Scatter Wand: 5 pellets per shot." },
  phantom: { label: "Phantom Lance", desc: "EVOLVE Soul Lance: pierces 8, faster cycle." },
} as const;

export type UpgradeId = keyof typeof UPGRADES;
export const UPGRADE_IDS = Object.keys(UPGRADES) as UpgradeId[];

export const LEVELS = {
  baseXp: 6,
  growthXp: 4,
  draftTicks: 30 * 10,
  monsterXp: { skeleton: 1, warden: 2, boss: 12, commander: 5 },
} as const;

export function xpForLevel(level: number): number {
  return LEVELS.baseXp + LEVELS.growthXp * Math.max(0, level - 1);
}

export const CHARACTERS = {
  necromancer: {
    label: "Necromancer",
    desc: "Swarm engine. Field-raises cheap thralls; Grave Nova raises another when it hits.",
    sprite: "commander",
    starterWeapon: "wisp",
    draftAffinity: ["brood", "magnet", "wisp", "orbit"],
    raiseCost: 4,
    unitCapBonus: 4,
    maxHpMul: 1,
    speedMul: 1,
    regenMul: 1,
    spellMul: 1,
    unitDamageMul: 1,
    unitHpMul: 1,
    weaponRangeMul: 1.15,
    weaponSpeedMul: 1.05,
    weaponSizeMul: 1.0,
  },
  warlock: {
    label: "Warlock",
    desc: "Fragile artillery. Starts with Soul Lance; Hex Chain is cheaper and hops farther.",
    sprite: "commander-warlock",
    starterWeapon: "lance",
    draftAffinity: ["arcane", "lance", "storm", "phantom"],
    raiseCost: 6,
    unitCapBonus: 0,
    maxHpMul: 0.75,
    speedMul: 1,
    regenMul: 1.6,
    spellMul: 1.3,
    unitDamageMul: 0.9,
    unitHpMul: 1,
    weaponRangeMul: 1.25,
    weaponSpeedMul: 1.18,
    weaponSizeMul: 1.05,
  },
  boneknight: {
    label: "Bone Knight",
    desc: "Frontline anchor. Starts with Grave Scythe; nearby swarm takes less damage.",
    sprite: "commander-boneknight",
    starterWeapon: "scythe",
    draftAffinity: ["scythe", "might", "vitality", "brood"],
    raiseCost: 8,
    unitCapBonus: 0,
    maxHpMul: 1.42,
    speedMul: 0.9,
    regenMul: 1,
    spellMul: 1,
    unitDamageMul: 1.2,
    unitHpMul: 1.3,
    weaponRangeMul: 1.15,
    weaponSpeedMul: 1.0,
    weaponSizeMul: 1.2,
  },
} as const;

export type CharacterId = keyof typeof CHARACTERS;
export const CHARACTER_IDS = Object.keys(CHARACTERS) as CharacterId[];

export function characterForCommanderId(id: string): CharacterId {
  const match = /(\d+)$/.exec(id);
  const n = match ? Number(match[1]) : 0;
  return CHARACTER_IDS[n % CHARACTER_IDS.length]!;
}

export const BOLT = {
  damage: 8,
  speed: 580,
  cooldownTicks: 6,
  lifeTicks: 42,
  radius: 5,
} as const;

export const WEAPONS = {
  bolt: {
    label: "Bolt Wand",
    hint: "8 dmg · long range",
    damage: BOLT.damage,
    speed: BOLT.speed,
    cooldownTicks: BOLT.cooldownTicks,
    lifeTicks: BOLT.lifeTicks,
    radius: BOLT.radius,
    pellets: 1,
    spreadRad: 0,
    pierce: 0,
  },
  scatter: {
    label: "Scatter Wand",
    hint: "5 dmg x3 · fan volley",
    damage: 5,
    speed: 560,
    cooldownTicks: 9,
    lifeTicks: 28,
    radius: 5,
    pellets: 3,
    spreadRad: 0.16,
    pierce: 0,
  },
  lance: {
    label: "Soul Lance",
    hint: "11 dmg · pierces 4",
    damage: 11,
    speed: 680,
    cooldownTicks: 16,
    lifeTicks: 45,
    radius: 6,
    pellets: 1,
    spreadRad: 0,
    pierce: 3,
  },
  orbit: {
    label: "Soul Orbit",
    hint: "12 dmg · reaper blades · passive",
    damage: 12,
    speed: 0,
    cooldownTicks: 1,
    lifeTicks: 0,
    radius: 10,
    pellets: 0,
    spreadRad: 0,
    pierce: 0,
  },
  wisp: {
    label: "Wisp Swarm",
    hint: "6 dmg · homing skull",
    damage: 6,
    speed: 450,
    cooldownTicks: 10,
    lifeTicks: 54,
    radius: 5,
    pellets: 1,
    spreadRad: 0,
    pierce: 0,
  },
  scythe: {
    label: "Grave Scythe",
    hint: "13 dmg · crescent cleave",
    damage: 13,
    speed: 540,
    cooldownTicks: 14,
    lifeTicks: 18,
    radius: 24,
    pellets: 1,
    spreadRad: 0,
    pierce: 99,
  },
  storm: {
    label: "Storm Wand",
    hint: "8 dmg · chains 50%",
    damage: BOLT.damage,
    speed: 600,
    cooldownTicks: BOLT.cooldownTicks,
    lifeTicks: 44,
    radius: BOLT.radius,
    pellets: 1,
    spreadRad: 0,
    pierce: 0,
  },
  hellscatter: {
    label: "Hellscatter",
    hint: "5 dmg x5 · hellfire fan",
    damage: 5,
    speed: 580,
    cooldownTicks: 9,
    lifeTicks: 32,
    radius: 5,
    pellets: 5,
    spreadRad: 0.16,
    pierce: 0,
  },
  phantom: {
    label: "Phantom Lance",
    hint: "11 dmg · pierces 8",
    damage: 11,
    speed: 720,
    cooldownTicks: 12,
    lifeTicks: 48,
    radius: 6,
    pellets: 1,
    spreadRad: 0,
    pierce: 7,
  },
} as const;

export type WeaponId = keyof typeof WEAPONS;
export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];
