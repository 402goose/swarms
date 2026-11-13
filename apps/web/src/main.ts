import type {
  CharacterId,
  ClientMessage,
  ContractSnapshot,
  FactionId,
  GameCommand,
  ServerMessage,
  UpgradeId,
  Vec2,
  WeaponId,
  ZoneSnapshot,
  ZoneWorldSnapshot,
} from "@swarms/protocol";
import { SCHEMA_VERSION, SPARK_USD_RATE } from "@swarms/protocol";
import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from "pixi.js";
import { sfx } from "./audio.ts";

const $ = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};

const appHost = $("#game");
const app = new Application();
await app.init({ resizeTo: window, background: 0x07090b, antialias: true });
appHost.appendChild(app.canvas);

const worldLayer = new Container();
const staticLayer = new Graphics();
const spriteLayer = new Container();
spriteLayer.sortableChildren = true;
const decalLayer = new Graphics();
const glowLayer = new Container();
const dynamicLayer = new Graphics();
const labelLayer = new Container();
worldLayer.addChild(staticLayer, decalLayer, glowLayer, spriteLayer, dynamicLayer, labelLayer);
app.stage.addChild(worldLayer);
const screenLayer = new Graphics();
const screenLabels = new Container();
app.stage.addChild(screenLayer, screenLabels);
const minimapBase = new Graphics();
const minimapLayer = new Graphics();
app.stage.addChild(minimapBase, minimapLayer);
let minimapDrawnFor = "";

const fields = {
  commander: $("#commander"),
  factionWar: $("#faction-war"),
  health: $("#health"),
  command: $("#command"),
  sparks: $("#sparks"),
  escrowed: $("#escrowed"),
  status: $("#status"),
  tick: $("#tick"),
  contracts: $("#contracts"),
  feed: $("#feed"),
  overlay: $("#overlay"),
  overlayTitle: $("#overlay-title"),
  overlayText: $("#overlay-text"),
  spellNova: $("#spell-nova"),
  spellNovaLabel: $("#spell-nova-label"),
  spellVolley: $("#spell-volley"),
  spellVolleyLabel: $("#spell-volley-label"),
  spellShell: $("#spell-shell"),
  spellShellLabel: $("#spell-shell-label"),
  spellFrost: $("#spell-frost"),
  spellFrostLabel: $("#spell-frost-label"),
  spellChain: $("#spell-chain"),
  spellChainLabel: $("#spell-chain-label"),
  level: $("#level"),
  essence: $("#essence"),
  raiseLabel: $("#raise-label"),
  xpFill: $("#xp-fill"),
  upgrades: $("#upgrades"),
  draft: $("#draft"),
  draftTitle: $("#draft-title"),
  draftOptions: $("#draft-options"),
  charSelect: $("#char-select"),
  factionCards: $("#faction-cards"),
  charCards: $("#char-cards"),
  hudPortrait: $<HTMLImageElement>("#hud-portrait"),
  hudClass: $("#hud-class"),
  hudLevel: $("#hud-level"),
  hudStance: $("#hud-stance"),
  hudWeapon: $("#hud-weapon"),
  hudHpFill: $("#hud-hp-fill"),
  hudHpText: $("#hud-hp-text"),
  hudCmdFill: $("#hud-cmd-fill"),
  hudCmdText: $("#hud-cmd-text"),
  hudXpFill: $("#hud-xp-fill"),
  hudInventory: $("#hud-inventory"),
  hudBuffs: $("#hud-buffs"),
  playerHud: $("#player-hud"),
  hudXpText: $("#hud-xp-text"),
  charName: $<HTMLInputElement>("#char-name"),
  charEnter: $<HTMLButtonElement>("#char-enter"),
  overlayRevive: $<HTMLButtonElement>("#overlay-revive"),
  audioToggle: $<HTMLButtonElement>("#audio-toggle"),
  objectiveBanner: $("#objective-banner"),
};

const learnedHints = new Set<string>();
function markHintLearned(hint: "move" | "fire" | "swarm" | "raise"): void {
  if (learnedHints.has(hint)) return;
  learnedHints.add(hint);
  for (const el of document.querySelectorAll<HTMLElement>(`.controls [data-hint="${hint}"]`)) {
    el.classList.add("learned");
  }
}

function syncAudioButton(): void {
  const muted = sfx.isMuted();
  fields.audioToggle.textContent = muted ? "SFX: OFF" : "SFX: ON";
  fields.audioToggle.classList.toggle("muted", muted);
}
syncAudioButton();

const defaultWsUrl =
  location.port === "15173" || location.port === "4173" || !location.host
    ? `ws://${location.hostname || "127.0.0.1"}:18787/ws`
    : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
const serverUrl = new URLSearchParams(location.search).get("server") ?? defaultWsUrl;
const socket = new WebSocket(serverUrl);
let snapshot: ZoneSnapshot | undefined;
let staticWorld: ZoneWorldSnapshot | undefined;
let staticWorldHash = "";
let worldRequested = false;
let welcomeCommanderId = "";
let seq = Date.now() % 1_000_000_000;
let contractSignature = "";
let staticDrawnFor = "";
let steerTimer = 0;
let lastSteerKey = "";
const keys = new Set<string>();
const rendered = new Map<string, Vec2>();
type CommanderPill = { box: Container; width: number };
const commanderLabels = new Map<string, CommanderPill>();
const chainAnims: Array<{ points: Vec2[]; started: number }> = [];
const seenChainFx = new Set<string>();
const spellFlashes: Array<{
  x: number;
  y: number;
  radius: number;
  color: number;
  started: number;
  expires: number;
}> = [];
const hitFlashes: Array<{
  x: number;
  y: number;
  death: boolean;
  started: number;
  expires: number;
}> = [];
const headings = new Map<string, number>();
const damageNumbers: Array<{
  text: Text;
  x: number;
  y: number;
  started: number;
  expires: number;
}> = [];
const prevHp = new Map<string, number>();
let hurtUntil = 0;
let prevSparks: number | undefined;
let statusNote = "";
let statusNoteUntil = 0;
const objectiveLabels = new Map<string, Text>();
const particles: Array<{
  x: number;
  y: number;
  vx: number;
  vy: number;
  started: number;
  expires: number;
  color: number;
  size: number;
}> = [];
const prevLevel = new Map<string, number>();
const prevPickups = new Map<string, { x: number; y: number; templateId: string }>();
let draftSignature = "";
let lastDrawMs = 0;
let frameDtSec = 0.016;
let drawFrame = 0;
let lastPredictFrame = -1;
let predictedSelf: Vec2 | null = null;
let predictedVel: Vec2 = { x: 0, y: 0 };
let predictedCommanderId = "";
let predictedSnapshotTick = -1;
let predictionWallKey = "";
let predictionWalls = new Set<string>();
const prevGraceBlockTick = new Map<string, number>();
const bloodDecals: Array<{
  x: number;
  y: number;
  r: number;
  started: number;
  rot: number;
  wob: number;
}> = [];
const firstSeenAt = new Map<string, number>();
const eliteIds = new Set<string>();
const prevEliteIds = new Set<string>();
const prevAlerted = new Set<string>();
let snapshotAtMs = 0;
let sawFirstSnapshot = false;
const glowSprites = new Map<string, Sprite>();
let glowTexture: Texture | null = null;
let shakePx = 0;
let hitStopUntil = 0;
type TexEntry = { texture: Texture; drawHeight: number; anchor: string; frames?: Texture[] };
type PlacedSprite = { s: Sprite; scale: number };
const textures = new Map<string, TexEntry>();
const entitySprites = new Map<string, PlacedSprite>();
const pickupSprites = new Map<string, PlacedSprite>();
const pickupLabels = new Map<string, Text>();

let boardCollapsed = true;

function playWidthPx(): number {
  return innerWidth - (innerWidth > 720 && !boardCollapsed ? 402 : 0);
}

function viewCenter(): Vec2 {
  return { x: playWidthPx() / 2, y: innerHeight / 2 };
}

function blurActive(): void {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body) active.blur();
}
const mouse: Vec2 = { x: innerWidth / 2, y: innerHeight / 2 };
let cameraCenter: Vec2 | null = null;
let spaceHeld = false;
let mouseHeld = false;
let shootTimer = 0;
let selectedChar: CharacterId | undefined;
let selectedFaction: FactionId = "wardens";
let lastHudLeft = "";
const boltTrails = new Map<string, Vec2[]>();
const seenBoltIds = new Set<string>();
let helloSent = false;
let lastPortraitSrc = "";
let lastBuffText = "";
const spriteMotion = new Map<
  string,
  {
    phase: number;
    vx: number;
    dustAt: number;
    walkDist: number;
    walkPhase: number;
    facing: string;
    fvx: number;
    fvy: number;
    faceHold: number;
    flip: number;
    jabAt: number;
    jabDx: number;
    jabDy: number;
    lastNow: number;
  }
>();

function ensureGlowTexture(): Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.4, "rgba(255,255,255,0.28)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glowTexture = Texture.from(c);
  return glowTexture;
}
const damageAccum = new Map<
  string,
  { total: number; mine: boolean; kind: string; radius: number; flushAt: number }
>();

