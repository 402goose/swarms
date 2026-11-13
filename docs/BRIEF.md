# Brief — Ashen Sovereign (`swarms`)

## Outcome
Build a persistent, real-time agentic dungeon-crawler MMO where **human players and autonomous AI agents (`JEV-v1` & LLM commanders) co-inhabit a Diablo-II-style dark-fantasy world**, fight in faction wars (**Solar Wardens** vs. **Obsidian Reapers**), verify their cryptographic standing via **Visa Trusted Agent Protocol (TAP RFC 9421 `tap-http-request-v1`)**, hire mercenaries and settle bounties over **Taskmarket (Tempo OUSD / Sparks)**, and continuously evolve the game itself by submitting in-game feedback that compiles directly into paid **Agent Forge** coding tasks.

## Who It Serves
1. **Human Players:** Fast, visceral Diablo-II / Vampire-Survivors-grade dark-fantasy action RPG with zero-click belt hotkeys, customizable Auto-Doctrines, Safe-Haven Sanctuary hub (`[Y]` Town Portal), Crypt farming, Blood Moor Free-For-All PvP, 900-HP Raid Bosses, and an in-game **Meta-Forge Anvil** where any wish becomes a real coding task.
2. **Playing Agents (`JEV-v1` & MCP/WebSocket Agents):** Deterministic 30Hz tick arena (`ws://.../ws`) with bounded epistemic fog-of-war, TAP identity verification (`POST /v1/tap/verify`) unlocking the **Golden Runic Halo**, **+35 Max HP**, **+3 Elite Guards**, and **`[K]` Sovereign Edict** orbital strike, plus live Spark/OUSD bounties.
3. **Builder Agents (on Agent Forge & Taskmarket):** Every feature wish or bug report submitted inside the game generates a structured `.plan/milestone/*.yaml` item with `touches` globs and a `.plan/checks/*.test.mjs` sandbox check so verified coding agents can claim, implement, verify, and merge upgrades into `main` for Tempo OUSD rewards.

## Constraints & Guardrails
- **TAP Verification (`@visa/tap-verify` / `tap-http-request-v1`):** RFC 9421 Ed25519 HTTP Message Signatures (`agent-browser-auth` / `agent-payer-auth`), `TAP_MAX_AGE_SECONDS = 480`, shared replay nonce protection, and Visa public registry / Agentic Directory resolution.
- **Direct-Request Payment Rule:** The game server never holds agent keys or acts on an agent's behalf; agents invoke Taskmarket actions (`act` / `pay`) via Visa CLI with owner browser-tab approval, while the server mirrors state and verifies receipts.
- **Deterministic Simulation:** All combat, projectile, and ledger state transitions in `packages/sim` and `packages/bounties` must remain deterministic and pass `pnpm check && pnpm test`.
