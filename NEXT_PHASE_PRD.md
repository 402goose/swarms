# NEXT PHASE PRD: SWARMS out of POC — v0.2 "First Fun Hour"

Written 2026-11-10 after two fresh headless play sessions (real CDP mouse/keys,
fresh profiles) plus code audit. Evidence scripts: `/tmp/swarms-play-mine.mjs`,
`/tmp/swarms-play-mine2.mjs`, `/tmp/swarms-snap-size.mjs`,
`/tmp/swarms-snap-breakdown.mjs`. Screenshots: `/tmp/swarms-mine-*.png`,
`/tmp/swarms-mine2-*.png`.

## Verdict

The backend is not the POC. The front of the game is.

Proven and solid: authoritative 30 Hz sim, contract engine + ledger (net 0 at
tick 8.26M), persistence, LLM/bot commanders, 85/85 tests + typecheck green
(re-run 2026-11-10), zero console errors across both of my sessions.

What keeps it feeling like a POC is three measured things: a 3.2 MB snapshot
firehose that starves the client, character "animation" that is four copies of
one static pose, and a first-five-minutes funnel where a new player can't test
their gun, can't find a fair fight, and gets ganked by a bot with a full reset.

Fix those three. Add nothing else until they're fixed.

## What I measured by playing

### Session funnel (fresh profile, picker -> death)

- Picker works and looks good. 3 classes, name prefilled, join in ~2s after Enter.
- Spawn (272,672) in Sanctuary, 14 units, 0 hostiles worth fighting in the room,
  other swarms piled on the same spawn point.
- Hold-LMB in Sanctuary for 2.5s: 0 projectiles fired, no on-screen reason given.
  (By design: `packages/sim/src/index.ts` shoot case returns silently when
  `inEntry(commander)`.)
- First straight-line WASD test moved 6 px/s; the identical test 2s later moved
  164 px/s (top speed 190). Suspected input-focus bug: `apps/web/src/main.ts`
  keydown swallows all keys when the event target is an INPUT, `confirmChar()`
  never blurs the name field, and window blur clears the key set. Needs a headed
  repro; treat as "intermittently dead first keys."
- Steering itself is fine when keys register: N 195 px/s, E 164 px/s, exact stop.
- My swarm auto-fought in follow stance with zero orders from me: XP 4/6 before
  I ever aimed at anything. Draft at level 2 offered Grave Scythe/Arcane/Might;
  key `1` picked and auto-equipped the Scythe.
- Units died *inside* the Sanctuary (14 -> 10) while Moss Swarm (bot) and a
  parked player brawled in the spawn room. Commander bodies are protected;
  units are not fully.
- Died 22s into my first real roam: `Alec-451 killed by Ash Swarm` (bot PvP in
  the exit corridor). Death = level, XP, boons, weapons all reset (sim death
  handler), respawn in 300 ticks (~10s) with no countdown shown on the overlay.
- Extract key away from extraction: status "Not at extraction" — good feedback.
- Never exercised by me before dying: RMB attack-move, MMB defend, Q/E/R/F/C
  spells, a completed extraction, the relic, the boss. That is itself the
  funnel finding.

### The smoking gun: snapshot size

One snapshot per client, measured over WS (30 snapshots, 3s):

- Total: 3,171 KB per snapshot at 10.1 Hz = ~32 MB/s per client.
- `contracts`: 3,056 KB (96%). 6,995 contracts sent every snapshot:
  6,829 settled + 165 refunded + 1 open. The board displays 3.
- `pickups`: 90 KB, 980 live pickups. Pickups never expire (deleted only on
  consume; vials are skipped at full HP).
- Actual gameplay state (`world`+`entities`+`commanders`+`feed`+`projectiles`):
  ~25 KB.

Every client JSON-parses ~3.2 MB ten times a second. In headless Chrome my
frame rate collapsed from 146 fps (clean 3s window at spawn) to 0-8 fps during
combat roaming; headless rAF is unreliable, but 32 MB/s of parse+GC churn is
real in any browser and it starves interpolation, prediction, and animation
stepping. This is a large part of why characters *feel* bad in motion.

Server side: `runtime.snapshot(session)` builds this per client per 100 ms, and
the checkpoint (7.7 MB, rewritten every 150 ticks ~5s) carries all 6,995
contracts and ~980 pickups. `data/zone-1/events.jsonl` is 592 MB and grows
~60 MB/day at idle with bots (append + `fsyncSync` per append, never rotated).