function send(message: ClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function command(command: GameCommand): void {
  send({ type: "command", seq: seq++, command });
}

function commanderName(): string {
  const saved = localStorage.getItem("swarms:name");
  if (saved) return saved;
  const name = `Alec-${Math.floor(100 + Math.random() * 900)}`;
  localStorage.setItem("swarms:name", name);
  return name;
}

const CHAR_CARDS: Array<{
  id: CharacterId;
  label: string;
  desc: string;
  stats: string;
  img: string;
  raiseCost: number;
}> = [
  {
    id: "necromancer",
    label: "Necromancer",
    desc: "Swarm engine. Raises cheap thralls in the field; a Grave Nova that hits raises another.",
    stats: "120 HP · 18-unit cap · starts Wisp Swarm (+15% reach) · raise 4 essence",
    img: "/assets/commander.png",
    raiseCost: 4,
  },
  {
    id: "warlock",
    label: "Warlock",
    desc: "Fragile artillery. Starts with Soul Lance; Hex Chain is cheaper and hops farther.",
    stats: "90 HP · starts Soul Lance (+25% range) · spells +30% · raise 6 essence",
    img: "/assets/commander-warlock.png",
    raiseCost: 6,
  },
  {
    id: "boneknight",
    label: "Bone Knight",
    desc: "Frontline anchor. Starts with Grave Scythe; nearby swarm takes 20% less damage.",
    stats: "170 HP · starts Grave Scythe (+20% cleave) · bulwark swarm · raise 8 essence",
    img: "/assets/commander-boneknight.png",
    raiseCost: 8,
  },
];

const FACTION_CARDS: Array<{
  id: FactionId;
  label: string;
  desc: string;
}> = [
  {
    id: "wardens",
    label: "🛡 Solar Wardens (White Hat)",
    desc: "Order of the Seal · Escort allies, purify the North Shrine & earn +25 Spark ($0.025) spoils",
  },
  {
    id: "reapers",
    label: "⚔️ Obsidian Reapers (Black Hat)",
    desc: "Cult of the Breach · Hunt rival swarms, hijack the Moon Relic & loot +35 Spark ($0.035) spoils",
  },
];

function sendHello(character?: CharacterId, faction?: FactionId): void {
  if (helloSent) return;
  helloSent = true;
  fields.charSelect.hidden = true;
  blurActive();
  const resumeToken = localStorage.getItem("swarms:resume") ?? undefined;
  const savedFaction = localStorage.getItem("swarms:faction");
  const effectiveFaction: FactionId | undefined =
    faction ??
    (savedFaction === "wardens" || savedFaction === "reapers" ? savedFaction : selectedFaction);
  send({
    type: "hello",
    schemaVersion: SCHEMA_VERSION,
    name: commanderName(),
    kind: "human",
    ...(resumeToken ? { resumeToken } : {}),
    ...(character ? { character } : {}),
    ...(effectiveFaction ? { faction: effectiveFaction } : {}),
  });
}

function selectFaction(id: FactionId): void {
  selectedFaction = id;
  localStorage.setItem("swarms:faction", id);
  for (const el of fields.factionCards.querySelectorAll(".faction-card")) {
    el.classList.toggle("selected", (el as HTMLElement).dataset.faction === id);
  }
}

function selectChar(id: CharacterId): void {
  selectedChar = id;
  for (const el of fields.charCards.querySelectorAll(".char-card")) {
    el.classList.toggle("selected", (el as HTMLElement).dataset.char === id);
  }
  fields.charEnter.disabled = false;
}

function confirmChar(): void {
  if (!selectedChar || fields.charSelect.hidden) return;
  const name = fields.charName.value.trim().slice(0, 24);
  if (name) localStorage.setItem("swarms:name", name);
  localStorage.setItem("swarms:char", selectedChar);
  localStorage.setItem("swarms:faction", selectedFaction);
  sendHello(selectedChar, selectedFaction);
}

function showCharSelect(): void {
  const urlFaction = new URLSearchParams(location.search).get("faction");
  const savedFaction = localStorage.getItem("swarms:faction");
  if (urlFaction === "wardens" || urlFaction === "reapers") {
    selectedFaction = urlFaction;
    localStorage.setItem("swarms:faction", urlFaction);
  } else if (savedFaction === "wardens" || savedFaction === "reapers") {
    selectedFaction = savedFaction;
  }
  fields.factionCards.replaceChildren();
  for (const f of FACTION_CARDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `faction-card${f.id === selectedFaction ? " selected" : ""}`;
    btn.dataset.faction = f.id;
    const title = document.createElement("b");
    title.textContent = f.label;
    const desc = document.createElement("small");
    desc.textContent = f.desc;
    btn.append(title, desc);
    btn.addEventListener("click", () => selectFaction(f.id));
    fields.factionCards.appendChild(btn);
  }
  fields.charCards.replaceChildren();
  for (const card of CHAR_CARDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "char-card";
    button.dataset.char = card.id;
    const img = document.createElement("img");
    img.src = card.img;
    img.alt = "";
    const name = document.createElement("b");
    name.textContent = card.label;
    const desc = document.createElement("small");
    desc.textContent = card.desc;
    const stats = document.createElement("span");
    stats.className = "char-stats";
    stats.textContent = card.stats;
    button.append(img, name, desc, stats);
    button.addEventListener("click", () => selectChar(card.id));
    button.addEventListener("dblclick", () => {
      selectChar(card.id);
      confirmChar();
    });
    fields.charCards.appendChild(button);
  }
  fields.charName.value = commanderName();
  fields.charEnter.disabled = !selectedChar;
  fields.charEnter.onclick = () => confirmChar();
  fields.charSelect.hidden = false;
}

socket.addEventListener("open", () => {
  fields.status.textContent = "Joining zone";
  const valid = (v: string | null): CharacterId | undefined =>
    v === "necromancer" || v === "warlock" || v === "boneknight" ? v : undefined;
  const auto =
    valid(new URLSearchParams(location.search).get("char")) ??
    valid(localStorage.getItem("swarms:char"));
  if (auto) sendHello(auto);
  else if (localStorage.getItem("swarms:resume")) sendHello();
  else showCharSelect();
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as ServerMessage;
  if (message.type === "welcome") {
    welcomeCommanderId = message.commanderId;
    localStorage.setItem("swarms:resume", message.resumeToken);
    fields.status.textContent = "Live";
    fields.playerHud.hidden = false;
  } else if (message.type === "snapshot") {
    if (message.snapshot.world) {
      staticWorld = message.snapshot.world;
      staticWorldHash = message.snapshot.worldHash;
      worldRequested = false;
    }
    if (!staticWorld || message.snapshot.worldHash !== staticWorldHash) {
      if (!worldRequested) {
        worldRequested = true;
        send({ type: "requestWorld" });
      }
      fields.status.textContent = "Waiting for world";
      return;
    }
    snapshot = { ...message.snapshot, world: staticWorld };
    snapshotAtMs = performance.now();
    updateHud();
  } else if (message.type === "serviceResult") {
    statusNote = message.detail;
    statusNoteUntil = performance.now() + 3000;
    fields.status.textContent = statusNote;
    sfx.playContract("settled");
  } else if (message.type === "error") {
    const friendly: Record<string, string> = {
      commander_dead: "Fallen — reforming",
      not_at_extraction: "Not at extraction",
      spell_on_cooldown: "Spell cooling down",
      insufficient_command: "Not enough command",
      insufficient_essence: "Not enough essence",
      swarm_at_cap: "Swarm at cap",
      raise_on_cooldown: "Ritual cooling down",
      sanctuary_regrows_free: "Sanctuary regrows your swarm for free",
      contract_not_open: "Bounty no longer open",
      stale_sequence: "Order dropped (stale)",
    };
    statusNote = friendly[message.message] ?? message.message.replaceAll("_", " ");
    statusNoteUntil = performance.now() + 2500;
    fields.status.textContent = statusNote;
  }
});

socket.addEventListener("close", () => {
  fields.status.textContent = "Disconnected";
});
socket.addEventListener("error", () => {
  fields.status.textContent = "Connection error";
});

function predicateProgress(contract: ContractSnapshot): { current: number; target: number } {
  if (contract.predicate.kind === "kill_count") {
    return { current: contract.progress, target: contract.predicate.count };
  }
  return { current: contract.progress, target: 1 };
}

let prevSelfAlive = true;
let prevSelfExtracted = false;
let prevWaveNumber: number | undefined;

function updateHud(): void {
  if (!snapshot) return;
  const self = snapshot.commanders.find((c) => c.id === snapshot!.selfCommanderId);
  const factionIcon = self?.faction === "reapers" ? "⚔️ " : self?.faction === "wardens" ? "🛡 " : "";
  fields.commander.textContent = self
    ? `${factionIcon}${self.name} · ${self.unitCount}u`
    : welcomeCommanderId;
  if (snapshot.factions) {
    fields.factionWar.textContent = `🛡 ${snapshot.factions.wardensScore} vs ⚔️ ${snapshot.factions.reapersScore}`;
  }
  fields.health.textContent = self ? `${self.hp}/${self.maxHp}` : "—";
  appHost.style.setProperty(
    "--vig",
    self && self.maxHp > 0 && self.hp / self.maxHp < 0.35 ? "0.7" : "1",
  );
  fields.command.textContent = self ? `${self.command}/${self.maxCommand}` : "—";
  const totalCredits = snapshot.wallet.sparks + (snapshot.wallet.onboardingCredits ?? 0);
  const usdVal = (totalCredits * SPARK_USD_RATE).toFixed(3);
  fields.sparks.textContent =
    (snapshot.wallet.onboardingCredits ?? 0) > 0
      ? `${snapshot.wallet.sparks} (+${snapshot.wallet.onboardingCredits}) · $${usdVal}`
      : `${snapshot.wallet.sparks} ($${usdVal})`;
  fields.escrowed.textContent = `${snapshot.wallet.escrowed} ($${(snapshot.wallet.escrowed * SPARK_USD_RATE).toFixed(3)})`;
  if (self?.alive && statusNote === "Fallen — reforming") {
    statusNote = "";
    statusNoteUntil = 0;
  }
  if (statusNote && performance.now() < statusNoteUntil) {
    fields.status.textContent = statusNote;
  } else if (!self) {
    fields.status.textContent = "Joining zone";
  } else if (self.extracted) {
    fields.status.textContent = "Extracted — returning";
  } else if (!self.alive) {
    fields.status.textContent = "Fallen — respawning";
  } else {
    fields.status.textContent = "Live";
  }
  fields.tick.textContent = `tick ${snapshot.tick}`;
  const collapsedFeed: Array<{ text: string; count: number }> = [];
  for (const entry of snapshot.feed.slice(-30)) {
    const last = collapsedFeed[collapsedFeed.length - 1];
    if (last && last.text === entry.text) last.count++;
    else collapsedFeed.push({ text: entry.text, count: 1 });
  }
  fields.feed.replaceChildren(
    ...collapsedFeed.slice(-10).map((entry) => {
      const li = document.createElement("li");
      li.textContent = entry.count > 1 ? `${entry.text} ×${entry.count}` : entry.text;
      return li;
    }),
  );
  if (prevSparks !== undefined && snapshot.wallet.sparks > prevSparks) {
    statusNote = `+${snapshot.wallet.sparks - prevSparks} Sparks`;
    statusNoteUntil = performance.now() + 2500;
    fields.status.textContent = statusNote;
    sfx.playContract("settled");
  }
  prevSparks = snapshot.wallet.sparks;
  if (snapshot.wave) {
    if (prevWaveNumber !== undefined && snapshot.wave.number > prevWaveNumber) {
      sfx.playWaveHorn();
    }
    prevWaveNumber = snapshot.wave.number;
  }
  if (self) {
    if (prevSelfAlive && !self.alive && !self.extracted) sfx.playDeath();
    if (!prevSelfExtracted && self.extracted) sfx.playExtract();
    prevSelfAlive = self.alive;
    prevSelfExtracted = self.extracted;
  }
  if (self && !self.alive && !self.extracted) {
    fields.overlay.hidden = false;
    fields.overlayTitle.textContent = "Your swarm has fallen";
    const remainSec =
      self.respawnAtTick !== undefined
        ? Math.max(0, (self.respawnAtTick - snapshot.tick) / 30)
        : undefined;
    fields.overlayText.textContent =
      remainSec !== undefined
        ? `Reforming in the Sanctuary in ${remainSec.toFixed(1)}s…`
        : "Reforming in the Sanctuary…";
    fields.overlayRevive.hidden = false;
    fields.overlayRevive.disabled = snapshot.wallet.sparks < 30;
  } else if (self?.extracted) {
    fields.overlay.hidden = false;
    fields.overlayTitle.textContent = "Extracted";
    const remainSec =
      self.respawnAtTick !== undefined
        ? Math.max(0, (self.respawnAtTick - snapshot.tick) / 30)
        : undefined;
    fields.overlayText.textContent =
      remainSec !== undefined
        ? `Your swarm banks its haul and returns to the Sanctuary in ${remainSec.toFixed(1)}s…`
        : "Your swarm banks its haul and returns to the Sanctuary…";
    fields.overlayRevive.hidden = true;
  } else {
    fields.overlay.hidden = true;
    fields.overlayRevive.hidden = true;
  }
  const spellChips = [
    {
      key: "nova",
      label: self?.character === "necromancer" ? "Grave Nova" : "Nova",
      cost: 45,
      el: fields.spellNova,
      text: fields.spellNovaLabel,
    },
    {
      key: "volley",
      label: "Volley",
      cost: 30,
      el: fields.spellVolley,
      text: fields.spellVolleyLabel,
    },
    {
      key: "shell",
      label: self?.character === "boneknight" ? "Bone Bulwark" : "Shell",
      cost: 25,
      el: fields.spellShell,
      text: fields.spellShellLabel,
    },
    { key: "frost", label: "Frost", cost: 35, el: fields.spellFrost, text: fields.spellFrostLabel },
    {
      key: "chain",
      label: self?.character === "warlock" ? "Hex Chain" : "Chain",
      cost: self?.character === "warlock" ? 32 : 40,
      el: fields.spellChain,
      text: fields.spellChainLabel,
    },
  ] as const;
  for (const chip of spellChips) {
    const readyAt = self?.spellReadyAt?.[chip.key] ?? 0;
    const cdSec = Math.max(0, (readyAt - snapshot.tick) / 30);
    const cooling = !self || cdSec > 0 || self.command < chip.cost;
    chip.el.classList.toggle("cooling", cooling);
    chip.text.textContent =
      cdSec > 0 ? `${chip.label} · ${cdSec.toFixed(1)}s` : `${chip.label} · ${chip.cost}`;
  }
  fields.level.textContent = self ? `Lv ${self.level ?? 1}` : "—";
  fields.essence.textContent = self ? String(self.essence) : "—";
  fields.xpFill.style.width = self?.xpNext
    ? `${Math.min(100, ((self.xp ?? 0) / self.xpNext) * 100)}%`
    : "0%";
  const boons = self?.upgrades
    ? Object.entries(self.upgrades)
        .filter(([, n]) => (n ?? 0) > 0)
        .map(([k, n]) => `${UPGRADE_TEXT[k as UpgradeId].label} ×${n}`)
    : [];
  fields.upgrades.textContent = boons.length ? boons.join(" · ") : "—";
  updatePlayerHud(self, boons);
  renderDraft(self);
  renderContracts();
  refreshForgeModal();
  evaluateAutoDoctrines();
}

function updatePlayerHud(
  self: ZoneSnapshot["commanders"][number] | undefined,
  boons: string[],
): void {
  const pct = (v: number, max: number) =>
    `${Math.max(0, Math.min(100, max > 0 ? (v / max) * 100 : 0))}%`;
  fields.hudHpFill.style.width = self ? pct(self.hp, self.maxHp) : "0%";
  const hudLeft = `${viewCenter().x}px`;
  if (hudLeft !== lastHudLeft) {
    lastHudLeft = hudLeft;
    fields.playerHud.style.left = hudLeft;
  }
  fields.hudHpText.textContent = self ? `HP ${self.hp} / ${self.maxHp}` : "—";
  fields.hudCmdFill.style.width = self ? pct(self.command, self.maxCommand) : "0%";
  fields.hudCmdText.textContent = self ? `CMD ${self.command} / ${self.maxCommand}` : "—";
  fields.hudXpFill.style.width = self?.xpNext ? pct(self.xp ?? 0, self.xpNext) : "0%";
  fields.hudXpText.textContent = self?.xpNext ? `${self.xp ?? 0} / ${self.xpNext} XP` : "—";
  fields.hudLevel.textContent = self ? `Lv ${self.level ?? 1}` : "Lv —";
  fields.hudStance.textContent = self
    ? `${self.stance ?? "—"}${self.pvpGrace ? ` · grace ${Math.ceil((self.pvpGraceTicks ?? 240) / 30)}s` : ""}`
    : "—";
  const weaponInfo = WEAPON_TEXT[self?.weapon ?? "bolt"];
  const ownedCount = self?.weapons?.length ?? 1;
  fields.hudWeapon.textContent = self
    ? `${weaponInfo.label} (${ownedCount}/6) · ${weaponInfo.hint}`
    : "—";
  const card = CHAR_CARDS.find((c) => c.id === self?.character);
  fields.hudClass.textContent = card?.label ?? "Commander";
  const portrait = card?.img ?? "/assets/commander.png";
  if (portrait !== lastPortraitSrc) {
    lastPortraitSrc = portrait;
    fields.hudPortrait.src = portrait;
  }
  fields.raiseLabel.textContent = card ? `Raise · ${card.raiseCost} essence` : "Raise swarmling";
  const inv: string[] = [];
  if (self) inv.push(`Essence ${self.essence}`);
  if (self?.carryingItemId) inv.push("Carrying the relic");
  if (boons.length) inv.push(boons.join(" · "));
  fields.hudInventory.textContent = inv.length ? inv.join("  |  ") : "—";
  const buffs = self?.buffTicks
    ? Object.entries(self.buffTicks)
        .filter(([, t]) => (t ?? 0) > 0)
        .map(([k, t]) => `${k[0]!.toUpperCase()}${k.slice(1)} ${Math.ceil((t ?? 0) / 30)}s`)
    : [];
  const buffKey = buffs.join("|");
  if (buffKey !== lastBuffText) {
    lastBuffText = buffKey;
    fields.hudBuffs.replaceChildren(
      ...buffs.map((b) => {
        const chip = document.createElement("span");
        chip.textContent = b;
        return chip;
      }),
    );
  }
}

const WEAPON_TEXT: Record<WeaponId, { label: string; hint: string }> = {
  bolt: { label: "Bolt Wand", hint: "8 dmg · long range" },
  scatter: { label: "Scatter Wand", hint: "5 dmg x3 · fan volley" },
  lance: { label: "Soul Lance", hint: "11 dmg · pierces 4" },
  orbit: { label: "Soul Orbit", hint: "12 dmg · reaper blades · passive" },
  wisp: { label: "Wisp Swarm", hint: "6 dmg · homing skull" },
  scythe: { label: "Grave Scythe", hint: "13 dmg · crescent cleave" },
  storm: { label: "Storm Wand", hint: "8 dmg · chains 50%" },
  hellscatter: { label: "Hellscatter", hint: "5 dmg x5 · hellfire fan" },
  phantom: { label: "Phantom Lance", hint: "11 dmg · pierces 8" },
};

const UPGRADE_TEXT: Record<UpgradeId, { label: string; desc: string }> = {
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
};

function chooseUpgrade(up: UpgradeId): void {
  const isWeaponOrEvo =
    up === "scatter" ||
    up === "lance" ||
    up === "orbit" ||
    up === "wisp" ||
    up === "scythe" ||
    up === "storm" ||
    up === "hellscatter" ||
    up === "phantom";
  sfx.playUpgradeChosen(isWeaponOrEvo);
  command({ type: "chooseUpgrade", upgrade: up });
  fields.draft.hidden = true;
}

function renderDraft(self: ZoneSnapshot["commanders"][number] | undefined): void {
  const pending = self?.pendingUpgrades ?? [];
  if (!self?.alive || self.extracted || pending.length === 0) {
    fields.draft.hidden = true;
    draftSignature = "";
    return;
  }
  const sig = `${self.level ?? 1}:${pending.join(",")}`;
  if (sig === draftSignature) return;
  draftSignature = sig;
  fields.draft.hidden = false;
  fields.draftTitle.textContent = `Level ${self.level ?? 1} — choose a boon`;
  fields.draftOptions.replaceChildren(
    ...pending.map((up, i) => {
      const info = UPGRADE_TEXT[up];
      const btn = document.createElement("button");
      btn.type = "button";
      const title = document.createElement("b");
      title.textContent = `${i + 1} · ${info.label}`;
      const desc = document.createElement("small");
      desc.textContent = info.desc;
      btn.append(title, desc);
      btn.addEventListener("click", () => chooseUpgrade(up));
      return btn;
    }),
  );
}

function renderContracts(): void {
  if (!snapshot) return;
  const selfId = snapshot.selfCommanderId;
  const signature = snapshot.contracts
    .map(
      (c) =>
        `${c.id}:${c.status}:${c.progress}:${c.claimantId ?? ""}:${c.participants.includes(selfId)}:${c.progressByCommander[selfId] ?? 0}`,
    )
    .join("|");
  if (signature === contractSignature) return;
  contractSignature = signature;
  const open = snapshot.contracts
    .filter((c) => c.status === "open" || c.status === "accepted")
    .reverse()
    .slice(0, 6);
  const closed = snapshot.contracts
    .filter((c) => c.status !== "open" && c.status !== "accepted")
    .slice(-2)
    .reverse();
  fields.contracts.replaceChildren(
    ...[...open, ...closed].map((contract) => {
      const article = document.createElement("article");
      const tracking = contract.participants.includes(snapshot!.selfCommanderId);
      article.className = tracking ? "contract tracking" : "contract";
      const progress = predicateProgress(contract);
      const pct = Math.min(100, (progress.current / progress.target) * 100);
      const title = document.createElement("h4");
      title.textContent = contract.title;
      const desc = document.createElement("p");
      desc.textContent = contract.description || contract.predicate.kind.replaceAll("_", " ");
      const meta = document.createElement("div");
      meta.className = "contract-meta";
      const mine = contract.progressByCommander[snapshot!.selfCommanderId] ?? 0;
      meta.innerHTML = `<span>${contract.reward} Sparks</span><span>${tracking ? `tracking · you ${mine}` : contract.status} · ${progress.current}/${progress.target}</span>`;
      const bar = document.createElement("div");
      bar.className = "progress";
      const fill = document.createElement("i");
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      article.append(title, desc, meta, bar);
      if (contract.status === "open" || contract.status === "accepted") {
        const button = document.createElement("button");
        button.type = "button";
        const own = contract.issuerId === snapshot!.selfCommanderId;
        button.textContent = own
          ? "Your bounty"
          : tracking
            ? "Tracking"
            : contract.mode === "claim"
              ? "Claim"
              : "Track / accept";
        button.disabled = tracking || own;
        button.addEventListener("click", () => {
          sfx.playContract("accepted");
          send({
            type: "acceptContract",
            idempotencyKey: crypto.randomUUID(),
            contractId: contract.id,
          });
          blurActive();
        });
        article.appendChild(button);
      }
      return article;
    }),
  );
}

$("#post-kill").addEventListener("click", () => {
  sfx.playContract("posted");
  send({
    type: "postContract",
    idempotencyKey: crypto.randomUUID(),
    draft: {
      title: "Cull 5 skeletons",
      description: "Player-posted swarm bounty. First verified swarm collects.",
      predicate: { kind: "kill_count", targetTag: "skeleton", count: 5 },
      reward: 75,
      mode: "bounty",
      ttlTicks: 30 * 60 * 5,
    },
  });
  blurActive();
});

$("#post-relic").addEventListener("click", () => {
  sfx.playContract("posted");
  send({
    type: "postContract",
    idempotencyKey: crypto.randomUUID(),
    draft: {
      title: "Return the Moon Relic",
      description: "Player-posted relic run to the north shrine.",
      predicate: { kind: "deliver_item", itemTemplateId: "relic", destination: "shrine" },
      reward: 125,
      mode: "bounty",
      ttlTicks: 30 * 60 * 5,
    },
  });
  blurActive();
});

$("#post-escort").addEventListener("click", () => {
  if (!snapshot) return;
  sfx.playContract("posted");
  send({
    type: "postContract",
    idempotencyKey: crypto.randomUUID(),
    draft: {
      title: "Escort my sortie",
      description: "Guard the issuer's swarm during their sortie and extraction.",
      predicate: {
        kind: "escort_alive",
        subjectCommanderId: snapshot.selfCommanderId,
        withinDistance: 380,
      },
      reward: 75,
      mode: "claim",
      ttlTicks: 30 * 60 * 3,
    },
  });
  blurActive();
});

for (const [selector, service] of [
  ["#svc-mend", "mend"],
  ["#svc-rally", "rally"],
  ["#svc-mercenary", "mercenary"],
  ["#svc-sos", "sos"],
  ["#svc-agent", "agent"],
  ["#svc-swarm-war", "swarm_war"],
  ["#forge-swarm-war", "swarm_war"],
  ["#forge-spawn-agent", "agent"],
  ["#forge-sos", "sos"],
  ["#svc-armory", "armory"],
  ["#svc-scout", "scout"],
  ["#overlay-revive", "revive"],
] as const) {
  $(selector).addEventListener("click", () => {
    sfx.unlock();
    send({
      type: "buyService",
      idempotencyKey: crypto.randomUUID(),
      service,
    });
    blurActive();
  });
}

const forgeModal = $("#forge-modal");
const forgeRoster = $("#forge-roster");
const forgeInviteUrl = $("#forge-invite-url");
const forgeAgentCmd = $("#forge-agent-cmd");
const forgePlanSummary = $("#forge-plan-summary");
const docAutoMend = $<HTMLInputElement>("#doc-auto-mend");
const docAutoSos = $<HTMLInputElement>("#doc-auto-sos");
const docAutoRally = $<HTMLInputElement>("#doc-auto-rally");
const docAutoArmory = $<HTMLInputElement>("#doc-auto-armory");
const lastAutoTriggerMs: Record<string, number> = {};

function evaluateAutoDoctrines(): void {
  if (!snapshot) return;
  const self = snapshot.commanders.find((c) => c.id === snapshot!.selfCommanderId);
  if (!self?.alive || self.extracted || self.x <= 384) return;
  const now = performance.now();
  const credits = snapshot.wallet.sparks + (snapshot.wallet.onboardingCredits ?? 0);
  const hpRatio = self.maxHp > 0 ? self.hp / self.maxHp : 1;

  if (
    docAutoSos.checked &&
    hpRatio < 0.28 &&
    credits >= 40 &&
    now - (lastAutoTriggerMs.sos ?? 0) > 9000
  ) {
    lastAutoTriggerMs.sos = now;
    sfx.playWaveHorn();
    send({ type: "buyService", idempotencyKey: crypto.randomUUID(), service: "sos" });
    return;
  }
  if (
    docAutoMend.checked &&
    hpRatio < 0.45 &&
    credits >= 25 &&
    now - (lastAutoTriggerMs.mend ?? 0) > 6500
  ) {
    lastAutoTriggerMs.mend = now;
    send({ type: "buyService", idempotencyKey: crypto.randomUUID(), service: "mend" });
    return;
  }
  if (
    docAutoRally.checked &&
    self.command < 20 &&
    credits >= 20 &&
    now - (lastAutoTriggerMs.rally ?? 0) > 7000
  ) {
    lastAutoTriggerMs.rally = now;
    send({ type: "buyService", idempotencyKey: crypto.randomUUID(), service: "rally" });
    return;
  }
  if (
    docAutoArmory.checked &&
    credits >= 160 &&
    (self.weapons?.length ?? 1) < 6 &&
    now - (lastAutoTriggerMs.armory ?? 0) > 12_000
  ) {
    lastAutoTriggerMs.armory = now;
    send({ type: "buyService", idempotencyKey: crypto.randomUUID(), service: "armory" });
  }
}

function refreshForgeModal(): void {
  if (forgeModal.hidden || !snapshot) return;
  const self = snapshot.commanders.find((c) => c.id === snapshot!.selfCommanderId);
  const myFaction = self?.faction ?? selectedFaction;
  const baseOrigin =
    location.port === "15173"
      ? `http://${location.hostname || "127.0.0.1"}:18787`
      : location.origin;
  forgeInviteUrl.textContent = `${baseOrigin}/?faction=${myFaction}`;
  forgeAgentCmd.textContent = `SWARMS_AGENT_PLANNER=jev-v1 SWARMS_AGENT_NAME="${myFaction === "reapers" ? "Reaper" : "Warden"}-JEV" pnpm --filter @swarms/agent-mcp commander`;
  forgeRoster.replaceChildren(
    ...snapshot.commanders.map((c) => {
      const row = document.createElement("div");
      row.className = "forge-roster-item";
      const icon = c.faction === "reapers" ? "⚔️" : "🛡";
      const role = c.kind === "agent" ? "JEV-v1 AI" : c.kind === "bot" ? "BOT" : "HUMAN";
      const left = document.createElement("span");
      left.textContent = `${icon} ${c.name} (${role} · ${c.character ?? "necromancer"})`;
      const right = document.createElement("span");
      right.textContent = `Lv ${c.level ?? 1} · ${c.unitCount}u · ${c.essence} ess`;
      row.append(left, right);
      return row;
    }),
  );
}

$("#open-forge").addEventListener("click", () => {
  forgeModal.hidden = false;
  refreshForgeModal();
  const apiOrigin =
    location.port === "15173"
      ? `http://${location.hostname || "127.0.0.1"}:18787`
      : location.origin;
  fetch(`${apiOrigin}/v1/taskmarket`)
    .then((r) => r.json())
    .then(
      (data: {
        openBounties?: Array<{ title: string; rewardSparks: number; rewardUsd: number }>;
        planFile?: string;
      }) => {
        const bountyCount = data.openBounties?.length ?? 0;
        const top = (data.openBounties ?? [])
          .slice(0, 3)
          .map((b) => `• ${b.title} — ${b.rewardSparks} Sparks ($${b.rewardUsd.toFixed(3)})`)
          .join("\n");
        forgePlanSummary.textContent = `Spec: ${data.planFile ?? ".plan/milestone-1-faction-wars.yaml"} · ${bountyCount} live dungeon bounties\n${top || "• All bounties settled — post or trigger SOS to broadcast new contracts"}`;
      },
    )
    .catch(() => {
      forgePlanSummary.textContent =
        "Spec: .plan/milestone-1-faction-wars.yaml · 1 Spark = $0.001 USD";
    });
  blurActive();
});

$("#close-forge").addEventListener("click", () => {
  forgeModal.hidden = true;
  blurActive();
});

fields.audioToggle.addEventListener("click", () => {
  sfx.unlock();
  sfx.toggleMute();
  syncAudioButton();
  blurActive();
});

$("#extract").addEventListener("click", () => {
  command({ type: "extract" });
  blurActive();
});

$("#new-swarm").addEventListener("click", (event) => {
  send({ type: "abandon" });
  localStorage.removeItem("swarms:resume");
  localStorage.removeItem("swarms:name");
  (event.currentTarget as HTMLButtonElement).disabled = true;
  setTimeout(() => location.reload(), 150);
});

$(".board").classList.add("collapsed");
$("#board-toggle").addEventListener("click", (event) => {
  boardCollapsed = !boardCollapsed;
  $(".board").classList.toggle("collapsed", boardCollapsed);
  const button = event.currentTarget as HTMLButtonElement;
  button.textContent = boardCollapsed ? "Show" : "Hide";
  button.setAttribute("aria-expanded", String(!boardCollapsed));
  blurActive();
});

function selfPosition(): Vec2 {
  const current = snapshot;
  if (!current) return { x: 0, y: 0 };
  const self = current.commanders.find((c) => c.id === current.selfCommanderId);
  return (
    rendered.get(current.selfCommanderId) ?? (self ? { x: self.x, y: self.y } : { x: 0, y: 0 })
  );
}

function screenToWorld(screen: Vec2): Vec2 {
  const origin = cameraCenter ?? selfPosition();
  const scale = worldLayer.scale.x || 0.75;
  const center = viewCenter();
  return {
    x: origin.x + (screen.x - center.x) / scale,
    y: origin.y + (screen.y - center.y) / scale,
  };
}

function steerDirection(): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  if (keys.has("a")) dx -= 1;
  if (keys.has("d")) dx += 1;
  if (keys.has("w")) dy -= 1;
  if (keys.has("s")) dy += 1;
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  return { dx, dy };
}

