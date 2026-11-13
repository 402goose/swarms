# PRD: SWARMS

Status: v0.8.2 — CP7 checkpoint plus two playability hotfixes. v0.8.1: expired drafts can no longer auto-equip a weapon (passive Soul Orbit made clicking appear dead), orbit fire gives explicit feedback, draft card shrunk/bottom-anchored, vignette/floor/glow readability pass. v0.8.2 (from a played session): corridors widened 2→3 tiles and spawn rows aligned to the Sanctuary exit so holding east actually exits; PvP grace now holds while inside Sanctuary and counts down only after exit; bounty board collapsed by default. 85/85 tests; played-session probe verified fast exit + own projectiles fired (see Build status)
Owner: Alec
Date: 2026-11-05

## Decisions locked

1. **Build order:** PRD and persistent multiplayer backend first. The browser client starts as the thinnest test/operator surface needed to exercise the backend; the full playable slice follows on that foundation.
2. **Combat:** real-time swarm arena.
3. **Money:** simulated Sparks/test credits only in v1. Visa CLI/MPP and Taskmarket are context and future adapters, not the v1 settlement loop.

Visa-specific source truth lives in [docs/VISA_CLI_CONTEXT.md](docs/VISA_CLI_CONTEXT.md). Every builder/agent must read it before touching bounties, payments, identity, signing, or an external Taskmarket bridge.

## One line

**Halls of Torment/Crimsonland-speed swarm combat, in an always-on dungeon where humans command autonomous agent teams and every alliance, rescue, betrayal, and kill can be posted as a paid task bounty.**

SWARMS is a browser-first, real-time, top-down multiplayer dungeon crawler. A player is not one hero. A player is a commander: a fragile avatar, a living swarm, a spell hand, an agent policy, and a wallet. Other human- and agent-run swarms compete for loot, extracts, territory, and contracts in the same persistent dungeon.

## The reference the user remembered

Best-supported match: **Halls of Torment**.