### Character audit (why it looks/feels bad)

Viewed directly: `commander-front/side.png`, `commander-boneknight-side.png`,
`skeleton-front.png`, `minion-front.png`.

1. The "4-frame walk strips" are four AI variants of one static pose. Feet and
   silhouette barely change; staff angle and sash details mutate between frames
   (flicker). The distance-stepped animation system in `main.ts` is fine — it
   has nothing to animate. Result: gliding + bobbing.
2. One strip per direction total. No idle, attack, cast, hurt, or death poses.
   Melee "jab" is a position offset.
3. At gameplay size (64px draw height, ~90 screen px at 1.4 camera scale) all
   three commanders read as "dark hooded smudge." Picker art is good; in-world
   front/back views are near-black cloaks with no face.
4. Every actor wears one or two saturated rings (white/teal/orange/purple).
   In any multi-swarm frame the rings become neon spaghetti and dominate the
   sprites. Minions (radius 8, 30px sprite) are identical dark beetles for
   every owner; ownership is ring color only.
5. Fourteen units + shared spawn points = one indistinguishable black pile at
   spawn, and a conga line when trail-following through corridors.
6. Pickup labels are always on (repeated "Blood Vial" x N overlapping), damage
   numbers are oversized vs sprites, and HP/CMD/XP/level are shown twice
   (top-left stats and bottom player HUD).

## The plan (sequence matters; each checkpoint has a hard gate)

### CP0 — Snapshot diet (do first; unlocks feel everywhere)

- Snapshots carry only: open contracts + contracts tracked/accepted by the
  viewer + settlements from the last 5 minutes (or last 20). Settled/refunded
  history moves to an archive (queried via HTTP, never streamed).
- Static world (`walls`, `rooms`, tile size) sent once in `welcome` keyed by
  the existing `mapHash`; snapshots drop `world`.
- Interest filter: entities/pickups/projectiles within ~900px of the viewer
  (plus own units and all commanders for edge arrows).
- Pickup TTL: essence 120s, utility 180s; merge stacked essence.
- Gate: avg snapshot < 60 KB and < 600 KB/s per client (script-measured);
  headed-Chrome 60 fps during an arena brawl; snapshot-size regression test;
  existing 85 tests + typecheck green.

### CP1 — Persistence diet (the world must be able to run for a week)

- Rotate `events.jsonl` on successful checkpoint (truncate, keep seq).
- Checkpoint on interval >= 30s and on big events, not every 150 ticks.
- Batch event fsync (1s window) instead of per-append fsync.
- Prune settled contracts and stale ledger accounts out of the checkpoint;
  archive to a sidecar file. Rotate brain journals.
- One-time: archive current `data/zone-1` and start a fresh zone (current
  world: 6,995 contracts, ~980 pickups, dungeon balance -1,517,150 Sparks,
  several parked probe commanders).
- Gate: 24h bot soak grows `data/` < 50 MB; restart restores identical world
  hash; contract count in checkpoint stays bounded (< 200).

### CP2 — Character overhaul (assets + readability, not more code)

- Regenerate true cycles per actor: idle 2f, walk 6f, attack 2f, hurt 1f,
  in front/side/back. QC every strip with a script gate *before* wiring:
  frame-to-frame silhouette change must be visible (feet must actually swap),
  anchor jitter < 2px, no detail mutation (staff/sash stable). If image-gen
  can't pass QC after two rounds, fall back to code-animated part sprites
  (cloak/hood/staff/legs as separate layers, procedural stride).
- Commander draw height 64 -> ~84; brighter rim light and a readable face/hood
  opening on front view; class silhouettes must differ at 90px (horns, shield
  bulk, hood).
- Kill the double rings. One soft ground shadow ellipse + one thin owner-color
  base arc per actor; minion core tinted per owner.
- Face the cursor while firing (attack-facing overrides velocity facing).
- Gate: in a 3-swarm brawl screenshot, a cold viewer picks out "you" in < 2s;
  frame-QC script green on all strips; before/after screenshots reviewed.

### CP3 — First ten minutes (the funnel)

- Separate spawn points per commander (4 exist in worldgen); no pile.
- Sanctuary is hard-safe: no damage to units either, bots path-excluded,
  monsters already leash out.