function sendSteer(force = false): void {
  if (!snapshot) return;
  const self = snapshot.commanders.find((c) => c.id === snapshot!.selfCommanderId);
  if (!self?.alive) return;
  const { dx, dy } = steerDirection();
  const key = `${dx.toFixed(2)},${dy.toFixed(2)}`;
  if (!force && key === lastSteerKey) return;
  lastSteerKey = key;
  command({ type: "steer", dx, dy });
}

function cycleWeapon(dir: 1 | -1): void {
  if (!snapshot) return;
  const self = snapshot.commanders.find((c) => c.id === snapshot!.selfCommanderId);
  const owned = self?.weapons ?? ["bolt"];
  if (owned.length < 2) {
    statusNote = "No other weapons — draft to unlock";
    statusNoteUntil = performance.now() + 2500;
    fields.status.textContent = statusNote;
    return;
  }
  const cur = owned.indexOf(self?.weapon ?? "bolt");
  const next = owned[(cur + dir + owned.length) % owned.length]!;
  command({ type: "switchWeapon", weapon: next });
}

function castTargetFromMouse(): Vec2 {
  const raw = screenToWorld(mouse);
  const self = snapshot?.commanders.find((c) => c.id === snapshot?.selfCommanderId);
  const origin = self ? { x: self.x, y: self.y } : selfPosition();
  const maxRange = self?.character === "warlock" ? 275 : 235;
  const dx = raw.x - origin.x;
  const dy = raw.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return origin;
  ensurePredictionWalls();
  const wantDist = Math.min(dist, maxRange);
  const ux = dx / dist;
  const uy = dy / dist;
  let safeX = origin.x;
  let safeY = origin.y;
  const steps = Math.max(1, Math.ceil(wantDist / 10));
  for (let i = 1; i <= steps; i++) {
    const r = (wantDist * i) / steps;
    const tx = origin.x + ux * r;
    const ty = origin.y + uy * r;
    if (!canStandClient(tx, ty, 2)) break;
    safeX = tx;
    safeY = ty;
  }
  return { x: Math.round(safeX), y: Math.round(safeY) };
}

addEventListener("keydown", (event) => {
  sfx.unlock();
  const key = event.key.toLowerCase();
  const targetEl = event.target as HTMLElement | null;
  if (targetEl?.tagName === "INPUT") {
    if (key === "enter") confirmChar();
    return;
  }
  if (key === "escape") {
    forgeModal.hidden = true;
    blurActive();
  }
  if (key === "m" && !event.repeat) {
    sfx.toggleMute();
    syncAudioButton();
    return;
  }
  keys.add(key);
  if (["w", "a", "s", "d"].includes(key)) {
    markHintLearned("move");
    sendSteer(true);
  }
  if (key === "q") {
    const target = castTargetFromMouse();
    spellFlashes.push({
      ...target,
      radius: 150,
      color: 0xffdf7e,
      started: performance.now(),
      expires: performance.now() + 450,
    });
    sfx.playSpell("nova");
    command({ type: "cast", spell: "nova", target });
  }
  if (key === "e") {
    const target = castTargetFromMouse();
    spellFlashes.push({
      ...target,
      radius: 95,
      color: 0xa8e0ff,
      started: performance.now(),
      expires: performance.now() + 400,
    });
    sfx.playSpell("volley");
    command({ type: "cast", spell: "volley", target });
  }
  if (key === "r") {
    const target = selfPosition();
    spellFlashes.push({
      ...target,
      radius: 130,
      color: 0x9fd8ff,
      started: performance.now(),
      expires: performance.now() + 500,
    });
    sfx.playSpell("shell");
    command({ type: "cast", spell: "shell", target });
  }
  if (key === "f") {
    const target = selfPosition();
    spellFlashes.push({
      ...target,
      radius: 140,
      color: 0x9fe8ff,
      started: performance.now(),
      expires: performance.now() + 500,
    });
    sfx.playSpell("frost");
    command({ type: "cast", spell: "frost", target });
  }
  if (key === "c") {
    const target = castTargetFromMouse();
    spellFlashes.push({
      ...target,
      radius: 70,
      color: 0xf1d36b,
      started: performance.now(),
      expires: performance.now() + 350,
    });
    sfx.playSpell("chain");
    command({ type: "cast", spell: "chain", target });
  }
  if (!fields.charSelect.hidden && ["1", "2", "3"].includes(key)) {
    const card = CHAR_CARDS[Number(key) - 1];
    if (card) selectChar(card.id);
  } else if (["1", "2", "3"].includes(key) && snapshot) {
    const self = snapshot.commanders.find((c) => c.id === snapshot!.selfCommanderId);
    const up = self?.pendingUpgrades?.[Number(key) - 1];
    if (up) chooseUpgrade(up);
  }
  if (key === "enter" && !fields.charSelect.hidden) confirmChar();
  if (key === "x") command({ type: "extract" });
  if (key === "h") command({ type: "stop" });
  if (key === "i" && !event.repeat) {
    if (forgeModal.hidden) $("#open-forge").click();
    else forgeModal.hidden = true;
    return;
  }
  if (key === "z" && !event.repeat) {
    send({ type: "buyService", idempotencyKey: crypto.randomUUID(), service: "mend" });
  }
  if (key === "v" && !event.repeat) {
    send({ type: "buyService", idempotencyKey: crypto.randomUUID(), service: "rally" });
  }
  if (key === "t" && !event.repeat) {
    send({ type: "buyService", idempotencyKey: crypto.randomUUID(), service: "mercenary" });
  }
  if (key === "n" && !event.repeat) {
    send({ type: "buyService", idempotencyKey: crypto.randomUUID(), service: "agent" });
  }
  if (key === "u" && !event.repeat) {
    send({ type: "buyService", idempotencyKey: crypto.randomUUID(), service: "armory" });
  }
  if (key === "p" && !event.repeat) {
    sfx.playWaveHorn();
    send({ type: "buyService", idempotencyKey: crypto.randomUUID(), service: "swarm_war" });
  }
  if (key === "b" && !event.repeat) {
    const target = selfPosition();
    spellFlashes.push({
      ...target,
      radius: 155,
      color: 0xff6b57,
      started: performance.now(),
      expires: performance.now() + 550,
    });
    sfx.playWaveHorn();
    send({
      type: "buyService",
      idempotencyKey: crypto.randomUUID(),
      service: "sos",
    });
  }
  if (key === "g" && !event.repeat) {
    markHintLearned("raise");
    const target = selfPosition();
    spellFlashes.push({
      ...target,
      radius: 58,
      color: 0x9ee37d,
      started: performance.now(),
      expires: performance.now() + 350,
    });
    sfx.playRaiseUnit();
    command({ type: "raiseUnit" });
  }
  if (key === " ") {
    markHintLearned("fire");
    spaceHeld = true;
    event.preventDefault();
  }
  if (key === "tab") {
    event.preventDefault();
    if (!event.repeat) cycleWeapon(event.shiftKey ? -1 : 1);
  }
});
addEventListener("keyup", (event) => {
  const released = event.key.toLowerCase();
  keys.delete(released);
  if (event.key === " ") spaceHeld = false;
  if (["w", "a", "s", "d"].includes(released)) sendSteer(true);
});
addEventListener("blur", () => {
  keys.clear();
  spaceHeld = false;
  mouseHeld = false;
});
addEventListener("pointermove", (event) => {
  mouse.x = event.clientX;
  mouse.y = event.clientY;
});
app.canvas.addEventListener("pointerdown", (event) => {
  sfx.unlock();
  mouse.x = event.clientX;
  mouse.y = event.clientY;
  blurActive();
  if (event.button === 0) {
    markHintLearned("fire");
    mouseHeld = true;
    shootTimer = 0;
    pollKeyboard(0);
    return;
  }
  const target = screenToWorld({ x: event.clientX, y: event.clientY });
  if (event.button === 1) {
    event.preventDefault();
    markHintLearned("swarm");
    command({ type: "defend", target });
  } else if (event.button === 2) {
    markHintLearned("swarm");
    command(event.shiftKey ? { type: "move", target } : { type: "attackMove", target });
  }
});
addEventListener("pointerup", (event) => {
  if (event.button === 0) mouseHeld = false;
});
app.canvas.addEventListener(
  "wheel",
  (event) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    cycleWeapon(event.deltaY > 0 ? 1 : -1);
  },
  { passive: false },
);
app.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

function selfInEntry(): boolean {
  if (!snapshot) return false;
  const self = snapshot.commanders.find((c) => c.id === snapshot!.selfCommanderId);
  const entry = (snapshot.world.rooms ?? []).find((r) => r.id === "entry");
  if (!self || !entry) return false;
  const ts = snapshot.world.tileSize;
  return (
    self.x >= entry.x * ts &&
    self.x <= (entry.x + entry.w) * ts &&
    self.y >= entry.y * ts &&
    self.y <= (entry.y + entry.h) * ts
  );
}

setInterval(() => pollKeyboard(0.05), 50);

function pollKeyboard(deltaSeconds: number): void {
  steerTimer -= deltaSeconds;
  if (steerTimer <= 0) {
    steerTimer = 0.15;
    const dir = steerDirection();
    if (dir.dx !== 0 || dir.dy !== 0) sendSteer(true);
    else if (lastSteerKey !== "0.00,0.00") sendSteer(true);
  }
  shootTimer -= deltaSeconds;
  if ((spaceHeld || mouseHeld) && shootTimer <= 0) {
    shootTimer = 0.16;
    const snap = snapshot;
    const firingSelf = snap?.commanders.find((c) => c.id === snap.selfCommanderId);
    if (firingSelf?.weapon === "orbit") {
      statusNote = "Soul Orbit is passive — blades hit on contact (Wheel/Tab to switch)";
      statusNoteUntil = performance.now() + 2500;
      fields.status.textContent = statusNote;
      const at = selfPosition();
      spellFlashes.push({
        x: at.x,
        y: at.y,
        radius: 72,
        color: 0x7dffd4,
        started: performance.now(),
        expires: performance.now() + 220,
      });
    } else if (selfInEntry()) {
      statusNote = "Weapons sealed in the Sanctuary — head east through the door to fight";
      statusNoteUntil = performance.now() + 2500;
      fields.status.textContent = statusNote;
      const at = selfPosition();
      spellFlashes.push({
        x: at.x,
        y: at.y,
        radius: 30,
        color: 0x8a8f98,
        started: performance.now(),
        expires: performance.now() + 220,
      });
    } else {
      command({ type: "shoot", target: screenToWorld(mouse) });
    }
  }
}

const ROOM_TINTS: Record<string, { color: number; alpha: number; label: string }> = {
  entry: { color: 0x8a7a52, alpha: 0.3, label: "SANCTUARY" },
  "crypt-west": { color: 0x46543e, alpha: 0.38, label: "WEST CRYPT" },
  "crypt-south": { color: 0x3e4c38, alpha: 0.38, label: "SOUTH CRYPT" },
  arena: { color: 0x6e2a20, alpha: 0.4, label: "ARENA" },
  shrine: { color: 0x8a6420, alpha: 0.45, label: "SHRINE" },
  extraction: { color: 0x2f6e5a, alpha: 0.42, label: "EXTRACT" },
  "bone-choir": { color: 0x7a2418, alpha: 0.5, label: "BONE CHOIR" },
};