- Asmongold's July 2023 streams/videos drove a documented Steam player spike, reported by [Gamepressure](https://www.gamepressure.com/newsroom/halls-of-torment-gained-popularity-on-steam-thanks-to-a-streamer/zd5ac4), [Dexerto](https://www.dexerto.com/gaming/asmongold-spotlights-a-small-indie-game-and-makes-it-an-overnight-hit-2204457/), and [Indie Game Culture](https://indiegameculture.com/news/streamer-asmongold-halls-of-torment/).
- It is a dark, Diablo-feeling **Vampire Survivors-like** bullet-heaven: move constantly, weapons/spells fire into huge crowds, pickups snowball power.
- **Crimsonland** is the older root in the clue: the original shipped in 2003 and its Steam remake positions it as a forerunner from Alien Shooter to Vampire Survivors ([Steam](https://store.steampowered.com/app/262830/Crimsonland/)).

Working read: "vampire or something" + "more like Crimson back in the day" is one memory blended from Halls of Torment, Vampire Survivors, and Crimsonland. Our target feel is that lineage, made multiplayer, persistent, and agent-native.

## Fantasy

You enter the dungeon with a swarm that has a name, a style, and a balance. You paint targets, trigger formation changes, and spend Command on huge spells while your units keep fighting under a policy you chose.

Mid-fight, another team posts: **“300 Sparks: kill the Bone Choir before it reaches the gate.”** Your agent takes it. A rival posts a counter-bounty on your commander. A third swarm accepts both, saves you, collects, then turns on you at the extraction portal.

The dungeon pays for violence, rescue, information, and betrayal. The task board is not a side UI. It is the social engine.

## Design pillars

1. **Fast hands, autonomous feet.** The human makes frequent, legible decisions: move vector, focus target, formation, spell, retreat, bounty. Units handle pathing, target selection, and moment-to-moment attacks.
2. **Agents are first-class players.** External agents use a typed game API, not screenshots or DOM scraping. Humans, scripts, and LLM agents obey the same visibility, cooldown, and command-budget rules.
3. **Every request can become a contract.** Help, information, protection, assassination, theft, and boss damage are all the same underlying bounty primitive.
4. **Money creates stories, not just stats.** Kills transfer stakes. Bounties create temporary alliances and reasons to betray them. Power-ups are rented, dropped, looted, or earned through contracts.
5. **Always-on, bounded zones.** The world persists, but combat runs in authoritative zones with known entity budgets. Dormant zones advance timers without simulating every unit forever.
6. **Spectacle with readable causality.** Huge crowds and spell effects, but every death, payout, and contract progress update has a visible cause.

## Core loop

1. Spawn in a safe hub/antechamber with a commander and base swarm.
2. Pick a depth/zone risk band and enter the dungeon.
3. Fight monster swarms and rival teams. Collect Essence, gear shards, temporary power-ups, and Sparks.
4. Spend Command on spells and formation orders. Units auto-attack under the selected policy.
5. Post or accept bounties as the situation changes.
6. Push deeper for better loot and bigger system bounties, or extract to bank progress.
7. If the commander dies, lose unbanked loot/stake according to zone rules; the killer and contract holders get paid from defined stakes/escrows.
8. Spend banked Sparks on new units, temporary power-ups, agent wages, information, and future bounties.

## Controls

- Mouse / WASD: commander movement and swarm anchor.
- Left click or Space: focus-fire / attack-move target.
- Right click: move/defend point.
- Q/W/E/R: commander spells and swarm orders.
- Shift: hold formation / defensive shell.
- F: interact, loot, accept highlighted contract.
- B: bounty board.
- 1–4: quick bounty templates (Help me, Kill target, Escort me, Guard here).

Command is an Elixir-like regenerating meter. Cheap orders are frequent. Screen-clearing spells are expensive and telegraphed.

## Agents

An agent controller receives the same observation a fair headless player should receive:

- Tick, zone, visible entities, own units, health/cooldowns/resources.
- Recent authoritative events with a resumable cursor.
- Eligible bounties and contract progress.
- Command limits for the current tick/window.

It returns bounded commands only: move, attack-move, defend, retreat, cast, loot, accept bounty, post bounty, extract. The server validates ownership, visibility, range, resources, cooldowns, sequence, expiry, and spending ceilings.

LLMs should issue strategy at 1–5 Hz. A deterministic local controller executes fast unit behavior between strategy updates. ORC workers can author/evaluate strategies and play test matches through the SDK, but Fusion delegation is too slow and too privileged to be the per-tick game loop.

## The underlying primitive: Contract

Everything social/economic is a **Contract**. Quests, bounties, wages, wagers, rescue calls, boss commissions, and dungeon-generated events use one object and one settlement path.

```ts
type Contract = {
  id: string;
  schema: "swarms.contract.v1";
  issuerId: string;              // human, agent, team, or "dungeon"
  zoneId: string;
  title: string;                 // display only; never verification input
  predicate: Predicate;          // closed, server-verifiable vocabulary
  eligibility: Eligibility;      // teams, power band, reputation, zone, exclusions
  reward: { asset: "SPARK"; amount: number };
  escrowId: string;
  attribution: "final_blow" | "damage_share" | "party" | "first_verified";
  splitRule: SplitRule;
  opensAtTick: number;
  expiresAtTick: number;
  maxClaimants: number;
  status: ContractStatus;
  evidenceCursor?: string;
};
```

Lifecycle:

```text
DRAFT -> FUNDED/OPEN -> ACCEPTED -> SATISFIED -> SETTLED
              |            |             |
              |            +-> EXPIRED -> REFUNDED
              +-> CANCELLED -> REFUNDED
                         SATISFIED -> DISPUTED -> SETTLED | REFUNDED
```

Rules:

- Creation atomically escrows the full reward.
- Predicate, attribution, eligibility, split, and expiry freeze at funding time.
- Only authoritative game events satisfy predicates. Chat, screenshots, client claims, and prose descriptions are not evidence.
- Settlement is idempotent by contract ID + satisfying event IDs. Retries never double-pay.
- Issuer, claimant, alts, teammates, and recent counterparties are checked against anti-farm rules.
- Contracts emit replayable events: `ContractOpened`, `ContractAccepted`, `ContractProgressed`, `ContractSatisfied`, `ContractSettled`, `ContractExpired`, `ContractRefunded`.

Initial predicate vocabulary:

- `kill_count { targetTag, count, zoneId }`
- `kill_entity { entityId | commanderId, assistWindowTicks }`
- `damage_boss { bossId, minDamageShare }`
- `escort_alive { subjectId, destinationZoneId, deadlineTick }`
- `guard_zone { zoneId, holdTicks, maxBreaches }`
- `deliver_item { itemTemplateId, destinationId }`
- `extract_with_item { itemId }`
- `revive_commander { commanderId, withinTicks }`
- `scout_reveal { roomIds, minRooms }`
- `capture_objective { objectiveId, holdTicks }`

Starter task templates:

1. **Save my swarm** — keep issuer alive for 60 seconds.
2. **Hit contract** — kill a named commander in a red zone.
3. **Bodyguard** — escort issuer to extraction.
4. **Boss break** — contribute top-two damage share to a boss phase.
5. **Room clear** — clear a marked room before expiry.
6. **Relic run** — deliver a dropped relic to the issuer or shrine.
7. **Corpse recovery** — recover a commander's dropped core.
8. **Scout contract** — reveal three unexplored rooms.
9. **Gate hold** — prevent enemies crossing a chokepoint.
10. **Distraction** — draw elite aggro for 20 seconds.
11. **Medic** — heal/revive threshold damage on allied units.
12. **Counter-bounty** — kill the current holder of a bounty on the issuer.

## Economy

V1 uses **Sparks**: non-redeemable test credits. No real-money kills, wagers, cash-out, trading, or promised returns until the game/economy has been simulated and legally/operationally reviewed.

- Faucets: dungeon system contracts, monster Essence conversion at extraction, first-clear bonuses, daily commander stipend.
- Transfers: bounty rewards, kill stakes, loot buyouts, agent wages.
- Sinks: entry stakes burned in part, power-up rental, contract posting fee, revive cost, repair/respawn, information purchases, cosmetics later.
- Kill money should mostly be a transfer from victim stake/escrow/dropped loot, not an infinite faucet.
- Repeated kills of the same commander/team decay quickly. New/weak accounts sit in protected power bands.
- Power-ups are temporary, visible, and counterable. Paid power does not permanently raise competitive stats in ranked zones.
- Every agent gets a spending ceiling, contract limit, and action budget per account/team, not per connection.

Later, an external adapter can map selected non-real-time work to Visa CLI/Taskmarket/MPP. Visa's checked model is: marketplace as data descriptor, shared task recipes over surface-specific ports, screened closed-word task answers, owner-bound signatures/payments, stable idempotency keys, and on-chain `TaskCompleted` payout evidence. SWARMS copies the descriptor/ports/idempotency pattern internally. It does not put Visa owner asks, Taskmarket recording lag, or real-money settlement inside combat ticks. Visa/MPP would move external money only; the game server remains the only authority on whether an in-world kill or predicate happened. Full mapping and guardrails: [docs/VISA_CLI_CONTEXT.md](docs/VISA_CLI_CONTEXT.md).

## Reference set

- **Halls of Torment** — primary feel target: old-Diablo presentation, bullet-heaven crowds, build snowballing. Mostly a combat/feel reference, not our persistence model. ([Steam](https://store.steampowered.com/app/2218750))
- **Crimsonland** — arena-swarm root: compact space, overwhelming hordes, perk spikes, immediate readability. ([Steam](https://store.steampowered.com/app/262830/Crimsonland/))
- **Vampire Survivors** — pickup magnets, level-up choices, weapon evolution, screen-filling payoff; online co-op/spectator lessons now exist. ([PCGamesN](https://www.pcgamesn.com/vampire-survivors/online-mode-public-beta))
- **Realm of the Mad God** — browser-born co-op bullet-hell MMO, public dungeon chaos, permadeath tension. ([Steam](https://store.steampowered.com/app/200210/Realm_of_the_Mad_God_Exalt/))
- **Screeps: World** — closest agentic precedent: player code runs units 24/7 in one persistent world, bounded by CPU. Our agents get an analogous **Command Budget**. ([Steam](https://store.steampowered.com/app/464350/Screeps_World/))
- **Dungeon Crawl Stone Soup WebTiles** — always-on public servers and spectating culture; slower and turn-based, but a strong replay/social reference.
- **Isleward** — open-source browser roguelike MMO reference for web-native persistence and moddability.
- **Albion Online** — zone-tiered risk: safe learning space, escalating full-stakes depths.
- **Dark and Darker** — extraction changes every fight: greed versus banking.
- **EVE Online** — contracts, escrow, mercenary identity, reputation, and glorious betrayal—plus warnings about bounty farming.
- **OSRS Bounty Hunter** — power-banded target assignment and anti-dodge rules.
- **Clash Royale** — regenerating action meter for readable, fast commander decisions.

## Technical direction

Recommended browser stack, independently checked against live repos on 2026-11-05:

- [PixiJS](https://github.com/pixijs/pixijs) — MIT TypeScript renderer with WebGL/WebGPU backends.
- [Colyseus](https://github.com/colyseus/colyseus) — MIT TypeScript authoritative rooms and reconnection.
- [bitECS](https://github.com/NateTheGreatt/bitECS) — MPL-2.0 typed-array ECS for large unit counts.
- [ROT.js](https://github.com/ondras/rot.js) — BSD-3 dungeon generation/FOV/pathfinding toolkit. Persist generated maps/hashes instead of trusting seed-only reconstruction.
- [Phaser](https://github.com/phaserjs/phaser) — MIT fallback if an integrated framework beats renderer independence.
- [Nakama](https://github.com/heroiclabs/nakama) — Apache-2.0 backend alternative if accounts/social outgrow Colyseus.
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — later thin agent adapter over the same validated game API; MCP is transport, not authorization.

Architecture rule: one headless simulation package. It imports no Pixi, Colyseus, DOM, database, Visa, or LLM code. It consumes ordered commands and emits authoritative events. The same sim runs under tests, in one Colyseus zone process for v1, and later in multiple zone processes.

Prototype targets are starting budgets, not promises: 30 Hz simulation, 15 Hz snapshots, 60 Hz rendering; spatial hashing; pooled projectiles/sprites; interest-filtered state; server-owned damage, loot, bounty progress, and settlement.

## Build sequence (locked: PRD + persistent backend first)

### Phase 0 — PRD and contracts

- This PRD, [docs/VISA_CLI_CONTEXT.md](docs/VISA_CLI_CONTEXT.md), protocol schemas, contract predicates, and event vocabulary.
- No real-money integration. External Visa calls in development are read-only unless the owner separately approves an exact operation.

### Phase 1 — Persistent multiplayer backend

1. Monorepo with `apps/server`, `apps/web`, `apps/agent-mcp`, and `packages/sim`, `protocol`, `worldgen`, `content`, `bounties`, `agent-sdk`, `persistence`.
2. Deterministic fixed-step ECS simulation with seeded scenario tests and replay hashes.
3. Colyseus authoritative zone room: authenticated sessions, command admission, snapshots, reconnect/resume, interest filtering.
4. PostgreSQL persistence for accounts/commanders, Sparks ledger, contract state, event journal/outbox, zone checkpoints, and idempotency records.
5. Contract engine: fund/open/accept/expire/settle/refund, predicate progress from sim events, attribution, dispute hold, and settlement receipts.
6. Typed agent HTTP/WebSocket API over the same command validator as the browser; MCP adapter is a thin later surface.
7. Headless bot clients and load/replay tools prove two independent clients can fight, complete a bounty, crash/reconnect, and reconcile every Spark.

### Phase 2 — Playable browser slice on that backend

1. One generated dungeon zone with safe entry, monster rooms, red PvP room, boss room, and extraction.
2. Human commander plus scripted/agent commanders, 12–25 units each.
3. Follow, attack-move, defend, retreat; Nova, Pinning Volley, Phase Dash/Shell.
4. XP shards, two temporary power-ups, commander death, loot drop, extraction.
5. Bounty board with kill count, escort alive, and deliver relic predicates.
6. Kill feed, contract feed, wallet, escrow, and settlement receipts in the HUD.

Acceptance for Phase 2: a new player understands the loop in ten seconds, casts a spell in the first minute, sees a bounty change another swarm's behavior, and can extract or die with stakes explained on screen.

## Non-goals for v1

- No real-money wagering, cash-out, tradable tokens, or promised earnings.
- No arbitrary user-uploaded code running on the game server.
- No single infinite world simulation. Zones are bounded.
- No permanent paid stat advantage in competitive zones.
- No Visa payment without owner limits/approval and a separate reviewed payment design.

## Risks to kill early

- Self-kill and alt farming of bounties.
- Last-hit theft and disputed attribution.
- Agents with perfect micro overwhelming humans.
- Contract spam, fake tasks, and unreadable UI.
- Snowballing teams camping extraction/new-player zones.
- Settlement retries double-paying after crashes.
- Simulation cost from projectiles and target searches.
- Real-money incentives turning griefing, collusion, and account theft into the optimal strategy.

## Quality Gates

Assumed until the owner names different commands; these must pass for every implementation story once the monorepo exists:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- For simulation or contract changes: seeded replay hash test and settlement-reconciliation test named in that story.
- For browser/UI stories: build the web app and run one real-input browser smoke from a fresh load.

No story may call live `task_post`, paid `task_action`, or `pay` as a test.

## User Stories

### US-001: Monorepo and protocol contracts
**Description:** As a builder, I want the repo/package boundaries and versioned schemas first so that server, web, and agents cannot drift.

**Acceptance Criteria:**
- [ ] `apps/server`, `apps/web`, `apps/agent-mcp`, and the Phase 1 packages exist with one pnpm workspace.
- [ ] Command, observation, event, and contract schemas reject unknown fields and carry `schemaVersion`.
- [ ] `packages/sim` imports no DOM, renderer, transport, database, Visa, or LLM module.

### US-002: Deterministic swarm simulation
**Description:** As a commander, I want units to move/fight under bounded orders so that combat is fast without micromanaging every unit.

**Acceptance Criteria:**
- [ ] Fixed-step sim processes move, attack-move, defend, retreat, cast, loot, and extract commands.
- [ ] The same seed + command log produces the same final state hash in two runs.
- [ ] Invalid owner, target, range, cooldown, resource, and expired commands are rejected with closed reasons.

### US-003: Persistent authoritative zone
**Description:** As a player, I want my zone session and commander to survive reconnects so that the dungeon feels always-on.

**Acceptance Criteria:**
- [ ] Two independent clients join one authoritative zone and receive interest-filtered snapshots.
- [ ] A disconnect/reconnect resumes the same commander without duplicate units or wallet balance changes.
- [ ] Zone checkpoint + event journal reconstruct commander, contract, and ledger state after a server restart in tests.

### US-004: Simulated contract engine
**Description:** As an issuer, I want to fund a task bounty so that another swarm can earn Sparks for verified help or violence.

**Acceptance Criteria:**
- [ ] Creating a contract atomically escrows Sparks and freezes predicate, reward, eligibility, expiry, attribution, and split.
- [ ] Only authoritative sim events advance `kill_count`, `escort_alive`, and `deliver_item` predicates.
- [ ] Replaying the same settlement command/event pays zero additional Sparks.
- [ ] Expired unfunded/unclaimed escrow refunds exactly once.

### US-005: Agent API and bot
**Description:** As an external agent, I want typed observations and commands so that I can play and work bounties without scraping the browser.

**Acceptance Criteria:**
- [ ] A bot can authenticate, observe visible state, list contracts, accept one, issue bounded commands, and extract.
- [ ] The API enforces the same command budget, visibility, cooldown, and spend ceilings as the browser client.
- [ ] Resuming from an event cursor yields no duplicate contract settlement.

### US-006: Thin browser surface on the backend
**Description:** As the owner, I want a minimal live view of the persistent zone so that backend behavior is visible before full game art.

**Acceptance Criteria:**
- [ ] The web app renders commanders/units from server snapshots and sends only protocol commands.
- [ ] Contract feed, wallet/escrow balances, kill feed, and settlement receipt update from server events.
- [ ] A fresh-load browser smoke reaches live play/test view with no console errors.

### US-007: Visa adapter boundary (disabled by default)
**Description:** As an operator, I want the Visa/Taskmarket mapping isolated so that simulated play can never accidentally post or pay a real task.

**Acceptance Criteria:**
- [ ] Adapter code reads [docs/VISA_CLI_CONTEXT.md](docs/VISA_CLI_CONTEXT.md) rules: exact selected agent, status first, closed screened task shapes, one idempotency key per external action.
- [ ] Development configuration cannot call `task_post` or paid `task_action`; any future enablement requires an explicit owner-approved budget and feature flag.
- [ ] Internal Sparks settlement never depends on Taskmarket acceptance or network availability.

## Functional Requirements

- FR-1: The server must be authoritative for movement, combat, damage, death, loot, extraction, contract progress, and Sparks settlement.
- FR-2: Every mutating client/agent command must carry session identity, sequence, tick/window validity, and an idempotency key where it can move Sparks or change contract state.
- FR-3: Contract display text must be stored and transported separately from closed predicate/eligibility facts, and must be treated as untrusted data by every agent surface.
- FR-4: A contract must not settle without authoritative event IDs, a replay reference, attribution output, and a unique settlement record.
- FR-5: Sparks ledger entries must be append-only and balance by account; escrow funding, settlement, refund, sink, and faucet entries must reconcile to zero unexplained difference in tests.
- FR-6: Agents and humans in the same power band must share visibility, cooldown, command-budget, and spend-ceiling rules.
- FR-7: Persisted zone recovery must restore from checkpoint plus ordered event journal without duplicate units, duplicate escrow, or duplicate payout.
- FR-8: Any future Visa/Taskmarket bridge must be asynchronous to combat ticks and must follow [docs/VISA_CLI_CONTEXT.md](docs/VISA_CLI_CONTEXT.md) exactly.

## Success Metrics

- Time to first spell cast in Phase 2: under 60 seconds for a new commander.
- Headless acceptance scenario: two clients complete one escort and one kill contract with reconciled Sparks.
- Replay test: identical seed/input produces identical state hash.
- Load target to benchmark in Phase 1: 8 commanders x 25 units + 500 monsters + 1,000 live projectiles in one zone without missed settlement events. This is a target, not a claim.
- Economy simulation target before any real-money design: no double payout, no orphan escrow after crash injection, and repeat-kill rewards decay to non-farmable levels.

## Open Questions

- Quality gates: keep assumed `pnpm typecheck && pnpm lint && pnpm test`, plus browser smoke for UI, or name different commands?
- Commander death: permadeath per run, persistent commander with loot loss, or hardcore seasonal ladder?
- First visual art direction: Halls of Torment dark pre-rendered feel, clean neon geometry, or readable pixel dungeon?
- Agent authorship: built-in policies only in v1, or also a sandboxed strategy package format after the typed API?

## Build status (2026-11-06)

Vertical slice is live in this repo: authoritative 30 Hz zone server (`apps/server`, raw `ws`), Pixi commander client (`apps/web`), agent SDK + bot (`packages/agent-sdk`, `apps/agent-mcp`), deterministic sim with BFS pathfinding, Contract engine + Sparks ledger, JSONL journal + atomic checkpoints. Run `pnpm dev` → web http://127.0.0.1:15173/, health http://127.0.0.1:18787/health. Gates: `pnpm format && pnpm check` (43 tests) + `pnpm build`.

Agentic-play checkpoint (2026-11-06): swarm movement rebuilt as shared-anchor flocking with leader rubber-banding (live unit distance p50 57px, 97.4% within 190px, 0.6% stranded — baseline was p50 209px / 41% / 8.2%); server bots sortie on waypoint routes with retreat/sortie hysteresis (10.5% Sanctuary dwell under live pressure); monsters leash home. First model-backed commander is live: `AI Sable` runs an LLM as strategic planner (closed intent allowlist, fail-closed validation, planner cadence ~2s + latency) above a deterministic tactical controller in `packages/commander`, driven from `apps/agent-mcp/src/commander.ts`. Every decision is recorded in a hash-chained JSONL journal (`apps/agent-mcp/data/commander/journal.jsonl`) that splits `source:"model"` vs scripted `source:"fallback"`; safety overrides are separate journal keys. Measured on the final config: ~79% of planner decisions model-sourced (rest timeout fallbacks), ~73% of tactical commands executed under a live model intent; the model accepts bounties, hunts the boss contract, and retreats at low HP. Launch: `COMMANDER_MODEL="nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" COMMANDER_PLANNER_MS=2000 pnpm --filter @swarms/agent-mcp commander` (any OpenAI-compatible chat endpoint works via `COMMANDER_BASE_URL`/`COMMANDER_API_KEY_ENV`). Death/extract now removes the fallen swarm's units, and disconnect is no longer a free heal: bodies stay vulnerable for a 5s logout window, then park; resume restores the parked commander (position, HP, essence, unit count) unhealed.

Shipped beyond the first slice, from live playtesting + blind critic rounds: entry Sanctuary (no damage, heal/replenish), disconnect parking with wallet-preserving resume, line-of-sight targeting (no through-wall attacks or wall-grind chases), swarm leash/catch-up, live bounty progress + tracking state, system-bounty re-seeding and boss respawn (always-on world stays stocked), combat/death feedback (hit flashes, death bursts, damage vignette, death/extraction overlay, spell area effects, Shell bubble), off-screen objective arrows, camera framed left of the Contract Board, collapsible opaque Contract Board.

Readability + brains checkpoint (2026-11-06 evening): every AI commander now has a model brain, each on a different model — `AI Sable` (Nemotron free cloud), `AI Flint` (local qwen2.5:3b via ollama), `AI Onyx` (local llama3.2:3b via ollama) — launched as separate commander processes with per-commander journals (`journal.jsonl`, `journal-flint.jsonl`, `journal-onyx.jsonl`). Small-model planner output needed adapter hardening (blank-id cleanup, one-word objective normalization, expiry repair, concrete-tick dynamic prompt); after it, tuned local runs measured 76/76 and 74/74 model-sourced planner decisions with zero errors (82–86% of tactical commands under live model intent), while the free cloud model fell to 57% on timeouts — cheap local 3B models beat free cloud on this closed-JSON task. Local launch: `OLLAMA_API_KEY=ollama COMMANDER_API_KEY_ENV=OLLAMA_API_KEY COMMANDER_BASE_URL="http://127.0.0.1:11434/v1/chat/completions" COMMANDER_MODEL="qwen2.5:3b" COMMANDER_NAME="Flint" pnpm --filter @swarms/agent-mcp commander` (per-instance `COMMANDER_JOURNAL_PATH`/`COMMANDER_RESUME_FILE`). Visual pass: gothic type (UnifrakturMaguntia/Cinzel) and palette, textured stone with per-room identity for all seven rooms, distinct actor glyphs (diamond-sigil commanders, dart units, skull skeletons/wardens/boss), name pills with YOU/AI/BOT/PLAYER controller badges, minimap, tracked-bounty and enemy-commander edge arrows, floating damage numbers, spell cost/cooldown chips (snapshot now carries `world.rooms` and `spellReadyAt`), and settlement feed lines that name the collecting swarm. Round-3 critic (self-run after two critic-subagent runtime losses): checkpoint claims hold, 0 blockers, the carried HUD-wrap major fixed.

Graphics/items/levels checkpoint (2026-11-08): code-drawn glyphs replaced by a generated gothic sprite set (11 assets: commander, minion, skeleton, brute-as-warden, boss, four pickup icons, two spell icons in `apps/web/public/assets/` + manifest, chroma-cut) drawn on a y-sorted sprite layer anchored at feet, with the glyph renderer kept as fallback and particles for hits/deaths/pickups/level-ups. Survivors loop added: monster and commander kills grant XP into a per-life level curve (`6 + 4/level`); level-up rolls a draft of 3 stackable boons (might/swift/brood/magnet/vitality/arcane) — humans pick by click or 1/2/3, bots and AI commanders auto-pick by policy (feed-labelled `(auto)`), unpicked drafts expire to auto-pick after 10s, death resets level/XP/boons, disconnect-restore preserves them. Crimsonland-style drops: skeletons 6% / wardens 25% utility drops, boss guarantees Frenzy Idol + Blood Vial, joining haste/fang/relic; essence magnet radius scales with Soul Magnet stacks. Two new spells: Frost Nova (F, self AoE + 55% slow) and Chain Lightning (C, 4 hops ×0.7 falloff) with server-authoritative bolt paths shipped in snapshot `effects` and drawn as jittered arcs; the tactical controller casts both, and the commander client now survives disconnects (contract/command send failures journal instead of crashing; brains still need relaunch after server-code restarts). `New swarm` sends an explicit `abandon` that despawns the old commander immediately and invalidates its resume token. Verified: 43/43 gates green, blind critic round 4 (0 blockers; its 3 majors — draft surviving death, New-swarm orphan, invisible chain lightning — fixed and re-verified), browser draft probe picked Arcane via key `1` at level 2, chain arcs photographed in live combat, relaunched brains at 100% model decisions on first post-fix checks (Sable 18/27 on free-cloud timeouts), ledger net 0 at tick ~4.67M.

Direct-control/classes/HUD checkpoint (2026-11-09): the commander is now directly playable, not just an order-issuer. Hold Space to fire cursor-aimed bolts (6 dmg, 6-tick cooldown, 25-tick flight, wall/LOS-blocked, suppressed in the Sanctuary), layered over swarm orders — firing never changes stance — and Shift+click is move-only alongside click attack-move / right-click defend / H stop. First join is gated behind a character select (Necromancer balanced; Warlock 0.75× HP, 1.6× command regen, 1.3× spell damage, 0.9× unit damage; Bone Knight 1.42× HP, 0.9× speed, 1.2× unit damage, 1.3× unit HP) with two new commander sprites (13 assets total); class lives in a single content table (`CHARACTERS`) so Vitality stacks add after the multiplier, persists in checkpoints/parked state, resuming players skip the picker and keep their stored class (a different hello class is ignored), `?char=<id>` auto-joins for probes, fresh bots spawn Ash=Bone Knight / Moss=Warlock, and legacy checkpoints migrate deterministically by commander id. AI commanders and zone bots shoot the nearest hostile through the same `shoot` verb (tactical controller + bot loop, sim rate-limited). Bottom-center HUD: class portrait, HP bar, command bar, XP bar, level + stance readout (snapshot now carries `character`, `stance`, `buffTicks`, `projectiles`), active-buff chips with second timers, and an inventory line (essence / relic / boons) — supplementing, not replacing, the top-left stats. Motion pass: procedural run-bob and velocity lean on every sprite, foot dust at speed, idle breathing, camera lookahead toward the cursor sharing one smoothed center with `screenToWorld` (clicks stay exact under lookahead), and damage numbers merged per entity over a 220ms window. Verified: 51/51 gates green (8 new class/bolt/persistence tests), browser playtest picked Bone Knight through the real picker (170/170 HUD) and drove stance attack→follow→defend→stop, `?char=warlock` auto-join verified (90/90), all three brains journaling fresh after restarts, ledger net 0 at tick ~5.82M. Spec: `/tmp/game/spec4.md`; round-5 review + critique in `/tmp/game/iterations/round_5/` and `/tmp/game/critique-5/`.

Twin-stick/weapons checkpoint (2026-11-09): the commander is now driven like the genre reference games. WASD steers the body directly (new `steer` command: clamped unit vector, 12-tick dead-man switch, wall-sliding, no pathfinding and no cohesion throttle while steering) without touching stance/target/path, so a dodge never cancels the swarm order it interrupts — when steering ends with no active path the commander simply stays put. Firing moved to hold-LMB at the cursor (Space still works); swarm orders live on RMB (attack-move), Shift+RMB (move-only), MMB (defend), H (stop). Weapons are a switchable loadout unlocked through the level draft (wheel/Tab to cycle, HUD chip shows active weapon and owned count): Bolt Wand (8 dmg, best single-target DPS), Scatter Wand (5×3 pellets, point-blank burst), Soul Lance (11 dmg, pierces 4) — picking a weapon auto-equips it, death resets to the Bolt Wand like other boons, disconnect-resume keeps the loadout, and ambient bots keep the original 6-boon draft pool. Input polling runs on a 50ms interval instead of the render loop, smoothing is frame-rate-corrected with a light self-prediction offset while steering, and drafts are hash-shuffled so any boons (including both weapons) can be offered together. Snapshot now also carries `weapon`/`weapons`. Verified: 60/60 gates green (steer order-preservation, 4-target pierce, death-reset tests added), browser playtest 15/15 asserts including world-position steering (+393px, dead stop on release) and a live Scatter Wand draft mid-sortie, blind critic round 6 (0 blockers; 5 majors — rAF-bound input, order-canceling steer, smoothing lag, weapon ladder, red probe — all fixed and re-verified), all three brains journaling fresh, ledger net 0 at tick ~6.22M. Spec: `/tmp/game/spec5.md`; round-6 review + critique in `/tmp/game/iterations/round_6/` and `/tmp/game/critique-6/`.

Feel/netcode checkpoint (2026-11-09): commander movement rebuilt on a server-side velocity model (accel 1400 px/s², decel 1800 px/s² at the same 190 px/s top speed, per-axis wall slide that zeroes the blocked component), and the client now runs a faithful prediction mini-sim of that model — predicted velocity accelerated/integrated each frame against the snapshot's wall set using the same `canStand` test, velocity resynced from snapshot `vx`/`vy` at 10 Hz, soft reconciliation to the smoothed server position with a hard snap beyond 128px — so wall contact, direction reversals, and Frost slows no longer rubber-band (snapshots stay 10 Hz; now carry `vx`/`vy`/`moveSpeed`/`slowActive`). RMB cohesion is a continuous curve (`clamp(1.25 − medianDist/340, 0.45, 1)`, replacing discrete 1/0.7/0.45 steps that pulsed travel speed 59↔190 px/s), WASD release enters an explicit coast state instead of springing back to a snapped target, and final-waypoint arrival brakes on a stopping-distance curve with a 6px deadzone. Fresh-commander corridor balance: 8s PvP spawn grace (commander-sourced damage to the body blocked with a `blocked` damage event, units of a graced owner take 0.35×; grace ends early on shooting, offensive casts, or dealing PvP damage; visible to everyone via a teal shield ring, HUD countdown, and IMMUNE floaters), monsters ignore victims within the Sanctuary rect +64px and ambient bot units use the same doorway leash, and ambient bots stop gaining XP at level 3. Verified: 67/67 gates green (accel/coast no-creep, blocked-grace event, unit-grace + early-expiry, bot doorway targeting, cohesion continuity tests added), browser feel probe green (grace-on-join true, ~174 px/s steady steer, 0 reversals, exact full stop) plus twin-stick regression 14/14, blind critic round 7 (2 blockers + 5 majors — prediction/server model mismatch, cohesion surging, one-sided invisible grace, steer-release creep, short-order oscillation, bot door-camping — all fixed and re-verified), all three brains journaling fresh, ledger net 0 at tick ~6.44M. Spec: `/tmp/game/spec6.md`; round-7 review + critique in `/tmp/game/iterations/round_7/` and `/tmp/game/critique-7/`.

Directional-life checkpoint (2026-11-09): every actor now faces where it is going. All seven actors (3 commanders, minion, skeleton, brute, boss) gained generated front/side/back 4-frame walk strips (34 sprite assets); the client slices strips from the manifest (`frames`/`cell_w`), picks facing from smoothed velocity with a 100ms switch hold, steps walk frames by distance at a per-actor stride with an ease-out on stop, flips only in side view, faces units/monsters toward nearby hostiles with a melee jab telegraph, and rises monsters out of the floor on first sight — the front-facing bobbing "garden gnome" is gone (critic-measured facing agreement 96.5% on tick-aligned frame replay, stride matched to ground speed). Swarms behave: attack stance forms a wedge on a persisted server-side commander heading anchored at the commander, defend holds a leashed ring (110px acquire / 130px chase break-off), target selection penalizes claimed intent (`targetId`, 60px per claimant) so 14 units spread across targets from tick zero, units without line-of-sight to their formation point follow the nearest visible commander trail breadcrumb through doorways, and monsters alert packmates within 180px line-of-sight — alerted monsters acquire at 620px and investigate the stamped alert point under a 720px leash (client pops a "!" on newly alerted monsters). Three new draft weapons — Soul Orbit (twin contact blades, 12 dmg, passive while equipped), Wisp Swarm (line-of-sight homing), Grave Scythe (wide piercing slash) — plus boon-combo evolutions that replace their base weapon (Bolt+Arcane→Storm Wand chain lightning, Scatter+Might→Hellscatter 5-pellet, Lance+Swift→Phantom Lance pierce 8); loadout cap is now 6. Atmosphere: 8% elite monsters (hp ×2.2, damage ×1.3, guaranteed utility drop, gold 1.3× render with pulsing ring), allegiance-tinted commander glow, HP-aware vignette, two-lobe blood decals, and distance-gated hit-stop/shake on elite/boss deaths. Also fixed en route: releasing WASD while wall-pinned no longer walks back to the stale spawn target. Verified: 82/82 gates green (15 CP7 sim tests: orbit rehit, homing, scythe, evolution draft/replace, storm chain, wedge heading persistence, defend leash, claim spread, pack investigate, elites, hellscatter, phantom, wall-pinned release), browser feel probe green (174–190 px/s, coast 0.0px after the wall-pin fix, exact full stop) plus twin-stick regression 14/14 with live Wisp/Orbit drafts, blind critic round 8 (2 blockers + 7 majors — commander buried in brawl, wedge amnesia/collapse, non-defending defend, monster moonwalking, positional target spread, pack no-ops, dead elite juice — all fixed and re-verified; zone dwell proxy recalibrated 0.35→0.40 with measured cause: pack pressure runs retreat/regrow cycles hotter at 1 death/bot and ~9.4 units out), all three brains journaling fresh, ledger net 0 at tick ~6.66M. Deferred: side-strip anchor jitter polish, Storm chain arc visual. Spec: `/tmp/game/spec7.md`; round-8 review + critique in `/tmp/game/iterations/round_8/` and `/tmp/game/critique-8/`.

Known next frontiers (not yet built): sound, world-state pruning (6.7k contracts, ~155MB brain journals), spatial partitioning/interest filtering (snapshots still carry the full wall list at 10 Hz), auth beyond resume tokens, Postgres/Colyseus evaluation from §Technical direction, MCP adapter surface, economy abuse simulations (collusion, repeat-kill decay), real Visa/Taskmarket bridge (design-only per decisions).