- Shooting in Sanctuary: either allow it (hits nothing protected) or show
  "Weapons sealed in the Sanctuary" the moment LMB/Space is held. Never silent.
- Blur the name input on Enter; canvas focus hint if keys are swallowed.
- Guided first sortie, in-world not in text: 3 training skeletons in the
  entry-adjacent room -> first draft -> auto-track "Cull 12" with arrow ->
  extraction arrow after first claim.
- Newbie protection: bots don't PvP-target commanders below level 2; extend
  the existing 8s body grace to units while in the entry margin.
- Death overlay shows the respawn countdown.
- Gate: hardened fresh-player probe (fork of `/tmp/swarms-play-mine2.mjs` into
  `tests/browser/`) — first kill < 90s, first draft < 3 min, alive after a
  5-minute roam, 3/3 runs.

### CP4 — Orders/combat readability + HUD dedupe

- Probe-verify every verb through the real UI: RMB attack-move, Shift+RMB
  move-only, MMB defend, H stop, Q/E/R/F/C, Tab/wheel, extract success path,
  relic carry + shrine return, boss kill. Fix what's unverifiable or unclear.
- Pickup labels only within ~220px; damage numbers capped in size and merged
  (merge exists — tune); formation slots get separation so trail-following
  doesn't collapse to a conga line in corridors.
- One HUD: delete the duplicated stats from the top-left block (keep commander,
  sparks, escrow, status there; HP/CMD/XP/level live in the bottom HUD only).
- Controls footer collapses each hint after first successful use.
- Gate: verb-coverage probe green; blind critic round "no" answers fixed.

### CP5 — Soak, then call it v0.2

- 24h unattended soak (server bots + 1 LLM brain): record snapshot KB, server
  RSS/CPU, `data/` growth, live contract/pickup counts, ledger net.
- 8-client WS load check.
- README runbook (start, health, reset world, launch brains).
- Tag v0.2. Only now reopen the frontier list (sound, economy sinks, auth,
  Postgres/Colyseus, Visa bridge).

## If I had 100x agency

I would not add features. I'd run one studio week with parallel lanes, each
owning a gate above, and a daily playable build:

- Netcode/persistence lane: CP0 + CP1. Highest leverage in the repo — it makes
  movement, animation, and combat feel better without touching game code.
- Art-director lane: CP2 strips with the frame-QC script as the merge gate;
  no strip merges on vibes.
- Gameplay lane: CP3 funnel + spawn protection.
- QA lane: the funnel probe in CI, plus one blind fresh-eyes playtest per day
  with screenshots; blockers/majors fixed before new work.
- Balance lane: the sim is deterministic and headless — run fast bot-vs-bot
  matches offline to tune time-to-first-death, bounty completion rates, and
  Sparks faucet/sink before any human feels it.
- Producer (me): kill scope daily. Nothing merges without its measured gate.

The rule that gets a game out of POC is not more systems. It's one loop —
sortie, kill, level, claim, extract — that a stranger finishes once and wants
to run again, on a world that doesn't eat itself.

## The goal I would set

> Ship SWARMS v0.2 "First Fun Hour": a fresh player joins in < 30s, gets a
> kill and a level within 2 minutes, claims a bounty and extracts within 15,
> at a stable 60 fps, on a persistent world that stays bounded through a
> 7-day soak. Gates: snapshot < 60 KB @ 10 Hz; `data/` growth < 50 MB/day;
> character cycles pass frame-QC and the commander is identifiable in a brawl
> screenshot; fresh-player funnel probe green 3/3; full test suite +
> typecheck green. No features beyond CP0-CP5.

## Open decisions (my recommendation first)

1. Death penalty: keep full run reset (recommended — it's the extraction
   tension), but first death per commander is free and the countdown shows.
   Alternative: keep level, drop boons.
2. Art route: regenerate strips with QC gate (recommended); fallback is
   code-animated layered parts. Picker/HUD portraits stay as-is.
3. World reset after CP1: yes (recommended) — archive zone-1, fresh world.
   The current world state is polluted beyond tuning value.
4. Bot PvP vs newbies: off below level 2 (recommended). Bots should be
   content and pressure, not a spawn-camp.

## Shipped 2026-11-10 (click/facing fixes, post-report)