function drawStatic(): void {
  if (!snapshot) return;
  const rooms = snapshot.world.rooms ?? [];
  const key = `${snapshot.world.widthTiles}x${snapshot.world.heightTiles}:${snapshot.world.walls.length}:${rooms.length}:gothic2`;
  if (staticDrawnFor === key) return;
  staticDrawnFor = key;
  const { tileSize, widthTiles, heightTiles, walls } = snapshot.world;
  staticLayer.clear();
  const wallSet = new Set(walls);
  const hash = (x: number, y: number) => ((x * 73856093) ^ (y * 19349663)) >>> 0;
  const stone = [0x2a231b, 0x2e271e, 0x262019, 0x332a20];
  staticLayer.rect(0, 0, widthTiles * tileSize, heightTiles * tileSize).fill(0x0a0806);
  for (let y = 0; y < heightTiles; y++) {
    for (let x = 0; x < widthTiles; x++) {
      const h = hash(x, y);
      if (wallSet.has(`${x},${y}`)) {
        staticLayer.rect(x * tileSize, y * tileSize, tileSize, tileSize).fill(0x0a0806);
        if (!wallSet.has(`${x},${y + 1}`)) {
          staticLayer.rect(x * tileSize, (y + 1) * tileSize - 5, tileSize, 5).fill(0x3a2f22);
        }
        if (h % 7 === 0) {
          staticLayer
            .rect(x * tileSize + 4, y * tileSize + 4, tileSize - 8, 3)
            .fill({ color: 0x2a2118, alpha: 0.8 });
        }
      } else {
        staticLayer.rect(x * tileSize, y * tileSize, tileSize, tileSize).fill(stone[h % 4]!);
        staticLayer
          .rect(x * tileSize, y * tileSize + tileSize - 2, tileSize, 2)
          .fill({ color: 0x000000, alpha: 0.35 });
        if (h % 5 === 0) {
          staticLayer
            .circle(x * tileSize + 6 + (h % 19), y * tileSize + 6 + ((h >> 5) % 19), 1.6)
            .fill({ color: 0x000000, alpha: 0.4 });
        }
        if (h % 11 === 0) {
          staticLayer
            .moveTo(x * tileSize + 5, y * tileSize + 24)
            .lineTo(x * tileSize + 15, y * tileSize + 13)
            .lineTo(x * tileSize + 24, y * tileSize + 17)
            .stroke({ color: 0x000000, width: 1.4, alpha: 0.45 });
        }
      }
    }
  }
  labelLayer.removeChildren();
  commanderLabels.clear();
  const roomLabelStyle = new TextStyle({
    fontFamily: "Cinzel, Georgia, serif",
    fontSize: 21,
    fontWeight: "700",
    fill: 0xe8dfc4,
    stroke: { color: 0x000000, width: 4 },
  });
  for (const room of rooms) {
    const tint = ROOM_TINTS[room.id];
    if (!tint) continue;
    const rx = room.x * tileSize;
    const ry = room.y * tileSize;
    const rw = room.w * tileSize;
    const rh = room.h * tileSize;
    staticLayer.rect(rx, ry, rw, rh).fill({ color: tint.color, alpha: tint.alpha });
    staticLayer
      .rect(rx + 3, ry + 3, rw - 6, rh - 6)
      .stroke({ color: 0xd9b45b, width: 1.6, alpha: 0.28 });
    const cx = rx + rw / 2;
    const cy = ry + rh / 2;
    if (room.id === "arena" || room.id === "bone-choir") {
      const ringColor = room.id === "arena" ? 0xd9b45b : 0xd84b3d;
      staticLayer
        .circle(cx, cy, tileSize * 1.7)
        .stroke({ color: ringColor, width: 2.4, alpha: 0.4 });
      staticLayer
        .circle(cx, cy, tileSize * 1.15)
        .stroke({ color: ringColor, width: 1.4, alpha: 0.3 });
      staticLayer
        .star(cx, cy, 6, tileSize * 0.9, tileSize * 0.4)
        .stroke({ color: ringColor, width: 1.4, alpha: 0.3 });
    } else if (room.id === "shrine" || room.id === "extraction" || room.id === "entry") {
      staticLayer
        .circle(cx, cy, tileSize * 1.2)
        .stroke({ color: tint.color, width: 3, alpha: 0.65 });
      staticLayer
        .poly([
          cx,
          cy - tileSize * 0.55,
          cx + tileSize * 0.55,
          cy,
          cx,
          cy + tileSize * 0.55,
          cx - tileSize * 0.55,
          cy,
        ])
        .stroke({ color: tint.color, width: 2, alpha: 0.6 });
    } else {
      for (let i = 0; i < 4; i++) {
        const tx = rx + ((hash(room.x + i * 3, room.y) % Math.max(2, room.w - 3)) + 1) * tileSize;
        const ty = ry + ((hash(room.x, room.y + i * 5) % Math.max(2, room.h - 2)) + 1) * tileSize;
        staticLayer
          .roundRect(tx, ty, tileSize * 0.9, tileSize * 1.7, 5)
          .fill({ color: 0x14100c, alpha: 0.55 });
        staticLayer
          .roundRect(tx, ty, tileSize * 0.9, tileSize * 1.7, 5)
          .stroke({ color: 0x8a7a52, width: 1.2, alpha: 0.35 });
      }
    }
    const label = new Text({
      text: tint.label,
      style: room.w >= 10 ? roomLabelStyle : { ...roomLabelStyle, fontSize: 16 },
    });
    label.anchor.set(0.5);
    label.position.set(cx, ry + tileSize * 0.75);
    label.alpha = 0.85;
    labelLayer.addChild(label);
  }
}

function ensurePredictionWalls(): void {
  if (!snapshot) return;
  const { widthTiles, heightTiles, walls } = snapshot.world;
  const key = `${widthTiles}x${heightTiles}:${walls.length}:${walls[0] ?? ""}:${walls.at(-1) ?? ""}`;
  if (key === predictionWallKey) return;
  predictionWallKey = key;
  predictionWalls = new Set(walls);
}

function isWallClient(x: number, y: number): boolean {
  if (!snapshot) return false;
  const tile = snapshot.world.tileSize;
  const tx = Math.floor(x / tile);
  const ty = Math.floor(y / tile);
  if (tx < 0 || ty < 0 || tx >= snapshot.world.widthTiles || ty >= snapshot.world.heightTiles)
    return true;
  return predictionWalls.has(`${tx},${ty}`);
}

function canStandClient(x: number, y: number, radius: number): boolean {
  return (
    !isWallClient(x, y) &&
    !isWallClient(x - radius, y) &&
    !isWallClient(x + radius, y) &&
    !isWallClient(x, y - radius) &&
    !isWallClient(x, y + radius)
  );
}

function smooth(id: string, x: number, y: number): Vec2 {
  const current = rendered.get(id) ?? { x, y };
  const dx = x - current.x;
  const dy = y - current.y;
  const isSelf = snapshot?.selfCommanderId === id;
  const t = 1 - Math.exp(-(isSelf ? 26 : 16) * frameDtSec);
  const base =
    dx * dx + dy * dy > 96 * 96 ? { x, y } : { x: current.x + dx * t, y: current.y + dy * t };
  rendered.set(id, base);
  if (!isSelf) return base;
  if (!predictedSelf || predictedCommanderId !== id) {
    const selfAtReset = snapshot?.commanders.find((c) => c.id === id);
    predictedSelf = { ...base };
    predictedCommanderId = id;
    predictedVel = { x: selfAtReset?.vx ?? 0, y: selfAtReset?.vy ?? 0 };
    predictedSnapshotTick = snapshot?.tick ?? -1;
  }
  if (lastPredictFrame !== drawFrame) {
    lastPredictFrame = drawFrame;
    const self = snapshot?.commanders.find((c) => c.id === id);
    if (snapshot && snapshot.tick !== predictedSnapshotTick) {
      predictedSnapshotTick = snapshot.tick;
      predictedVel = { x: self?.vx ?? 0, y: self?.vy ?? 0 };
    }
    const dt = Math.min(Math.max(frameDtSec, 0), 0.05);
    ensurePredictionWalls();
    const radius = snapshot?.entities.find((e) => e.id === id)?.radius ?? 14;
    if (!canStandClient(predictedSelf.x, predictedSelf.y, radius)) predictedSelf = { ...base };
    if (!self?.alive) {
      predictedSelf = { ...base };
      predictedVel = { x: 0, y: 0 };
    } else {
      const dir = steerDirection();
      let desiredX = 0;
      let desiredY = 0;
      if (dir.dx !== 0 || dir.dy !== 0) {
        const speed = self.moveSpeed ?? 190;
        desiredX = dir.dx * speed;
        desiredY = dir.dy * speed;
      } else if (self.stance === "stop") {
        desiredX = 0;
        desiredY = 0;
      } else {
        desiredX = self.vx ?? 0;
        desiredY = self.vy ?? 0;
      }
      const dvx = desiredX - predictedVel.x;
      const dvy = desiredY - predictedVel.y;
      const dv = Math.hypot(dvx, dvy);
      const slowing = Math.hypot(desiredX, desiredY) < Math.hypot(predictedVel.x, predictedVel.y);
      const maxDelta = (slowing ? 1800 : 1400) * dt;
      if (dv <= maxDelta) {
        predictedVel = { x: desiredX, y: desiredY };
      } else if (dv > 0) {
        predictedVel = {
          x: predictedVel.x + (dvx / dv) * maxDelta,
          y: predictedVel.y + (dvy / dv) * maxDelta,
        };
      }
      const nx = predictedSelf.x + predictedVel.x * dt;
      const ny = predictedSelf.y + predictedVel.y * dt;
      if (canStandClient(nx, predictedSelf.y, radius)) predictedSelf.x = nx;
      else predictedVel.x = 0;
      if (canStandClient(predictedSelf.x, ny, radius)) predictedSelf.y = ny;
      else predictedVel.y = 0;
    }
    const errX = base.x - predictedSelf.x;
    const errY = base.y - predictedSelf.y;
    if (errX * errX + errY * errY > 128 * 128) {
      predictedSelf = { ...base };
      predictedVel = { x: self?.vx ?? 0, y: self?.vy ?? 0 };
    } else {
      const corr = 1 - Math.exp(-10 * dt);
      predictedSelf.x += errX * corr;
      predictedSelf.y += errY * corr;
    }
  }
  return { x: predictedSelf.x, y: predictedSelf.y };
}

function roomCenter(id: string, fallback: Vec2): Vec2 {
  const room = snapshot?.world.rooms?.find((r) => r.id === id);
  if (!room || !snapshot) return fallback;
  const t = snapshot.world.tileSize;
  return { x: (room.x + room.w / 2) * t, y: (room.y + room.h / 2) * t };
}

function drawMinimap(center: Vec2, scale: number): void {
  if (!snapshot) return;
  const { tileSize, widthTiles, heightTiles, walls } = snapshot.world;
  const W = 196;
  const H = 140;
  const ox = playWidthPx() - W - 14;
  const oy = innerHeight - H - 72;
  minimapBase.position.set(ox, oy);
  minimapLayer.position.set(ox, oy);
  const ms = W / (widthTiles * tileSize);
  const baseKey = `${widthTiles}x${heightTiles}:${walls.length}:${snapshot.world.rooms?.length ?? 0}`;
  if (minimapDrawnFor !== baseKey) {
    minimapDrawnFor = baseKey;
    minimapBase.clear();
    minimapBase
      .roundRect(-6, -6, W + 12, H + 12, 6)
      .fill({ color: 0x0d0a08, alpha: 0.88 })
      .stroke({ color: 0xd9b45b, width: 1.2, alpha: 0.4 });
    minimapBase.rect(0, 0, W, H).fill(0x241d16);
    for (const room of snapshot.world.rooms ?? []) {
      const tint = ROOM_TINTS[room.id];
      if (!tint) continue;
      minimapBase
        .rect(
          room.x * tileSize * ms,
          room.y * tileSize * ms,
          room.w * tileSize * ms,
          room.h * tileSize * ms,
        )
        .fill({ color: tint.color, alpha: 0.55 });
    }
    const wallSet = new Set(walls);
    const cw = W / widthTiles;
    const ch = H / heightTiles;
    for (let y = 0; y < heightTiles; y++) {
      for (let x = 0; x < widthTiles; x++) {
        if (wallSet.has(`${x},${y}`)) minimapBase.rect(x * cw, y * ch, cw, ch).fill(0x060504);
      }
    }
  }
  minimapLayer.clear();
  const halfW = playWidthPx() / 2 / scale;
  const halfH = innerHeight / 2 / scale;
  minimapLayer
    .rect((center.x - halfW) * ms, (center.y - halfH) * ms, halfW * 2 * ms, halfH * 2 * ms)
    .stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
  const dot = (x: number, y: number, s: number, color: number) => {
    minimapLayer.poly([x, y - s, x + s, y, x, y + s, x - s, y]).fill(color);
  };
  for (const pickup of snapshot.pickups) {
    if (pickup.templateId === "relic") dot(pickup.x * ms, pickup.y * ms, 4, 0xf1d36b);
    if (pickup.templateId === "frenzy") dot(pickup.x * ms, pickup.y * ms, 3.5, 0xff8a3d);
    if (pickup.templateId === "vial") dot(pickup.x * ms, pickup.y * ms, 3.5, 0xff5a4e);
  }
  for (const entity of snapshot.entities) {
    if (entity.tag === "bone-choir") dot(entity.x * ms, entity.y * ms, 5, 0xd84b3d);
  }
  for (const commander of snapshot.commanders) {
    if (!commander.alive) continue;
    const pos = rendered.get(commander.id) ?? commander;
    dot(pos.x * ms, pos.y * ms, 4.5, ownerColor(commander.id, snapshot.selfCommanderId));
    if (commander.id === snapshot.selfCommanderId) {
      minimapLayer.circle(pos.x * ms, pos.y * ms, 6.5).stroke({ color: 0xffffff, width: 1.4 });
    }
  }
}

