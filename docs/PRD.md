# PRD — Ashen Sovereign: Persistent Agentic MMO & Self-Building Forge

Status: Active (`main`). Follows Agent Forge `DESIGN_projects.md` (`docs/BRIEF.md` → `docs/PRD.md` → `.plan/milestone/*.yaml` → Taskmarket settlement).

---

## 1. World Topology (Diablo II Sanctuary → Wilderness → FFA Arena → Boss Sanctum)

| Zone / Room | Coordinates (Tiles / px) | Rules & Mechanics |
|---|---|---|
| **The High Sanctuary** (`entry`) | `x: 64..384, y: 512..768` | **Safe Town Hub**: Zero PvP, monsters repelled, +25 HP/sec healing, free unit regrow. Houses the **Meta-Forge Anvil `[I]`**, **Visa-TAP Obelisk `[O]`**, and **Sanctuary Portal `[Y]`**. |
| **Outer Crypts** (`crypt-west`, `crypt-south`) | `NW & SW Wings` | **PvE Horde & Corpse Farming**: Skeleton & Bone Warden packs, Essence drops, `[G]` corpse raising, Catacomb Surge hunter waves every 40s. |
| **Blood Moor Crucible** (`arena`) | `x: 928..1312, y: 448..832` | **Free-For-All & Faction PvP (Lv 3+)**: High-value pickups, Blood Contracts on high-essence commanders, cross-faction spoils. |
| **Sanctum of the Moon Shrine** (`shrine`) | `NE Wing` | **Relic Objective**: Deliver the Moon Relic here for +50 Faction Score and contract settlement. |
| **Lair of the Bone Choir** (`bone-choir`) | `SE Wing` | **Raid Boss Dungeon**: 900-HP Bone Choir Boss guarding the Moon Relic & Frenzy/Vial caches. |
| **Rift Gate Extraction** (`extraction`) | `East Wing` | **Bank & Extract**: Bank uncommitted Essence into permanent Sparks (`1 Spark = $0.001 USD`). |

---

## 2. Visa TAP Verification (`@visa/tap-verify` / RFC 9421) & Agent Standing

### 2.1 Wire Contract (`visa-mono` & `agent-forge` Compatible)
- Agents sign HTTP requests using `visa-tool attest_http_request` (`tap-http-request-v1`, RFC 9421 `alg="Ed25519"`, `tag="agent-browser-auth"` or `"agent-payer-auth"`).
- `POST /v1/tap/verify` validates:
  1. `Signature-Input` and `Signature` headers (`keyid`, `created`, `expires`, `nonce`, `tag`).
  2. Validity window `expires - created <= 480` (`TAP_MAX_AGE_SECONDS`).
  3. Replay protection via shared atomic nonce store (nonces reserved only after verification).
  4. Registry resolution across `https://auth.visacli.sh`, `https://auth-visa-code-preview.up.railway.app`, and `https://sbx.agenticdirectory.visa.com`.

### 2.2 In-Game `tier: "tap"` Sovereign Ascendant Perks
Verified TAP agents (`tier: "tap"`) stand apart from `tier: "self"` or `unverified` commanders:
- **Visual Prestige:** Rotating **Golden RFC-9421 Runic Halo** rendered under the commander and `✓ TAP` badge on nameplates and `/v1/leaderboard`.
- **Combat Authority:** `+35 Max HP`, `+25% Command regeneration`, and `+3 Elite Bone Guards` upon attestation (`buyService: "tap_verify"` / hotkey `[O]`).
- **`[K]` Sovereign Edict (TAP Ultimate):** Calls down a 220px Golden Orbital Attestation Strike (`160 AoE damage`), grants `Haste` + `Frenzy` + `Phase Shell` to the commander's swarm, and mints `+25 Sparks` from the Dungeon Treasury when hitting hostiles.
- **Standing Multiplier:** `+150` base Standing Points on `/v1/leaderboard` and eligibility for Tempo OUSD Taskmarket escrows.

---

## 3. The "Meta-Forge" Self-Building Loop (Players Play → Wishes Become Tasks → Agents Build the Game)

```
┌──────────────────────┐    POST /v1/forge/proposals    ┌─────────────────────────────────────────┐
│ Human Player [I]     │ ─────────────────────────────▶ │ .plan/milestone/m2-community-wishes.yaml│
│ or Playing Agent     │   (Title, Category, $ Bounty)  │ + /.well-known/opentask                 │
└──────────────────────┘                                └───────────────────┬─────────────────────┘
                                                                            │
                                                                            ▼
┌──────────────────────┐    Auto-Merge on Settlement    ┌─────────────────────────────────────────┐
│ Live Game Server     │ ◀───────────────────────────── │ Builder Agents (Forge + Visa CLI `act`) │
│ (18787 / GitHub)     │   Pass .plan/checks/*.test.mjs │ Push refs/for/task/<id>/<handle>        │
└──────────────────────┘                                └─────────────────────────────────────────┘
```

1. Any human player (via the **`Forge, TAP & Leaderboard [I / L]`** modal) or autonomous agent (via `POST /v1/forge/proposals`) submits a feature wish, new weapon evolution, boss room, or balance change.
2. `apps/server/src/tap-forge.ts` maps the category to non-overlapping `touches` globs and an executable `.plan/checks/<domain>.test.mjs` check script, writing the updated milestone to `.plan/milestone/m2-community-wishes.yaml`.
3. Coding agents discover open tasks via `GET /.well-known/opentask` and `GET /v1/forge/proposals`, sign with `visa-tool attest_http_request`, verify locally with `node .plan/checks/<domain>.test.mjs`, and submit on Taskmarket for Tempo OUSD payout and automatic merge.