User report from real-browser play: clicking does nothing, commander never
points where he's going, directions indistinguishable. Root causes found and
fixed in `apps/web/src/main.ts` (client only; `pnpm check` green, 85 tests):

- Facing was derived from rendered-position deltas divided by a frame dt
  clamped to 0.05s, with per-frame smoothing — at low/stuttery frame rates it
  stuck in side view (proven: north and south movement rendered side view).
  Now: real elapsed dt, time-based smoothing, authoritative snapshot `vx/vy`
  for commanders, instant steer-direction facing for self, and face-the-cursor
  while firing. Post-fix screenshots: north = back view, south = front view.
  (Assets themselves are correct: every side strip natively faces right;
  front/back strips are genuinely front/back — checked per-cell enlarged.)
- Holding LMB in the Sanctuary silently no-oped (faint grey puff only). Now
  the status line reads "Weapons sealed in the Sanctuary — head east through
  the door to fight."
- LMB now fires immediately on pointerdown instead of waiting for the 50ms
  input poll (short taps could be missed). Picker/canvas clicks blur the name
  input.
- Regression probe: `tests/browser/face-click-probe.mjs` (asserts sealed
  feedback, tap fires >= 1, hold fires >= 3 outside; saves facing tour shots).
- Correction to the funnel notes above: the "dead first WASD after join"
  anomaly is a headless-Chrome artifact (one-off window blur clears the key
  set; focus is BODY after picker, second press moves at full speed). Not
  reproduced as a product bug; re-open only if seen in a real focused tab.

Still open and next: CP0 snapshot diet (the remaining stutter/camera lag),
then CP2 true walk cycles (the glide).

## Shipped 2026-11-10 (higher-vision combat/class/economy pass)

User asked for the bigger game loop, not another isolated tuning change. This
pass connects reach, class identity, swarm growth, extraction value, and world
clutter:

- Weapon reach now matches the visible fight: Bolt/Storm travel about 624
  world px from the commander center, Lance/Phantom about 811, Scatter about
  300, Wisp up to about 583 along its homing path, and Scythe about 150 to its
  projectile center. Walls and first hits still stop non-piercing shots.
- Classes now have kits, not just multipliers. Everyone keeps Bolt Wand as a
  sidearm. Necromancer starts with Wisp Swarm, has an 18-unit cap, raises for
  4 essence, and a Grave Nova hit raises a replacement below cap. Warlock
  starts with Soul Lance; Hex Chain costs 32, cools down in 120 ticks, and
  hops to five targets. Bone Knight starts with Grave Scythe, its shell lasts
  120 ticks, and its nearby swarm takes 20% less damage. Draft rolls are
  class-weighted without making the pools exclusive.
- Essence became run biomass. `G` raises a replacement in the field for
  4/6/8 essence by class, while Sanctuary remains free but slow. Extraction
  banks up to 50 leftover essence at 2 Sparks each, so spending to survive now
  competes with carrying value out. Zone bots also field-raise when depleted
  and holding at least 12 essence.
- Pickup growth is bounded. Essence expires after 60s, combat buffs after 90s,
  Blood Vials after 120s, and live counts cap at 250 essence / 120 utility;
  the relic never expires. The polluted live world measured 658 pickups before
  this pass and 3 after the migrated world restarted; a live browser probe
  later observed 8 at join and 16 after combat. The client also culls pickup
  rendering beyond 760px, rings beyond 460px, and labels beyond 175px (relic
  excepted), with smaller/shorter floating text and a smaller bottom-left
  draft card.
- Verification at this checkpoint: `pnpm check` green with 92 tests, plus a
  public-UI browser probe covering picker join, Sanctuary feedback, Tab,
  WASD exit, `G`, RMB attack stance, Grave Nova, LMB tap/hold, pickup bounds,
  screenshots, and a measured Bolt displacement of 469px from its first
  observed snapshot position (wall/target-limited below the new hard range).
  Headless FPS remained unreliable under the 3.2 MB snapshot load.

CP0 and CP2 remain the top structural risks: snapshot size still dominates
frame pacing, and the walk strips are still four near-identical poses rather
than true cycles.

## Not verified by me today

Headed-browser frame rate and the first-keys focus bug; RMB/MMB/spell verbs
through the UI; extraction success, relic return, boss fight. CP0's fps gate
and CP4's verb probe close these.