function ownerColor(ownerId: string | undefined, selfId: string): number {
  if (!ownerId) return 0xb8b29a;
  if (ownerId === selfId) return 0xe8c15a;
  let hash = 0;
  for (const ch of ownerId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return [0x6ec7a7, 0xd96c4a, 0x7ea6c9, 0xc97ea6][hash % 4]!;
}

async function loadSprites(): Promise<void> {
  try {
    const res = await fetch("/assets/manifest.json");
    if (!res.ok) return;
    const raw = (await res.json()) as unknown;
    type RawEntry = {
      name: string;
      file: string;
      draw_height?: number | undefined;
      anchor?: string | undefined;
      frames?: number | undefined;
      cell_w?: number | undefined;
    };
    let entries: RawEntry[] = [];
    if (Array.isArray(raw)) {
      entries = raw as RawEntry[];
    } else if (raw && typeof raw === "object") {
      entries = Object.entries(
        raw as Record<string, { file: string; draw_height?: number; anchor?: string }>,
      ).map(([name, v]) => ({ name, file: v.file, draw_height: v.draw_height, anchor: v.anchor }));
    }
    await Promise.all(
      entries.map(async (e) => {
        try {
          const url = e.file.startsWith("/") ? e.file : `/${e.file}`;
          const texture = await Assets.load<Texture>(url);
          let frames: Texture[] | undefined;
          if (e.frames && e.frames > 1) {
            const cellW = e.cell_w ?? Math.floor(texture.width / e.frames);
            frames = Array.from(
              { length: e.frames },
              (_, i) =>
                new Texture({
                  source: texture.source,
                  frame: new Rectangle(i * cellW, 0, cellW, texture.height),
                }),
            );
          }
          textures.set(e.name, {
            texture: frames?.[0] ?? texture,
            drawHeight: e.draw_height ?? texture.height,
            anchor: e.anchor ?? "center",
            ...(frames ? { frames } : {}),
          });
        } catch {
          /* glyph fallback */
        }
      }),
    );
  } catch {
    /* glyph fallback */
  }
}
void loadSprites();

function ensureSprite(
  pool: Map<string, PlacedSprite>,
  id: string,
  texName: string,
): PlacedSprite | undefined {
  const entry = textures.get(texName);
  if (!entry) return undefined;
  let placed = pool.get(id);
  if (!placed) {
    const s = new Sprite(entry.texture);
    s.anchor.set(0.5, entry.anchor === "bottom-center" ? 1 : 0.5);
    const scale = entry.drawHeight / entry.texture.height;
    s.scale.set(scale);
    spriteLayer.addChild(s);
    placed = { s, scale };
    pool.set(id, placed);
  }
  return placed;
}

const COMMANDER_SPRITES: Record<CharacterId, string> = {
  necromancer: "commander",
  warlock: "commander-warlock",
  boneknight: "commander-boneknight",
};

function entityTexName(entity: ZoneSnapshot["entities"][number], character?: CharacterId): string {
  if (entity.kind === "commander") return character ? COMMANDER_SPRITES[character] : "commander";
  if (entity.kind === "unit") return "minion";
  if (entity.tag === "bone-choir") return "boss";
  if (entity.tag === "bone-warden") return "brute";
  return "skeleton";
}

const PICKUP_TEXTURES: Record<string, string> = {
  essence: "pickup-soul-shard",
  relic: "pickup-relic",
  vial: "pickup-health-vial",
  haste: "pickup-powerup-orb",
  fang: "pickup-powerup-orb",
  frenzy: "pickup-powerup-orb",
};

function pickupTexName(templateId: string): string {
  return PICKUP_TEXTURES[templateId] ?? "pickup-powerup-orb";
}

const PICKUP_GLOW: Record<string, number> = {
  essence: 0x9ee37d,
  relic: 0xf1d36b,
  haste: 0x6fd3e7,
  fang: 0xe07a4f,
  frenzy: 0xff8a3d,
  vial: 0xff5a4e,
};

function classWeaponScale(character?: CharacterId, level = 1): number {
  const base = character === "boneknight" ? 1.24 : character === "warlock" ? 1.15 : 1.08;
  return base * (1 + Math.min(0.22, Math.max(0, level - 1) * 0.025));
}

function drawProjectileWeapon(
  weapon: WeaponId,
  pos: Vec2,
  ang: number,
  color: number,
  boltR: number,
  scale: number,
  now: number,
): void {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const px = -uy;
  const py = ux;
  const pt = (along: number, perp: number): [number, number] => [
    pos.x + ux * along + px * perp,
    pos.y + uy * along + py * perp,
  ];

  if (weapon === "scythe") {
    // Forged Steel & Ember-Gold Executioner Battle-Axe / Crescent Cleave Wave
    const span = Math.max(20, boltR * 1.1) * scale;
    const bow = 14 * scale;
    const outerPts: number[] = [];
    const innerPts: number[] = [];
    const steps = 8;
    for (let i = -steps; i <= steps; i++) {
      const t = i / steps; // -1 .. 1
      const arch = 1 - t * t;
      const alongOuter = arch * bow - (1 - arch) * 7 * scale;
      const alongInner = arch * (bow - 8.5 * scale) - (1 - arch) * 9.5 * scale;
      const perp = t * span;
      outerPts.push(...pt(alongOuter, perp));
      innerPts.unshift(...pt(alongInner, perp));
    }
    dynamicLayer
      .poly([...outerPts, ...innerPts])
      .fill({ color: 0x261d17, alpha: 0.94 })
      .stroke({ color: 0xe8c15a, width: 2.4 * scale, alpha: 0.96 });
    // Forged steel & gold razor edge highlight along outer arc
    for (let i = 0; i < outerPts.length - 2; i += 2) {
      if (i === 0) dynamicLayer.moveTo(outerPts[i]!, outerPts[i + 1]!);
      else dynamicLayer.lineTo(outerPts[i]!, outerPts[i + 1]!);
    }
    dynamicLayer.stroke({ color: 0xfff3d1, width: 2 * scale, alpha: 0.95 });
    // Twin bearded battle-axe head spinning inside the cleave shockwave
    const spin = now * 0.018;
    for (let b = 0; b < 2; b++) {
      const bang = spin + b * Math.PI;
      const bx = Math.cos(bang);
      const by = Math.sin(bang);
      const bpx = -by;
      const bpy = bx;
      const rLen = 11.5 * scale;
      dynamicLayer
        .poly([
          pos.x + bx * rLen + bpx * 6 * scale,
          pos.y + by * rLen + bpy * 6 * scale,
          pos.x + bx * (rLen * 1.18),
          pos.y + by * (rLen * 1.18),
          pos.x + bx * rLen - bpx * 6 * scale,
          pos.y + by * rLen - bpy * 6 * scale,
          pos.x + bx * (rLen * 0.28) - bpx * 2.2 * scale,
          pos.y + by * (rLen * 0.28) - bpy * 2.2 * scale,
          pos.x + bx * (rLen * 0.28) + bpx * 2.2 * scale,
          pos.y + by * (rLen * 0.28) + bpy * 2.2 * scale,
        ])
        .fill({ color: 0xd9d2c5, alpha: 0.92 })
        .stroke({ color: 0x241a12, width: 1.3, alpha: 0.95 });
    }
    dynamicLayer
      .circle(pos.x, pos.y, 3.4 * scale)
      .fill(0xe8c15a)
      .stroke({ color: 0x1c140e, width: 1.2 });
    return;
  }

  if (weapon === "lance" || weapon === "phantom") {
    const isPhantom = weapon === "phantom";
    const len = (isPhantom ? 38 : 32) * scale;
    const drawSpear = (offAlong: number, offPerp: number, alphaMul: number, sMul: number) => {
      const L = len * sMul;
      const W = 5.2 * scale * sMul;
      const p = (a: number, pr: number) => pt(a + offAlong, pr + offPerp);
      // Obsidian shaft
      const [sx0, sy0] = p(-L * 0.58, 0);
      const [sx1, sy1] = p(L * 0.12, 0);
      dynamicLayer
        .moveTo(sx0, sy0)
        .lineTo(sx1, sy1)
        .stroke({ color: 0x231b16, width: 3.2 * sMul, alpha: 0.95 * alphaMul });
      // Tail fletching chevron
      const [fxL, fyL] = p(-L * 0.58, W * 0.85);
      const [fxM, fyM] = p(-L * 0.42, 0);
      const [fxR, fyR] = p(-L * 0.58, -W * 0.85);
      dynamicLayer
        .poly([fxL, fyL, fxM, fyM, fxR, fyR])
        .stroke({ color, width: 1.8 * sMul, alpha: 0.8 * alphaMul });
      // Crossguard barbs
      const [gxL, gyL] = p(L * 0.02, W * 1.35);
      const [gxC, gyC] = p(L * 0.14, 0);
      const [gxR, gyR] = p(L * 0.02, -W * 1.35);
      dynamicLayer
        .moveTo(gxL, gyL)
        .lineTo(gxC, gyC)
        .lineTo(gxR, gyR)
        .stroke({ color, width: 2.1 * sMul, alpha: 0.9 * alphaMul });
      // Long faceted spearhead
      const [tipX, tipY] = p(L * 0.62, 0);
      const [wingLX, wingLY] = p(L * 0.12, W);
      const [tangX, tangY] = p(L * 0.02, 0);
      const [wingRX, wingRY] = p(L * 0.12, -W);
      dynamicLayer
        .poly([tipX, tipY, wingLX, wingLY, tangX, tangY, wingRX, wingRY])
        .fill({ color, alpha: 0.92 * alphaMul })
        .stroke({ color: 0x1a1310, width: 1.3, alpha: 0.85 * alphaMul });
      // Razor center ridge
      dynamicLayer
        .moveTo(tangX, tangY)
        .lineTo(tipX, tipY)
        .stroke({ color: 0xffffff, width: 1.7 * sMul, alpha: 0.92 * alphaMul });
    };
    if (isPhantom) {
      drawSpear(-6 * scale, 8.5 * scale, 0.52, 0.78);
      drawSpear(-6 * scale, -8.5 * scale, 0.52, 0.78);
    }
    drawSpear(0, 0, 1, 1);
    return;
  }

  if (weapon === "storm") {
    // Crackling lightning harpoon with animated zig-zag electric spine
    const L = 25 * scale;
    const W = 4.6 * scale;
    const [tailX, tailY] = pt(-L * 0.52, 0);
    const [tipX, tipY] = pt(L * 0.58, 0);
    // Zig-zag electric arc along the bolt
    dynamicLayer.moveTo(tailX, tailY);
    for (let s = 1; s <= 4; s++) {
      const f = s / 5;
      const jag = (s % 2 === 0 ? 1 : -1) * (3.2 + Math.sin(now * 0.045 + s * 1.9) * 1.8) * scale;
      const [zx, zy] = pt(-L * 0.52 + L * 1.1 * f, jag);
      dynamicLayer.lineTo(zx, zy);
    }
    dynamicLayer.lineTo(tipX, tipY);
    dynamicLayer.stroke({ color: 0xe9d8ff, width: 2.2 * scale, alpha: 0.95 });
    // Trident head
    const [bLX, bLY] = pt(L * 0.15, W * 1.25);
    const [bRX, bRY] = pt(L * 0.15, -W * 1.25);
    const [nX, nY] = pt(L * 0.08, 0);
    dynamicLayer
      .poly([tipX, tipY, bLX, bLY, nX, nY, bRX, bRY])
      .fill({ color, alpha: 0.92 })
      .stroke({ color: 0xf6efff, width: 1.4, alpha: 0.95 });
    return;
  }

  if (weapon === "scatter" || weapon === "hellscatter") {
    // Jagged bone / hellfire shard flechette
    const isHell = weapon === "hellscatter";
    const L = (isHell ? 19 : 15.5) * scale;
    const W = (isHell ? 4.4 : 3.5) * scale;
    const [tipX, tipY] = pt(L * 0.6, 0);
    const [barbLX, barbLY] = pt(L * 0.05, W);
    const [notchLX, notchLY] = pt(-L * 0.1, W * 0.45);
    const [tailX, tailY] = pt(-L * 0.48, 0);
    const [barbRX, barbRY] = pt(L * 0.12, -W * 0.85);
    dynamicLayer
      .poly([tipX, tipY, barbLX, barbLY, notchLX, notchLY, tailX, tailY, barbRX, barbRY])
      .fill({ color: isHell ? 0xff6a24 : color, alpha: 0.94 })
      .stroke({ color: 0x24140c, width: 1.3, alpha: 0.9 });
    dynamicLayer
      .moveTo(tailX, tailY)
      .lineTo(tipX, tipY)
      .stroke({ color: 0xfff4d4, width: 1.5, alpha: 0.9 });
    return;
  }

  if (weapon === "wisp") {
    // Homing spectral skull-wisp with horned cranium, hollow eyes, and undulating ectoplasm ribbons
    const r = 5.4 * scale;
    for (let t = -1; t <= 1; t++) {
      const wave = Math.sin(now * 0.018 + t * 1.4) * 2.6 * scale;
      const [t0x, t0y] = pt(-r * 0.4, t * r * 0.48);
      const [t1x, t1y] = pt(-r * 2.5, t * r * 0.7 + wave);
      dynamicLayer
        .moveTo(t0x, t0y)
        .lineTo(t1x, t1y)
        .stroke({ color, width: (t === 0 ? 2.6 : 1.7) * scale, alpha: t === 0 ? 0.85 : 0.55 });
    }
    const [jawX, jawY] = pt(r * 1.15, 0);
    const [cheekLX, cheekLY] = pt(r * 0.25, r * 0.92);
    const [hornLX, hornLY] = pt(-r * 0.85, r * 1.05);
    const [crownX, crownY] = pt(-r * 0.65, 0);
    const [hornRX, hornRY] = pt(-r * 0.85, -r * 1.05);
    const [cheekRX, cheekRY] = pt(r * 0.25, -r * 0.92);
    dynamicLayer
      .poly([
        jawX,
        jawY,
        cheekLX,
        cheekLY,
        hornLX,
        hornLY,
        crownX,
        crownY,
        hornRX,
        hornRY,
        cheekRX,
        cheekRY,
      ])
      .fill({ color: 0xdffef2, alpha: 0.95 })
      .stroke({ color, width: 1.6 * scale, alpha: 0.9 });
    const [eyeLX, eyeLY] = pt(r * 0.2, r * 0.36);
    const [eyeRX, eyeRY] = pt(r * 0.2, -r * 0.36);
    dynamicLayer.circle(eyeLX, eyeLY, 1.35 * scale).fill(0x0b1f18);
    dynamicLayer.circle(eyeRX, eyeRY, 1.35 * scale).fill(0x0b1f18);
    return;
  }

  // Default: "bolt" — sleek arcane crossbow quarrel / runic dart
  const L = 21 * scale;
  const W = 3.8 * scale;
  const [tailX, tailY] = pt(-L * 0.52, 0);
  const [neckX, neckY] = pt(L * 0.1, 0);
  dynamicLayer
    .moveTo(tailX, tailY)
    .lineTo(neckX, neckY)
    .stroke({ color: 0x2c2016, width: 2.6 * scale, alpha: 0.92 });
  // Fletching fins
  const [finLX, finLY] = pt(-L * 0.52, W * 0.95);
  const [finMX, finMY] = pt(-L * 0.32, 0);
  const [finRX, finRY] = pt(-L * 0.52, -W * 0.95);
  dynamicLayer
    .poly([finLX, finLY, finMX, finMY, finRX, finRY])
    .stroke({ color, width: 1.6 * scale, alpha: 0.85 });
  // Diamond quarrel head
  const [tipX, tipY] = pt(L * 0.56, 0);
  const [wLX, wLY] = pt(L * 0.1, W);
  const [tangX, tangY] = pt(-L * 0.02, 0);
  const [wRX, wRY] = pt(L * 0.1, -W);
  dynamicLayer
    .poly([tipX, tipY, wLX, wLY, tangX, tangY, wRX, wRY])
    .fill({ color, alpha: 0.95 })
    .stroke({ color: 0x241910, width: 1.2, alpha: 0.88 });
  dynamicLayer
    .moveTo(tangX, tangY)
    .lineTo(tipX, tipY)
    .stroke({ color: 0xfff8e6, width: 1.5 * scale, alpha: 0.95 });
}

function drawHeldWeapon(
  pos: Vec2,
  r: number,
  character: CharacterId | undefined,
  weapon: WeaponId,
  level: number,
  aimAng: number,
  jabP: number,
  _now: number,
): void {
  // Painted character sprites already carry their iconic weapons (Bone Knight warhammer/shield,
  // Necromancer skull staff, Warlock grimoire). Never draw a static polygon over the sprite!
  // Only render a crisp, non-occluding directional slash/cast arc outside `r` during active attack frames.
  if (jabP < 0 || jabP >= 1) return;
  const scale = classWeaponScale(character, level);
  const swingSin = Math.sin(jabP * Math.PI);
  const arcRadius = (r + 18) * scale;
  const halfSpan = weapon === "scythe" ? 0.85 : 0.42;
  const steps = 6;
  const color =
    weapon === "scythe"
      ? 0xe8c15a
      : weapon === "wisp"
        ? 0x7dffd4
        : weapon === "storm"
          ? 0xb78bff
          : 0xffcf70;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = aimAng + (t - 0.5) * 2 * halfSpan;
    const px = pos.x + Math.cos(ang) * arcRadius;
    const py = pos.y + Math.sin(ang) * arcRadius;
    if (i === 0) dynamicLayer.moveTo(px, py);
    else dynamicLayer.lineTo(px, py);
  }
  dynamicLayer.stroke({ color, width: 2.6 * scale, alpha: 0.78 * swingSin });
}

function burst(
  x: number,
  y: number,
  color: number,
  count: number,
  speed = 90,
  life = 480,
  size = 2.4,
): void {
  const nowMs = performance.now();
  for (let i = 0; i < count; i++) {
    if (particles.length > 260) return;
    const angle = Math.random() * Math.PI * 2;
    const v = speed * (0.35 + Math.random() * 0.85);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v - 30,
      started: nowMs,
      expires: nowMs + life * (0.6 + Math.random() * 0.7),
      color,
      size,
    });
  }
}

function draw(): void {
  if (!snapshot) return;
  drawFrame++;
  const joining = !sawFirstSnapshot;
  sawFirstSnapshot = true;
  drawStatic();
  const self = snapshot.commanders.find((c) => c.id === snapshot!.selfCommanderId);
  if (!self) return;
  const anchor = smooth(self.id, self.x, self.y);
  const scale = innerWidth < 820 ? 0.95 : 1.4;
  worldLayer.scale.set(scale);
  const vc = viewCenter();
  const lookX = Math.max(-90, Math.min(90, ((mouse.x - vc.x) / scale) * 0.16));
  const lookY = Math.max(-70, Math.min(70, ((mouse.y - vc.y) / scale) * 0.13));
  if (!cameraCenter || Math.hypot(anchor.x - cameraCenter.x, anchor.y - cameraCenter.y) > 640) {
    cameraCenter = { ...anchor };
  }
  const camT = 1 - Math.exp(-9 * frameDtSec);
  cameraCenter.x += (anchor.x + lookX - cameraCenter.x) * camT;
  cameraCenter.y += (anchor.y + lookY - cameraCenter.y) * camT;
  const center = cameraCenter;
  const shakeX = shakePx > 0 ? (Math.random() * 2 - 1) * shakePx : 0;
  const shakeY = shakePx > 0 ? (Math.random() * 2 - 1) * shakePx : 0;
  worldLayer.position.set(vc.x - center.x * scale + shakeX, vc.y - center.y * scale + shakeY);

  dynamicLayer.clear();
  const tileSize = snapshot.world.tileSize;
  const pulse = 18 + Math.sin(performance.now() / 260) * 5;
  dynamicLayer
    .circle(50 * tileSize, 20 * tileSize, pulse)
    .stroke({ color: 0x62d2a2, width: 3, alpha: 0.8 });
  dynamicLayer
    .circle(48 * tileSize, 8 * tileSize, pulse)
    .stroke({ color: 0xe8c15a, width: 3, alpha: 0.8 });
  const now = performance.now();
  const dtSec = Math.min(0.05, (now - (lastDrawMs || now)) / 1000);
  lastDrawMs = now;
  frameDtSec = dtSec > 0 ? dtSec : 0.016;
  if (now < hitStopUntil) frameDtSec *= 0.12;
  shakePx *= Math.exp(-8 * dtSec);
  if (shakePx < 0.1) shakePx = 0;
  prevEliteIds.clear();
  for (const id of eliteIds) prevEliteIds.add(id);
  eliteIds.clear();
  for (const e of snapshot.entities) if (e.elite) eliteIds.add(e.id);
  const currentAlerted = new Set<string>();
  for (const e of snapshot.entities) {
    if (!e.alerted) continue;
    currentAlerted.add(e.id);
    if (!prevAlerted.has(e.id) && damageNumbers.length < 20) {
      const at = rendered.get(e.id) ?? e;
      if (Math.hypot(at.x - center.x, at.y - center.y) < 900) {
        const text = new Text({
          text: "!",
          style: new TextStyle({
            fontFamily: "Avenir Next, sans-serif",
            fontSize: 12,
            fontWeight: "700",
            fill: 0xf3deb1,
            stroke: { color: 0x000000, width: 3 },
          }),
        });
        text.anchor.set(0.5, 1);
        text.position.set(at.x, at.y - 34);
        labelLayer.addChild(text);
        damageNumbers.push({
          text,
          x: at.x,
          y: at.y - 34,
          started: now,
          expires: now + 620,
        });
      }
    }
  }
  prevAlerted.clear();
  for (const id of currentAlerted) prevAlerted.add(id);
  decalLayer.clear();
  for (let i = bloodDecals.length - 1; i >= 0; i--) {
    const d = bloodDecals[i]!;
    const age = now - d.started;
    if (age > 60000) {
      bloodDecals.splice(i, 1);
      continue;
    }
    const decalAlpha = 0.5 * (1 - age / 60000);
    decalLayer
      .ellipse(d.x, d.y, d.r * d.wob, d.r * 0.55)
      .fill({ color: 0x4a0e0c, alpha: decalAlpha });
    decalLayer
      .ellipse(
        d.x + Math.cos(d.rot) * d.r * 0.7,
        d.y + Math.sin(d.rot) * d.r * 0.4,
        d.r * 0.5 * d.wob,
        d.r * 0.3,
      )
      .fill({ color: 0x4a0e0c, alpha: decalAlpha * 0.8 });
  }
  for (let i = spellFlashes.length - 1; i >= 0; i--) {
    const flash = spellFlashes[i]!;
    if (flash.expires <= now) {
      spellFlashes.splice(i, 1);
      continue;
    }
    const t = (now - flash.started) / (flash.expires - flash.started);
    dynamicLayer
      .circle(flash.x, flash.y, flash.radius * (0.35 + 0.65 * t))
      .fill({ color: flash.color, alpha: 0.16 * (1 - t) });
    dynamicLayer
      .circle(flash.x, flash.y, flash.radius * (0.35 + 0.65 * t))
      .stroke({ color: flash.color, width: 4, alpha: 0.85 * (1 - t) });
  }
  for (const fx of snapshot.effects ?? []) {
    if (fx.kind !== "chain" || fx.points.length < 2) continue;
    const first = fx.points[0]!;
    const last = fx.points[fx.points.length - 1]!;
    const key = `${fx.tick}:${fx.points.length}:${first.x},${first.y}:${last.x},${last.y}`;
    if (seenChainFx.has(key)) continue;
    if (seenChainFx.size > 500) seenChainFx.clear();
    seenChainFx.add(key);
    chainAnims.push({ points: fx.points.map((p) => ({ ...p })), started: now });
  }
  for (let i = chainAnims.length - 1; i >= 0; i--) {
    const anim = chainAnims[i]!;
    const t = (now - anim.started) / 350;
    if (t >= 1) {
      chainAnims.splice(i, 1);
      continue;
    }
    for (const pass of [
      { width: 5, alpha: 0.22 },
      { width: 2.2, alpha: 0.9 },
    ]) {
      dynamicLayer.moveTo(anim.points[0]!.x, anim.points[0]!.y);
      for (let s = 1; s < anim.points.length; s++) {
        const a = anim.points[s - 1]!;
        const b = anim.points[s]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const off = (Math.random() - 0.5) * 22;
        dynamicLayer.lineTo(
          (a.x + b.x) / 2 + (-dy / len) * off,
          (a.y + b.y) / 2 + (dx / len) * off,
        );
        dynamicLayer.lineTo(b.x, b.y);
      }
      dynamicLayer.stroke({ color: 0xf1d36b, width: pass.width, alpha: pass.alpha * (1 - t) });
    }
  }
  const liveIds = new Set(snapshot.entities.map((e) => e.id));
  for (const entity of snapshot.entities) {
    const prev = prevHp.get(entity.id);
    if (prev !== undefined && entity.hp < prev) {
      hitFlashes.push({
        x: entity.x,
        y: entity.y,
        death: false,
        started: now,
        expires: now + 280,
      });
      burst(
        entity.x,
        entity.y,
        entity.ownerId === snapshot.selfCommanderId || entity.id === snapshot.selfCommanderId
          ? 0xff7a5c
          : 0xe8dfc4,
        3,
        70,
        380,
        2,
      );
      if (entity.id === snapshot.selfCommanderId) {
        hurtUntil = now + 220;
        sfx.playHurt(entity.maxHp > 0 ? entity.hp / entity.maxHp : 1);
      } else if (Math.hypot(entity.x - center.x, entity.y - center.y) < 520) {
        sfx.playHit({
          ...(entity.elite ? { elite: true } : {}),
          ...(entity.id === "boss-bone-choir" ? { boss: true } : {}),
        });
      }
      const amount = Math.round(prev - entity.hp);
      if (amount >= 1) {
        const mine =
          entity.ownerId === snapshot.selfCommanderId || entity.id === snapshot.selfCommanderId;
        const acc = damageAccum.get(entity.id);
        if (acc) {
          acc.total += amount;
          acc.flushAt = now + 220;
        } else {
          damageAccum.set(entity.id, {
            total: amount,
            mine,
            kind: entity.kind,
            radius: entity.radius,
            flushAt: now + 220,
          });
        }
      }
    }
    prevHp.set(entity.id, entity.hp);
  }
  for (const [id] of prevHp) {
    if (!liveIds.has(id)) {
      const pos = rendered.get(id);
      if (pos) {
        hitFlashes.push({ x: pos.x, y: pos.y, death: true, started: now, expires: now + 420 });
        burst(pos.x, pos.y, 0xff6b57, 9, 130, 560, 2.6);
        if (Math.hypot(pos.x - center.x, pos.y - center.y) < 560) {
          sfx.playHit({
            kill: true,
            ...(prevEliteIds.has(id) ? { elite: true } : {}),
            ...(id === "boss-bone-choir" ? { boss: true } : {}),
          });
        }
        if (id.startsWith("monster-") || id.startsWith("unit-") || id === "boss-bone-choir") {
          bloodDecals.push({
            x: pos.x,
            y: pos.y,
            r: id === "boss-bone-choir" ? 30 : 12,
            started: now,
            rot: Math.random() * Math.PI,
            wob: 0.7 + Math.random() * 0.7,
          });
          if (bloodDecals.length > 240) bloodDecals.splice(0, bloodDecals.length - 240);
        }
        if (
          (id === "boss-bone-choir" || prevEliteIds.has(id)) &&
          Math.hypot(pos.x - center.x, pos.y - center.y) < 700
        ) {
          hitStopUntil = now + 60;
          shakePx = Math.max(shakePx, 6);
        }
      }
      firstSeenAt.delete(id);
      prevHp.delete(id);
      rendered.delete(id);
      spriteMotion.delete(id);
      damageAccum.delete(id);
    }
  }
  for (const [id, acc] of damageAccum) {
    if (now < acc.flushAt) continue;
    damageAccum.delete(id);
    if (damageNumbers.length >= 20) continue;
    const at = rendered.get(id);
    if (!at) continue;
    const text = new Text({
      text: String(acc.total),
      style: new TextStyle({
        fontFamily: "Avenir Next, sans-serif",
        fontSize: acc.kind === "commander" ? 13 : 10,
        fontWeight: "700",
        fill: acc.mine ? 0xff7a5c : acc.kind === "monster" ? 0xe8dfc4 : 0xf1d36b,
        stroke: { color: 0x000000, width: 3 },
      }),
    });
    text.anchor.set(0.5, 1);
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    const jx = (((hash % 17) + 17) % 17) - 8;
    const jy = (damageNumbers.length % 3) * 9;
    text.position.set(at.x + jx, at.y - acc.radius - 6 - jy);
    labelLayer.addChild(text);
    damageNumbers.push({
      text,
      x: at.x + jx,
      y: at.y - acc.radius - 6 - jy,
      started: now,
      expires: now + 620,
    });
  }
  const livePickupIds = new Set(snapshot.pickups.map((p) => p.id));
  for (const pickup of snapshot.pickups) {
    const r = pickup.radius;
    prevPickups.set(pickup.id, { x: pickup.x, y: pickup.y, templateId: pickup.templateId });
    const distCenter = Math.hypot(pickup.x - center.x, pickup.y - center.y);
    if (distCenter > 760) {
      const placedPickup = pickupSprites.get(pickup.id);
      if (placedPickup) placedPickup.s.visible = false;
      const label = pickupLabels.get(pickup.id);
      if (label) label.visible = false;
      continue;
    }
    const placedPickup = ensureSprite(pickupSprites, pickup.id, pickupTexName(pickup.templateId));
    if (placedPickup) {
      const bob = Math.sin(now / 300 + (pickup.x % 7)) * 2;
      placedPickup.s.position.set(pickup.x, pickup.y + bob);
      placedPickup.s.zIndex = Math.round(pickup.y);
      placedPickup.s.visible = true;
      const glow = PICKUP_GLOW[pickup.templateId] ?? 0xffffff;
      if (distCenter <= 460) {
        dynamicLayer
          .circle(pickup.x, pickup.y, r + 7 + Math.sin(now / 240) * 2)
          .stroke({ color: glow, width: 1.6, alpha: 0.55 });
      }
      if (pickup.templateId !== "essence") {
        const showLabel = pickup.templateId === "relic" || distCenter <= 175;
        let label = pickupLabels.get(pickup.id);
        if (showLabel && !label) {
          label = new Text({
            text: pickup.label,
            style: new TextStyle({
              fontFamily: "Avenir Next, sans-serif",
              fontSize: 11,
              fontWeight: "700",
              fill: glow,
              stroke: { color: 0x000000, width: 3 },
            }),
          });
          label.anchor.set(0.5, 1);
          labelLayer.addChild(label);
          pickupLabels.set(pickup.id, label);
        }
        if (label) {
          label.position.set(pickup.x, pickup.y - r - 14);
          label.visible = showLabel;
        }
      }
    } else if (pickup.templateId === "relic") {
      dynamicLayer.circle(pickup.x, pickup.y, r).fill(0xf1d36b);
      dynamicLayer
        .poly([
          pickup.x,
          pickup.y - r * 0.55,
          pickup.x + r * 0.55,
          pickup.y,
          pickup.x,
          pickup.y + r * 0.55,
          pickup.x - r * 0.55,
          pickup.y,
        ])
        .fill(0x7a4d12);
      dynamicLayer
        .circle(pickup.x, pickup.y, r + 6 + Math.sin(now / 240) * 2)
        .stroke({ color: 0xf1d36b, width: 2, alpha: 0.7 });
    } else if (pickup.templateId === "essence") {
      dynamicLayer
        .poly([
          pickup.x,
          pickup.y - r,
          pickup.x + r,
          pickup.y,
          pickup.x,
          pickup.y + r,
          pickup.x - r,
          pickup.y,
        ])
        .fill(0x9ee37d);
    } else if (pickup.templateId === "haste") {
      dynamicLayer
        .poly([pickup.x, pickup.y - r, pickup.x + r, pickup.y + r, pickup.x - r, pickup.y + r])
        .fill(0x6fd3e7);
    } else {
      dynamicLayer
        .poly([pickup.x, pickup.y + r, pickup.x + r, pickup.y - r, pickup.x - r, pickup.y - r])
        .fill(0xe07a4f);
    }
  }
  for (const [id, placed] of pickupSprites) {
    if (!livePickupIds.has(id)) {
      spriteLayer.removeChild(placed.s);
      placed.s.destroy({ texture: false });
      pickupSprites.delete(id);
    }
  }
  for (const [id, label] of pickupLabels) {
    if (!livePickupIds.has(id)) {
      labelLayer.removeChild(label);
      label.destroy();
      pickupLabels.delete(id);
    }
  }
  for (const [id, prev] of prevPickups) {
    if (!livePickupIds.has(id)) {
      if (Math.hypot(prev.x - center.x, prev.y - center.y) < 800) {
        burst(prev.x, prev.y, PICKUP_GLOW[prev.templateId] ?? 0xffffff, 6, 80, 420, 2);
      }
      if (Math.hypot(prev.x - anchor.x, prev.y - anchor.y) < 160) {
        sfx.playPickup(prev.templateId);
      }
      prevPickups.delete(id);
    }
  }
  const commanderById = new Map(snapshot.commanders.map((c) => [c.id, c]));
  for (const c of snapshot.commanders) {
    const lvl = c.level ?? 1;
    const prev = prevLevel.get(c.id);
    if (prev !== undefined && lvl > prev) {
      if (c.id === snapshot.selfCommanderId) sfx.playLevelUp();
      const at = rendered.get(c.id) ?? c;
      burst(at.x, at.y, 0xf1d36b, 16, 120, 700, 2.6);
      spellFlashes.push({
        x: at.x,
        y: at.y,
        radius: 70,
        color: 0xf1d36b,
        started: now,
        expires: now + 650,
      });
    }
    prevLevel.set(c.id, lvl);
    const blockTick = c.graceBlockedAtTick ?? 0;
    const prevBlock = prevGraceBlockTick.get(c.id) ?? 0;
    if (blockTick > prevBlock) {
      prevGraceBlockTick.set(c.id, blockTick);
      if (snapshot.tick - blockTick <= 3 && damageNumbers.length < 20) {
        if (Math.hypot(c.x - center.x, c.y - center.y) < 560) {
          sfx.playHit({ blocked: true });
        }
        const at = rendered.get(c.id) ?? c;
        const text = new Text({
          text: "IMMUNE",
          style: new TextStyle({
            fontFamily: "Avenir Next, sans-serif",
            fontSize: 11,
            fontWeight: "700",
            fill: 0x7dffd4,
            stroke: { color: 0x000000, width: 3 },
          }),
        });
        text.anchor.set(0.5, 1);
        text.position.set(at.x, at.y - 34);
        labelLayer.addChild(text);
        damageNumbers.push({
          text,
          x: at.x,
          y: at.y - 34,
          started: now,
          expires: now + 620,
        });
        spellFlashes.push({
          x: at.x,
          y: at.y,
          radius: 34,
          color: 0x7dffd4,
          started: now,
          expires: now + 260,
        });
      }
    }
  }
  const liveBolts = new Set<string>();
  for (const bolt of snapshot.projectiles ?? []) {
    liveBolts.add(bolt.id);
    const leadSec = Math.min(0.085, Math.max(0, (now - snapshotAtMs) / 1000));
    const targetX = bolt.x + (bolt.vx ?? 0) * leadSec;
    const targetY = bolt.y + (bolt.vy ?? 0) * leadSec;
    const pos = smooth(bolt.id, targetX, targetY);
    const own = bolt.ownerId === snapshot.selfCommanderId;
    const shooter = commanderById.get(bolt.ownerId);
    const wKind: WeaponId = bolt.weapon ?? shooter?.weapon ?? "bolt";
    const ownColor =
      wKind === "wisp"
        ? 0x7dffd4
        : wKind === "storm"
          ? 0xb78bff
          : wKind === "phantom"
            ? 0xbfe9ff
            : wKind === "scythe"
              ? 0x9fe870
              : wKind === "hellscatter"
                ? 0xff8a3d
                : 0xffc46b;
    const color = own ? ownColor : 0xff6b57;
    if (!seenBoltIds.has(bolt.id)) {
      seenBoltIds.add(bolt.id);
      if (own) {
        sfx.playShoot(wKind);
        if (wKind === "lance" || wKind === "phantom" || wKind === "scythe") {
          shakePx = Math.max(shakePx, 2.2);
        }
        const selfMotion = spriteMotion.get(snapshot.selfCommanderId);
        if (selfMotion) {
          const aim = screenToWorld(mouse);
          const adx = aim.x - anchor.x;
          const ady = aim.y - anchor.y;
          const alen = Math.hypot(adx, ady) || 1;
          selfMotion.jabAt = now;
          selfMotion.jabDx = adx / alen;
          selfMotion.jabDy = ady / alen;
        }
      } else if (shooter) {
        const shooterMotion = spriteMotion.get(shooter.id);
        if (shooterMotion && bolt.vx !== undefined && bolt.vy !== undefined) {
          const vlen = Math.hypot(bolt.vx, bolt.vy) || 1;
          shooterMotion.jabAt = now;
          shooterMotion.jabDx = bolt.vx / vlen;
          shooterMotion.jabDy = bolt.vy / vlen;
        }
      }
      spellFlashes.push({
        x: pos.x,
        y: pos.y,
        radius: wKind === "scythe" ? 28 : 18,
        color,
        started: now,
        expires: now + 140,
      });
    }
    let trail = boltTrails.get(bolt.id);
    if (!trail) {
      trail = [];
      boltTrails.set(bolt.id, trail);
    }
    trail.push({ x: pos.x, y: pos.y });
    if (trail.length > 7) trail.shift();
    const trailWidth =
      wKind === "scythe" ? 5 : wKind === "lance" || wKind === "phantom" ? 3.2 : 2.4;
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1]!;
      const b = trail[i]!;
      dynamicLayer.moveTo(a.x, a.y);
      dynamicLayer.lineTo(b.x, b.y);
      dynamicLayer.stroke({
        color,
        width: trailWidth * (i / trail.length),
        alpha: (i / trail.length) * 0.48,
      });
    }
    const ang =
      bolt.vx !== undefined && bolt.vy !== undefined && (bolt.vx !== 0 || bolt.vy !== 0)
        ? Math.atan2(bolt.vy, bolt.vx)
        : trail.length >= 2
          ? Math.atan2(
              trail[trail.length - 1]!.y - trail[0]!.y,
              trail[trail.length - 1]!.x - trail[0]!.x,
            )
          : 0;
    const boltR = bolt.radius ?? 5;
    const wScale = classWeaponScale(shooter?.character, shooter?.level ?? 1);
    drawProjectileWeapon(wKind, pos, ang, color, boltR, wScale, now);
  }
  for (const id of [...rendered.keys()]) {
    if (id.startsWith("bolt-") && !liveBolts.has(id)) rendered.delete(id);
  }
  for (const id of [...boltTrails.keys()]) {
    if (!liveBolts.has(id)) {
      boltTrails.delete(id);
      seenBoltIds.delete(id);
    }
  }
  for (const entity of snapshot.entities) {
    const before = rendered.get(entity.id);
    const pos = smooth(entity.id, entity.x, entity.y);
    if (before) {
      const mdx = pos.x - before.x;
      const mdy = pos.y - before.y;
      if (mdx * mdx + mdy * mdy > 0.09) headings.set(entity.id, Math.atan2(mdy, mdx));
    }
    const isSelf = entity.id === snapshot.selfCommanderId;
    const color =
      entity.kind === "monster" ? 0xd8d2bd : ownerColor(entity.ownerId, snapshot.selfCommanderId);
    dynamicLayer
      .ellipse(pos.x, pos.y + entity.radius * 0.8, entity.radius * 0.95, entity.radius * 0.45)
      .fill({ color: 0x000000, alpha: 0.3 });
    const shelled =
      entity.kind === "commander"
        ? commanderById.get(entity.id)?.shellActive
        : entity.ownerId
          ? commanderById.get(entity.ownerId)?.shellActive
          : false;
    if (shelled) {
      dynamicLayer.circle(pos.x, pos.y, entity.radius + 7).fill({ color: 0x9fd8ff, alpha: 0.14 });
      dynamicLayer
        .circle(pos.x, pos.y, entity.radius + 7)
        .stroke({ color: 0x9fd8ff, width: 2, alpha: 0.65 });
    }
    const graceRec = entity.kind === "commander" ? commanderById.get(entity.id) : undefined;
    if (graceRec?.pvpGrace) {
      const frac = Math.max(0, Math.min(1, (graceRec.pvpGraceTicks ?? 240) / 240));
      const graceRadius = entity.radius + 11 + Math.sin(now / 180) * 1.5;
      dynamicLayer
        .circle(pos.x, pos.y, graceRadius)
        .fill({ color: 0x7dffd4, alpha: 0.07 + 0.05 * frac });
      dynamicLayer
        .circle(pos.x, pos.y, graceRadius)
        .stroke({ color: 0x7dffd4, width: 2, alpha: 0.35 + 0.45 * frac });
    }
    const heading = headings.get(entity.id) ?? -Math.PI / 2;
    const r = entity.radius;
    const ownerRec =
      entity.kind === "commander"
        ? commanderById.get(entity.id)
        : entity.ownerId
          ? commanderById.get(entity.ownerId)
          : undefined;
    if (ownerRec?.frenzyActive) {
      dynamicLayer
        .circle(pos.x, pos.y, r + 4 + Math.sin(now / 120) * 1.5)
        .stroke({ color: 0xff8a3d, width: 2, alpha: 0.7 });
    }
    if (entity.kind === "commander" && ownerRec?.weapon === "orbit") {
      const estTick = snapshot.tick + Math.min(6, Math.max(0, (now - snapshotAtMs) / 33.4));
      const charSize =
        ownerRec.character === "boneknight" ? 1.2 : ownerRec.character === "warlock" ? 1.05 : 1.0;
      const orbitDist = 72 * charSize;
      for (let i = 0; i < 2; i++) {
        const ang = estTick * 0.11 + i * Math.PI;
        for (let g = 3; g >= 1; g--) {
          const gang = ang - g * 0.14;
          dynamicLayer
            .circle(
              pos.x + Math.cos(gang) * orbitDist,
              pos.y + Math.sin(gang) * orbitDist,
              (9 - g * 1.8) * charSize,
            )
            .fill({ color: 0x7dffd4, alpha: 0.14 });
        }
        const bx = pos.x + Math.cos(ang) * orbitDist;
        const by = pos.y + Math.sin(ang) * orbitDist;
        const tangent = ang + Math.PI / 2;
        drawProjectileWeapon(
          "scythe",
          { x: bx, y: by },
          tangent,
          0x7dffd4,
          14,
          charSize * 0.72,
          now,
        );
      }
    }
    if (entity.slowed) {
      dynamicLayer.circle(pos.x, pos.y, r + 5).fill({ color: 0x9fe8ff, alpha: 0.08 });
      dynamicLayer.circle(pos.x, pos.y, r + 5).stroke({ color: 0x9fe8ff, width: 1.6, alpha: 0.7 });
    }
    if (entity.elite) {
      dynamicLayer
        .circle(pos.x, pos.y, r + 8 + Math.sin(now / 180) * 1.5)
        .stroke({ color: 0xffd27d, width: 3, alpha: 0.55 + 0.3 * Math.sin(now / 180) });
    }
    const placed = ensureSprite(
      entitySprites,
      entity.id,
      entityTexName(entity, commanderById.get(entity.id)?.character),
    );
    if (placed) {
      const spr = placed.s;
      let motion = spriteMotion.get(entity.id);
      if (!motion) {
        motion = {
          phase: Math.random() * Math.PI * 2,
          vx: 0,
          dustAt: 0,
          walkDist: 0,
          walkPhase: 0,
          facing: "front",
          fvx: 0,
          fvy: 0,
          faceHold: 0,
          flip: 1,
          jabAt: 0,
          jabDx: 1,
          jabDy: 0,
          lastNow: 0,
        };
        spriteMotion.set(entity.id, motion);
      }
      const realDt =
        motion.lastNow > 0
          ? Math.min(0.25, Math.max(0.001, (now - motion.lastNow) / 1000))
          : Math.max(dtSec, 0.001);
      motion.lastNow = now;
      let velX = before ? (pos.x - before.x) / realDt : 0;
      let velY = before ? (pos.y - before.y) / realDt : 0;
      const cmdRec = entity.kind === "commander" ? commanderById.get(entity.id) : undefined;
      if (cmdRec && (cmdRec.vx !== undefined || cmdRec.vy !== undefined)) {
        velX = cmdRec.vx ?? 0;
        velY = cmdRec.vy ?? 0;
        if (isSelf) {
          const dir = steerDirection();
          if (dir.dx !== 0 || dir.dy !== 0) {
            const sp = cmdRec.moveSpeed ?? 190;
            velX = dir.dx * sp;
            velY = dir.dy * sp;
          }
        }
      }
      const speed = Math.hypot(velX, velY);
      motion.vx += (velX - motion.vx) * 0.18;
      motion.phase += Math.min(speed, 320) * dtSec * 0.06;
      const movedDist = before ? Math.hypot(pos.x - before.x, pos.y - before.y) : 0;
      motion.walkDist += movedDist;
      const faceAlpha = 1 - Math.exp(-14 * realDt);
      motion.fvx += (velX - motion.fvx) * faceAlpha;
      motion.fvy += (velY - motion.fvy) * faceAlpha;
      const smoothSpeed = Math.hypot(motion.fvx, motion.fvy);
      if (smoothSpeed > 14 && now > motion.faceHold) {
        const desired =
          Math.abs(motion.fvy) > Math.abs(motion.fvx) * 1.2
            ? motion.fvy > 0
              ? "front"
              : "back"
            : "side";
        if (desired !== motion.facing) {
          motion.facing = desired;
          motion.faceHold = now + 100;
        }
      }
      if (motion.facing === "side" && Math.abs(motion.fvx) > 10)
        motion.flip = motion.fvx < 0 ? -1 : 1;
      if (isSelf && (mouseHeld || spaceHeld)) {
        const aim = screenToWorld(mouse);
        const adx = aim.x - pos.x;
        const ady = aim.y - pos.y;
        if (Math.hypot(adx, ady) > 12) {
          if (Math.abs(ady) > Math.abs(adx) * 1.2) {
            motion.facing = ady > 0 ? "front" : "back";
          } else {
            motion.facing = "side";
            motion.flip = adx < 0 ? -1 : 1;
          }
        }
      }
      let hostileD = 70;
      let hostileDx = 0;
      let hostileDy = 0;
      let foundHostile = false;
      if (entity.kind !== "commander") {
        for (const other of snapshot.entities) {
          if (other.id === entity.id) continue;
          const hostile =
            (entity.kind === "monster") !== (other.kind === "monster") ||
            (entity.ownerId !== undefined &&
              other.ownerId !== undefined &&
              entity.ownerId !== other.ownerId);
          if (!hostile) continue;
          const op = rendered.get(other.id) ?? other;
          const d = Math.hypot(op.x - pos.x, op.y - pos.y);
          if (d < hostileD && d > 0.5) {
            hostileD = d;
            hostileDx = (op.x - pos.x) / d;
            hostileDy = (op.y - pos.y) / d;
            foundHostile = true;
          }
        }
        if (foundHostile && speed <= 14) {
          if (Math.abs(hostileDy) > Math.abs(hostileDx) * 1.2) {
            motion.facing = hostileDy > 0 ? "front" : "back";
          } else {
            motion.facing = "side";
            if (Math.abs(hostileDx) > 0.2) motion.flip = hostileDx < 0 ? -1 : 1;
          }
        }
      }
      const baseTex = entityTexName(entity, commanderById.get(entity.id)?.character);
      const dirEntry = textures.get(`${baseTex}-${motion.facing}`) ?? textures.get(baseTex);
      const frames = dirEntry?.frames;
      let frameScale = placed.scale;
      if (dirEntry) {
        frameScale = dirEntry.drawHeight / (frames?.[0]?.height ?? dirEntry.texture.height);
        const stride = Math.max(14, dirEntry.drawHeight * 0.4);
        if (speed > 14) motion.walkPhase += movedDist / stride;
        else
          motion.walkPhase +=
            (Math.round(motion.walkPhase) - motion.walkPhase) * (1 - Math.exp(-12 * dtSec));
        if (frames && frames.length > 0) {
          const idx = Math.floor(motion.walkPhase) % frames.length;
          spr.texture = frames[idx]!;
        } else {
          spr.texture = dirEntry.texture;
        }
      }
      const bob =
        speed > 14
          ? -Math.abs(Math.sin(motion.phase)) * (frames ? 2.1 : 3.2 + Math.min(speed / 55, 4))
          : Math.sin(now / 850 + motion.phase) * 1.1;
      let jabX = 0;
      let jabY = 0;
      if (foundHostile && hostileD < 44 && speed <= 80 && now - motion.jabAt > 600) {
        motion.jabAt = now;
        motion.jabDx = hostileDx;
        motion.jabDy = hostileDy;
      }
      const jabP = (now - motion.jabAt) / 140;
      if (jabP >= 0 && jabP < 1) {
        const jabAmt = Math.sin(jabP * Math.PI) * 5;
        jabX = motion.jabDx * jabAmt;
        jabY = motion.jabDy * jabAmt;
      }
      let riseSink = 0;
      let riseAlpha = 1;
      if (entity.kind === "monster") {
        let first = firstSeenAt.get(entity.id);
        if (first === undefined) {
          first = joining ? now - 1000 : now;
          firstSeenAt.set(entity.id, first);
          if (!joining) burst(pos.x, pos.y + r * 0.8, 0x8a7a5a, 5, 60, 420, 2);
        }
        const riseT = Math.min(1, (now - first) / 500);
        riseSink = (1 - riseT) * 16;
        riseAlpha = riseT;
      }
      spr.position.set(pos.x + jabX, pos.y + r * 0.85 + bob + riseSink + jabY);
      spr.alpha = riseAlpha;
      spr.rotation = Math.max(-0.11, Math.min(0.11, motion.vx * 0.00055));
      spr.zIndex = Math.round(pos.y) + (entity.kind === "commander" ? 500 : 0);
      const eliteMul = entity.elite ? 1.3 : 1;
      spr.scale.set(
        frameScale * eliteMul * (motion.facing === "side" ? motion.flip : 1),
        frameScale * eliteMul,
      );
      spr.tint = entity.slowed
        ? 0x9fd8ff
        : entity.elite || entity.tag === "mercenary"
          ? 0xffd27d
          : entity.kind === "unit"
            ? entity.ownerId === snapshot.selfCommanderId
              ? 0xffebbd
              : 0xcfe6ff
            : 0xffffff;
      spr.visible = true;
      if (
        speed > 95 &&
        now - motion.dustAt > 150 &&
        Math.hypot(pos.x - center.x, pos.y - center.y) < 900
      ) {
        motion.dustAt = now;
        burst(pos.x, pos.y + r * 0.8, 0x8a7a5a, 1, 24, 360, 1.5);
      }
      if (entity.kind === "unit") {
        dynamicLayer
          .ellipse(pos.x, pos.y + r * 0.85, r * 0.9, r * 0.36)
          .stroke({ color, width: 1.5, alpha: 0.45 });
      }
      if (entity.kind === "commander") {
        if (cmdRec?.carryingItemId) {
          dynamicLayer
            .circle(pos.x, pos.y, r + 10 + Math.sin(now / 200) * 2)
            .stroke({ color: 0xf1d36b, width: 2.4, alpha: 0.85 });
        }
        const aim = screenToWorld(mouse);
        const weapAng = isSelf
          ? Math.atan2(aim.y - pos.y, aim.x - pos.x)
          : jabP >= 0 && jabP < 1
            ? Math.atan2(motion.jabDy, motion.jabDx)
            : heading;
        drawHeldWeapon(
          { x: pos.x + jabX, y: pos.y + bob + jabY },
          r,
          cmdRec?.character,
          cmdRec?.weapon ?? "bolt",
          cmdRec?.level ?? 1,
          weapAng,
          jabP,
          now,
        );
        if (isSelf) {
          dynamicLayer
            .ellipse(pos.x, pos.y + r * 0.8, r * 1.45, r * 0.62)
            .fill({ color: 0xe8c15a, alpha: 0.16 })
            .stroke({ color: 0xfff3c4, width: 2.2, alpha: 0.85 });
          const tipD = r + 15;
          const baseD = r + 7;
          dynamicLayer
            .poly([
              pos.x + Math.cos(weapAng) * tipD,
              pos.y + Math.sin(weapAng) * tipD,
              pos.x + Math.cos(weapAng + 0.42) * baseD,
              pos.y + Math.sin(weapAng + 0.42) * baseD,
              pos.x + Math.cos(weapAng - 0.42) * baseD,
              pos.y + Math.sin(weapAng - 0.42) * baseD,
            ])
            .fill({ color: 0xfff3c4, alpha: 0.9 });
        } else {
          dynamicLayer.circle(pos.x, pos.y, r + 5).stroke({ color, width: 2, alpha: 0.75 });
        }
      }
    } else if (entity.kind === "commander") {
      const carrying = commanderById.get(entity.id)?.carryingItemId;
      if (carrying) {
        dynamicLayer
          .circle(pos.x, pos.y, r + 10 + Math.sin(now / 200) * 2)
          .stroke({ color: 0xf1d36b, width: 2.4, alpha: 0.85 });
      }
      dynamicLayer
        .circle(pos.x, pos.y, r + 5)
        .stroke({ color: isSelf ? 0xffffff : color, width: isSelf ? 3 : 2 });
      dynamicLayer
        .poly([
          pos.x,
          pos.y - r - 2,
          pos.x + r + 2,
          pos.y,
          pos.x,
          pos.y + r + 2,
          pos.x - r - 2,
          pos.y,
        ])
        .fill(color)
        .stroke({ color: 0x0d0a08, width: 1.6 });
      dynamicLayer
        .poly([pos.x, pos.y - r - 2, pos.x + r * 0.5, pos.y - r * 0.4, pos.x, pos.y])
        .fill({ color: 0xffffff, alpha: 0.28 });
      dynamicLayer.circle(pos.x, pos.y, 4).fill(0x141414);
      const hx = Math.cos(heading);
      const hy = Math.sin(heading);
      dynamicLayer
        .poly([
          pos.x + hx * (r + 11),
          pos.y + hy * (r + 11),
          pos.x + Math.cos(heading + 2.6) * 6,
          pos.y + Math.sin(heading + 2.6) * 6,
          pos.x + Math.cos(heading - 2.6) * 6,
          pos.y + Math.sin(heading - 2.6) * 6,
        ])
        .fill(isSelf ? 0xffffff : color);
    } else if (entity.kind === "unit") {
      const tipX = pos.x + Math.cos(heading) * r * 1.55;
      const tipY = pos.y + Math.sin(heading) * r * 1.55;
      const blX = pos.x + Math.cos(heading + 2.45) * r * 1.05;
      const blY = pos.y + Math.sin(heading + 2.45) * r * 1.05;
      const brX = pos.x + Math.cos(heading - 2.45) * r * 1.05;
      const brY = pos.y + Math.sin(heading - 2.45) * r * 1.05;
      const notchX = pos.x - Math.cos(heading) * r * 0.35;
      const notchY = pos.y - Math.sin(heading) * r * 0.35;
      dynamicLayer
        .poly([tipX, tipY, blX, blY, notchX, notchY, brX, brY])
        .fill(color)
        .stroke({ color: 0x000000, width: 1, alpha: 0.5 });
      dynamicLayer.circle(pos.x, pos.y, r * 0.3).fill({ color: 0xffffff, alpha: 0.3 });
    } else if (entity.tag === "bone-choir") {
      dynamicLayer
        .circle(pos.x, pos.y, r + 12 + Math.sin(now / 260) * 3)
        .stroke({ color: 0xd84b3d, width: 2.4, alpha: 0.55 });
      dynamicLayer.star(pos.x, pos.y, 8, r + 8, r * 0.55).fill(0xa83226);
      dynamicLayer.circle(pos.x, pos.y, r * 0.62).fill(0xd8d2bd);
      dynamicLayer.circle(pos.x - r * 0.22, pos.y - r * 0.08, r * 0.13).fill(0xd84b3d);
      dynamicLayer.circle(pos.x + r * 0.22, pos.y - r * 0.08, r * 0.13).fill(0xd84b3d);
      dynamicLayer.circle(pos.x, pos.y, r * 0.62).stroke({ color: 0xf1d36b, width: 2, alpha: 0.8 });
    } else {
      if (entity.tag === "bone-warden") {
        dynamicLayer
          .poly([
            pos.x - r * 0.95,
            pos.y - r * 0.55,
            pos.x - r * 0.35,
            pos.y - r * 0.75,
            pos.x - r * 0.55,
            pos.y - r * 1.25,
          ])
          .fill(0x8a2f24);
        dynamicLayer
          .poly([
            pos.x + r * 0.95,
            pos.y - r * 0.55,
            pos.x + r * 0.35,
            pos.y - r * 0.75,
            pos.x + r * 0.55,
            pos.y - r * 1.25,
          ])
          .fill(0x8a2f24);
      }
      dynamicLayer.circle(pos.x, pos.y, r).fill(color);
      dynamicLayer.rect(pos.x - r * 0.55, pos.y + r * 0.3, r * 1.1, r * 0.62).fill(color);
      const eye = entity.tag === "bone-warden" ? 0xd84b3d : 0x141414;
      dynamicLayer.circle(pos.x - r * 0.35, pos.y - r * 0.12, r * 0.17).fill(eye);
      dynamicLayer.circle(pos.x + r * 0.35, pos.y - r * 0.12, r * 0.17).fill(eye);
      dynamicLayer
        .poly([
          pos.x,
          pos.y + r * 0.02,
          pos.x + r * 0.13,
          pos.y + r * 0.3,
          pos.x - r * 0.13,
          pos.y + r * 0.3,
        ])
        .fill(0x141414);
      for (const tx of [-0.3, 0, 0.3]) {
        dynamicLayer
          .rect(pos.x + r * tx - 0.8, pos.y + r * 0.42, 1.6, r * 0.4)
          .fill({ color: 0x141414, alpha: 0.75 });
      }
      if (entity.tag === "bone-warden") {
        dynamicLayer.circle(pos.x, pos.y, r).stroke({ color: 0x8a2f24, width: 3 });
      }
    }
    if (entity.hp < entity.maxHp) {
      const w = Math.max(22, entity.radius * 2);
      const barY = placed && entity.kind === "commander" ? pos.y - 62 : pos.y - entity.radius - 10;
      dynamicLayer.rect(pos.x - w / 2, barY, w, 4).fill(0x34201e);
      dynamicLayer.rect(pos.x - w / 2, barY, w * (entity.hp / entity.maxHp), 4).fill(0xd84b3d);
    }
  }
  for (const [id, placed] of entitySprites) {
    if (!liveIds.has(id)) {
      spriteLayer.removeChild(placed.s);
      placed.s.destroy({ texture: false });
      entitySprites.delete(id);
    }
  }
  {
    const glowTex = ensureGlowTexture();
    const liveGlow = new Set<string>();
    const addGlow = (
      id: string,
      gx: number,
      gy: number,
      size: number,
      tint: number,
      alpha: number,
    ) => {
      liveGlow.add(id);
      let g = glowSprites.get(id);
      if (!g) {
        g = new Sprite(glowTex);
        g.anchor.set(0.5);
        g.blendMode = "add";
        glowLayer.addChild(g);
        glowSprites.set(id, g);
      }
      g.position.set(gx, gy);
      g.width = size;
      g.height = size;
      g.tint = tint;
      g.alpha = alpha;
      g.visible = true;
    };
    for (const c of snapshot.commanders) {
      if (!c.alive) continue;
      const p = rendered.get(c.id) ?? c;
      const isSelfGlow = c.id === snapshot.selfCommanderId;
      addGlow(
        c.id,
        p.x,
        p.y,
        isSelfGlow ? 340 : 230,
        isSelfGlow ? 0xffc98a : 0x6f87b8,
        isSelfGlow ? 0.42 : 0.2,
      );
    }
    for (const e of snapshot.entities) {
      if (e.tag === "bone-choir") {
        const p = rendered.get(e.id) ?? e;
        addGlow(e.id, p.x, p.y, 280, 0xff5a4e, 0.22);
      } else if (e.elite) {
        const p = rendered.get(e.id) ?? e;
        addGlow(e.id, p.x, p.y, 170, 0xff5a4e, 0.18);
      }
    }
    for (const [id, g] of glowSprites) {
      if (!liveGlow.has(id)) {
        glowLayer.removeChild(g);
        g.destroy({ texture: false });
        glowSprites.delete(id);
      }
    }
  }
  const liveCommanderIds = new Set(snapshot.commanders.filter((c) => c.alive).map((c) => c.id));
  for (const commander of snapshot.commanders) {
    if (!commander.alive) continue;
    let pill = commanderLabels.get(commander.id);
    if (!pill) {
      const isSelfPill = commander.id === snapshot.selfCommanderId;
      const factionShort =
        commander.faction === "reapers" ? "⚔️" : commander.faction === "wardens" ? "🛡" : "";
      const roleText = isSelfPill
        ? "YOU"
        : commander.kind === "agent"
          ? "AI"
          : commander.kind === "bot"
            ? "BOT"
            : "PLAYER";
      const badgeText = factionShort ? `${factionShort} ${roleText}` : roleText;
      const badgeColor =
        commander.faction === "reapers"
          ? 0xff7a6b
          : commander.faction === "wardens"
            ? 0x7fd8ff
            : isSelfPill
              ? 0xf3deb1
              : 0x7ea6c9;
      const badge = new Text({
        text: badgeText,
        style: new TextStyle({
          fontFamily: "Avenir Next, sans-serif",
          fontSize: 10,
          fontWeight: "800",
          fill: badgeColor,
        }),
      });
      const name = new Text({
        text: commander.name,
        style: new TextStyle({
          fontFamily: "Avenir Next, sans-serif",
          fontSize: 13,
          fontWeight: "700",
          fill: isSelfPill ? 0xffffff : 0xe8dfc4,
        }),
      });
      badge.position.set(7, 3.5);
      name.position.set(7 + badge.width + 6, 2);
      const width = 7 + badge.width + 6 + name.width + 7;
      const bg = new Graphics();
      bg.roundRect(0, 0, width, 20, 6)
        .fill({ color: 0x0d0a08, alpha: 0.85 })
        .stroke({
          color: ownerColor(commander.id, snapshot.selfCommanderId),
          width: 1.4,
          alpha: 0.9,
        });
      const box = new Container();
      box.addChild(bg, badge, name);
      pill = { box, width };
      commanderLabels.set(commander.id, pill);
      labelLayer.addChild(box);
    }
    const pos = rendered.get(commander.id) ?? commander;
    pill.box.position.set(pos.x - pill.width / 2, pos.y - 84);
    pill.box.visible = true;
  }
  for (const [id, pill] of commanderLabels) {
    if (!liveCommanderIds.has(id)) pill.box.visible = false;
  }
  for (let i = damageNumbers.length - 1; i >= 0; i--) {
    const dmg = damageNumbers[i]!;
    if (dmg.expires <= now) {
      labelLayer.removeChild(dmg.text);
      dmg.text.destroy();
      damageNumbers.splice(i, 1);
      continue;
    }
    const t = (now - dmg.started) / (dmg.expires - dmg.started);
    dmg.text.position.set(dmg.x, dmg.y - t * 30);
    dmg.text.alpha = 1 - t;
  }
  for (let i = hitFlashes.length - 1; i >= 0; i--) {
    const flash = hitFlashes[i]!;
    if (flash.expires <= now) {
      hitFlashes.splice(i, 1);
      continue;
    }
    const t = (now - flash.started) / (flash.expires - flash.started);
    if (flash.death) {
      dynamicLayer
        .circle(flash.x, flash.y, 8 + t * 30)
        .fill({ color: 0xff6b57, alpha: 0.35 * (1 - t) });
      dynamicLayer
        .circle(flash.x, flash.y, 8 + t * 38)
        .stroke({ color: 0xff6b57, width: 3, alpha: 0.8 * (1 - t) });
    } else {
      dynamicLayer
        .circle(flash.x, flash.y, 10 + t * 16)
        .stroke({ color: 0xffffff, width: 3, alpha: 0.85 * (1 - t) });
    }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!;
    if (p.expires <= now) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dtSec;
    p.y += p.vy * dtSec;
    p.vy += 140 * dtSec;
    const t = (now - p.started) / (p.expires - p.started);
    dynamicLayer
      .circle(p.x, p.y, Math.max(0.4, p.size * (1 - t * 0.5)))
      .fill({ color: p.color, alpha: 0.9 * (1 - t) });
  }
  screenLayer.clear();
  const hpFrac = self.maxHp > 0 ? self.hp / self.maxHp : 1;
  const hurtAlpha =
    now < hurtUntil ? 0.3 : self.alive && hpFrac < 0.35 ? 0.15 + Math.sin(now / 180) * 0.06 : 0;
  if (hurtAlpha > 0) {
    const b = 42;
    const fill = { color: 0xd84b3d, alpha: hurtAlpha };
    screenLayer.rect(0, 0, innerWidth, b).fill(fill);
    screenLayer.rect(0, innerHeight - b, innerWidth, b).fill(fill);
    screenLayer.rect(0, 0, b, innerHeight).fill(fill);
    screenLayer.rect(innerWidth - b, 0, b, innerHeight).fill(fill);
  }
  type Objective = { key: string; label: string; x: number; y: number; color: number };
  const objectives: Objective[] = [
    {
      key: "extract",
      label: "EXTRACT",
      ...roomCenter("extraction", { x: 50 * tileSize, y: 20 * tileSize }),
      color: 0x62d2a2,
    },
    {
      key: "shrine",
      label: "SHRINE",
      ...roomCenter("shrine", { x: 48 * tileSize, y: 8 * tileSize }),
      color: 0xe8c15a,
    },
  ];
  const tracked = snapshot.contracts.find(
    (c) =>
      (c.status === "open" || c.status === "accepted") &&
      c.participants.includes(self.id) &&
      c.issuerId !== self.id,
  );
  if (tracked) {
    let target: Vec2 | undefined;
    const p = tracked.predicate;
    if (p.kind === "kill_entity") {
      const e =
        snapshot.entities.find((en) => en.id === p.entityId) ??
        snapshot.entities.find((en) => en.tag === "bone-choir");
      target = e
        ? { x: e.x, y: e.y }
        : roomCenter("bone-choir", { x: 48 * tileSize, y: 32 * tileSize });
    } else if (p.kind === "kill_count") {
      let bestD = Infinity;
      for (const e of snapshot.entities) {
        if (e.tag !== p.targetTag) continue;
        const d = (e.x - center.x) ** 2 + (e.y - center.y) ** 2;
        if (d < bestD) {
          bestD = d;
          target = { x: e.x, y: e.y };
        }
      }
    } else if (p.kind === "deliver_item") {
      if (self.carryingItemId) {
        target = roomCenter(p.destination, { x: 48 * tileSize, y: 8 * tileSize });
      } else {
        const pk = snapshot.pickups.find((pk2) => pk2.templateId === p.itemTemplateId);
        const carrier = snapshot.commanders.find((c) => c.carryingItemId);
        target = pk ? { x: pk.x, y: pk.y } : carrier ? { x: carrier.x, y: carrier.y } : undefined;
      }
    }
    if (target) objectives.push({ key: "bounty", label: "BOUNTY", ...target, color: 0xe86a5a });
  }
  {
    const inSanctuary = selfInEntry();
    let compassTarget: Vec2 | undefined;
    let compassColor = 0xf1d36b;
    let bannerText =
      "Sortie from the Sanctuary · cull skeletons · raise with essence · extract east to bank it";
    if (inSanctuary) {
      compassTarget = { x: 400, y: 640 };
      compassColor = 0xf1d36b;
      bannerText =
        "Sanctuary safe zone · Walk EAST through the doorway (WASD) to begin your sortie";
    } else if (self.carryingItemId) {
      compassTarget = roomCenter("shrine", { x: 48 * tileSize, y: 8 * tileSize });
      compassColor = 0xe8c15a;
      bannerText = "Carrying the Moon Relic! Deliver it to the North Shrine or East Extraction";
    } else if (self.essence >= 15) {
      compassTarget = roomCenter("extraction", { x: 50 * tileSize, y: 20 * tileSize });
      compassColor = 0x62d2a2;
      bannerText = `Carrying ${self.essence} Essence — head East to Extraction and press X to bank Sparks!`;
    } else {
      const bountyObj = objectives.find((o) => o.key === "bounty");
      if (bountyObj) {
        compassTarget = { x: bountyObj.x, y: bountyObj.y };
        compassColor = 0xe86a5a;
      } else {
        let bestSkelD = Infinity;
        for (const e of snapshot.entities) {
          if (e.kind !== "monster") continue;
          const d = (e.x - anchor.x) ** 2 + (e.y - anchor.y) ** 2;
          if (d < bestSkelD) {
            bestSkelD = d;
            compassTarget = { x: e.x, y: e.y };
          }
        }
      }
    }
    if (!inSanctuary && snapshot.wave) {
      const nextSec = Math.max(0, Math.ceil((snapshot.wave.nextAtTick - snapshot.tick) / 30));
      if (snapshot.wave.activeHunters > 0 && snapshot.wave.targetCommanderId === self.id) {
        bannerText += ` · WAVE ${snapshot.wave.number}: ${snapshot.wave.title} (${snapshot.wave.activeHunters} hunting you!)`;
      } else if (snapshot.wave.activeHunters > 0) {
        bannerText += ` · Wave ${snapshot.wave.number} active (${snapshot.wave.activeHunters} hunters)`;
      } else {
        bannerText += ` · Next catacomb surge in ${nextSec}s`;
      }
    }
    if (fields.objectiveBanner.textContent !== bannerText) {
      fields.objectiveBanner.textContent = bannerText;
    }
    if (self.alive && compassTarget) {
      const cdx = compassTarget.x - anchor.x;
      const cdy = compassTarget.y - anchor.y;
      const cdist = Math.hypot(cdx, cdy);
      if (cdist > 110) {
        const cang = Math.atan2(cdy, cdx);
        const orbitR = 76 + Math.sin(now / 220) * 4;
        const tipX = anchor.x + Math.cos(cang) * (orbitR + 12);
        const tipY = anchor.y + Math.sin(cang) * (orbitR + 12);
        const leftX = anchor.x + Math.cos(cang + 0.22) * orbitR;
        const leftY = anchor.y + Math.sin(cang + 0.22) * orbitR;
        const rightX = anchor.x + Math.cos(cang - 0.22) * orbitR;
        const rightY = anchor.y + Math.sin(cang - 0.22) * orbitR;
        dynamicLayer
          .poly([tipX, tipY, leftX, leftY, rightX, rightY])
          .fill({ color: compassColor, alpha: 0.78 })
          .stroke({ color: 0x0d0a08, width: 1.5, alpha: 0.85 });
      }
    }
  }
  const enemies = snapshot.commanders
    .filter((c) => c.alive && c.id !== self.id)
    .map((c) => ({ c, d: (c.x - center.x) ** 2 + (c.y - center.y) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  for (const { c } of enemies) {
    const pos = rendered.get(c.id) ?? c;
    objectives.push({
      key: `enemy:${c.id}`,
      label: c.name,
      x: pos.x,
      y: pos.y,
      color: ownerColor(c.id, self.id),
    });
  }
  const seenObjectiveKeys = new Set(objectives.map((o) => o.key));
  for (const [k, l] of objectiveLabels) {
    if (!seenObjectiveKeys.has(k)) l.visible = false;
  }
  for (const objective of objectives) {
    let label = objectiveLabels.get(objective.key);
    if (!label) {
      label = new Text({
        text: objective.label,
        style: new TextStyle({
          fontFamily: "Avenir Next, sans-serif",
          fontSize: 11,
          fontWeight: "700",
          fill: objective.color,
          stroke: { color: 0x000000, width: 3 },
        }),
      });
      label.anchor.set(0.5, 0);
      objectiveLabels.set(objective.key, label);
      screenLabels.addChild(label);
    }
    const sx = vc.x + (objective.x - center.x) * scale;
    const sy = vc.y + (objective.y - center.y) * scale;
    const margin = 58;
    const playWidth = playWidthPx();
    const onScreen =
      sx > margin && sx < playWidth - margin && sy > margin && sy < innerHeight - margin;
    label.visible = !onScreen;
    if (onScreen) continue;
    const cx = Math.min(Math.max(sx, margin), playWidth - margin);
    const cy = Math.min(Math.max(sy, margin), innerHeight - margin);
    const ang = Math.atan2(sy - vc.y, sx - vc.x);
    const tip = { x: cx + Math.cos(ang) * 15, y: cy + Math.sin(ang) * 15 };
    const left = { x: cx + Math.cos(ang + 2.55) * 10, y: cy + Math.sin(ang + 2.55) * 10 };
    const right = { x: cx + Math.cos(ang - 2.55) * 10, y: cy + Math.sin(ang - 2.55) * 10 };
    screenLayer.poly([tip.x, tip.y, left.x, left.y, right.x, right.y]).fill(objective.color);
    label.position.set(cx, cy + 14);
  }
  drawMinimap(center, scale);
}

app.ticker.add((_ticker) => {
  try {
    draw();
  } catch (error) {
    fields.status.textContent = error instanceof Error ? error.message : String(error);
  }
});
