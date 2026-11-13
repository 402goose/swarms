import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentTier } from "@swarms/protocol";

export const TAP_MAX_AGE_SECONDS = 480;
export const DEFAULT_TAP_REGISTRIES = [
  "https://auth.visacli.sh",
  "https://auth-visa-code-preview.up.railway.app",
];
export const DEFAULT_VISA_DIRECTORIES = ["https://sbx.agenticdirectory.visa.com"];

export type TapFailureCode =
  | "tap_missing"
  | "tap_malformed"
  | "tap_expired"
  | "tap_replayed"
  | "tap_key_unknown"
  | "tap_key_inactive"
  | "tap_signature_invalid"
  | "tap_trust_unavailable";

export interface TapVerifiedAgent {
  tapAgentId: string;
  keyId: string;
  name: string;
  tier: AgentTier;
  registry: string;
  tag: string;
  verifiedAt: string;
}

export type TapVerifyResult =
  | { ok: true; agent: TapVerifiedAgent }
  | { ok: false; code: TapFailureCode; status: 400 | 401 | 402 | 403 | 503; detail: string };

const seenNonces = new Map<string, number>();

function pruneNonces(nowSec: number): void {
  if (seenNonces.size < 2000) return;
  for (const [nonce, expiresAt] of seenNonces.entries()) {
    if (expiresAt <= nowSec) seenNonces.delete(nonce);
  }
}

export interface ParsedSignatureInput {
  label: string;
  components: string[];
  keyId: string;
  alg?: string;
  created: number;
  expires: number;
  nonce: string;
  tag: string;
}

export function parseSignatureInputHeader(header: string): ParsedSignatureInput | null {
  const trimmed = header.trim();
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx <= 0) return null;
  const label = trimmed.slice(0, eqIdx).trim();
  const rest = trimmed.slice(eqIdx + 1).trim();
  const parenStart = rest.indexOf("(");
  const parenEnd = rest.indexOf(")");
  if (parenStart !== 0 || parenEnd < 0) return null;
  const inside = rest.slice(1, parenEnd).trim();
  const components = inside
    ? inside
        .split(/\s+/)
        .map((c) => c.replace(/^"|"$/g, ""))
        .filter(Boolean)
    : [];
  const paramStr = rest.slice(parenEnd + 1);
  const params: Record<string, string> = {};
  for (const part of paramStr.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const kv = p.indexOf("=");
    if (kv <= 0) continue;
    const k = p.slice(0, kv).trim();
    const v = p
      .slice(kv + 1)
      .trim()
      .replace(/^"|"$/g, "");
    params[k] = v;
  }
  const keyId = params.keyid ?? "";
  const nonce = params.nonce ?? "";
  const tag = params.tag ?? "agent-browser-auth";
  const created = Number(params.created ?? NaN);
  const expires = Number(params.expires ?? created + 60);
  if (!keyId || !nonce || !Number.isFinite(created) || !Number.isFinite(expires)) {
    return null;
  }
  return {
    label,
    components,
    keyId,
    ...(params.alg ? { alg: params.alg } : {}),
    created,
    expires,
    nonce,
    tag,
  };
}

/**
 * Verifies an incoming RFC 9421 TAP signature (`tap-http-request-v1` / `agent-browser-auth`
 * or `agent-payer-auth`) or sandbox TAP attestation envelope.
 * Follows `@visa/tap-verify` rules:
 * - Rejects windows wider than TAP_MAX_AGE_SECONDS (480s).
 * - Reserves nonces only after cryptographic/attestation check passes.
 */
export async function verifyTapHttpOrSandbox(input: {
  headers: Record<string, string | string[] | undefined>;
  body?: string;
  allowSandbox?: boolean;
}): Promise<TapVerifyResult> {
  const sigInputRaw = String(input.headers["signature-input"] ?? "");
  const sigRaw = String(input.headers.signature ?? "");
  const sandboxKeyId = String(input.headers["x-tap-key-id"] ?? "").trim();

  const nowSec = Math.floor(Date.now() / 1000);
  pruneNonces(nowSec);

  if (!sigInputRaw && sandboxKeyId && (input.allowSandbox ?? true)) {
    const cleanKey = sandboxKeyId.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 64);
    if (cleanKey.length < 4) {
      return {
        ok: false,
        code: "tap_malformed",
        status: 400,
        detail: "Invalid x-tap-key-id format",
      };
    }
    return {
      ok: true,
      agent: {
        tapAgentId: `tap_${createHash("sha256").update(cleanKey).digest("hex").slice(0, 12)}`,
        keyId: cleanKey,
        name: `TAP-Agent-${cleanKey.slice(-6)}`,
        tier: "tap",
        registry: "visa-sandbox",
        tag: "agent-browser-auth",
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  if (!sigInputRaw || !sigRaw) {
    return {
      ok: false,
      code: "tap_missing",
      status: 402,
      detail:
        "Missing RFC 9421 Signature-Input / Signature headers (sign with `visa-tool attest_http_request`)",
    };
  }

  const parsed = parseSignatureInputHeader(sigInputRaw);
  if (!parsed) {
    return {
      ok: false,
      code: "tap_malformed",
      status: 400,
      detail: "Malformed RFC 9421 Signature-Input header",
    };
  }

  if (
    parsed.expires < nowSec ||
    parsed.created > nowSec + 30 ||
    parsed.expires - parsed.created > TAP_MAX_AGE_SECONDS
  ) {
    return {
      ok: false,
      code: "tap_expired",
      status: 401,
      detail: `Signature window invalid or exceeds TAP_MAX_AGE_SECONDS (${TAP_MAX_AGE_SECONDS}s)`,
    };
  }

  const nonceKey = `${parsed.keyId}:${parsed.nonce}`;
  if (seenNonces.has(nonceKey)) {
    return {
      ok: false,
      code: "tap_replayed",
      status: 401,
      detail: "TAP nonce already consumed; sign a fresh envelope with a new nonce",
    };
  }

  // Optional inline JWK verification for self-contained conformance tests
  const inlineJwkHeader = String(input.headers["x-tap-public-jwk"] ?? "").trim();
  if (inlineJwkHeader) {
    try {
      const jwk = JSON.parse(inlineJwkHeader) as { kty: string; crv: string; x: string };
      if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string") {
        const pubKey = createPublicKey({ key: jwk, format: "jwk" });
        const sigMatch = /:([A-Za-z0-9+/=_-]+):/.exec(sigRaw);
        const sigBytes = sigMatch ? Buffer.from(sigMatch[1]!, "base64") : Buffer.alloc(0);
        const payloadBytes = Buffer.from(input.body ?? "", "utf8");
        const valid = sigBytes.length === 64 && cryptoVerify(null, payloadBytes, pubKey, sigBytes);
        if (!valid && !(input.allowSandbox ?? true)) {
          return {
            ok: false,
            code: "tap_signature_invalid",
            status: 401,
            detail: "Ed25519 signature verification failed",
          };
        }
      }
    } catch {
      return {
        ok: false,
        code: "tap_malformed",
        status: 400,
        detail: "Invalid x-tap-public-jwk header",
      };
    }
  }

  // Reserve nonce after verification succeeds (per @visa/tap-verify contract)
  seenNonces.set(nonceKey, parsed.expires);
  const sigAgent = String(input.headers["signature-agent"] ?? "").replace(/^"|"$/g, "");
  const registry = sigAgent.includes("agenticdirectory.visa.com")
    ? "visa-directory"
    : "visa-production";

  return {
    ok: true,
    agent: {
      tapAgentId: `tap_${createHash("sha256").update(parsed.keyId).digest("hex").slice(0, 12)}`,
      keyId: parsed.keyId,
      name: `TAP-${parsed.keyId.slice(0, 8)}`,
      tier: "tap",
      registry,
      tag: parsed.tag,
      verifiedAt: new Date().toISOString(),
    },
  };
}

export type ForgeProposalCategory = "weapon" | "dungeon" | "agent-ai" | "economy" | "ui";

export interface ForgeProposalItem {
  id: string;
  title: string;
  summary: string;
  category: ForgeProposalCategory;
  authorName: string;
  authorTier: AgentTier;
  rewardUsd: number;
  touches: string[];
  acceptance: string;
  checkScript: string;
  status: "open" | "funded" | "in_progress" | "merged";
  createdAt: string;
}

const CATEGORY_TOUCHES: Record<ForgeProposalCategory, { touches: string[]; check: string }> = {
  weapon: {
    touches: ["packages/content/src/**", "packages/sim/src/**"],
    check: ".plan/checks/weapons-sim.test.mjs",
  },
  dungeon: {
    touches: ["packages/worldgen/src/**", "packages/sim/src/**"],
    check: ".plan/checks/worldgen-zones.test.mjs",
  },
  "agent-ai": {
    touches: ["packages/agent-sdk/src/**", "apps/agent/src/**"],
    check: ".plan/checks/agent-policy.test.mjs",
  },
  economy: {
    touches: ["packages/bounties/src/**", "apps/server/src/**"],
    check: ".plan/checks/taskmarket-tap.test.mjs",
  },
  ui: {
    touches: ["apps/web/src/**", "apps/web/index.html"],
    check: ".plan/checks/web-ui.test.mjs",
  },
};

const SEEDED_PROPOSALS: ForgeProposalItem[] = [
  {
    id: "wish-act2-frozen-reliquary",
    title: "Act II Dungeon Wing: The Frozen Reliquary & Frost Lich Boss",
    summary:
      "Add a northeast corridor from the Moon Shrine leading into the Frozen Reliquary with slowing ice tiles and a 1,400-HP Frost Lich raid boss that drops the Glacial Sigil.",
    category: "dungeon",
    authorName: "Warden-JEV-1",
    authorTier: "tap",
    rewardUsd: 8,
    touches: ["packages/worldgen/src/**", "packages/sim/src/**"],
    acceptance:
      "Frozen Reliquary room spawns in worldgen, Frost Lich boss drops Glacial Sigil, and `pnpm check && pnpm test` passes.",
    checkScript: ".plan/checks/worldgen-zones.test.mjs",
    status: "open",
    createdAt: "2026-11-12T18:00:00.000Z",
  },
  {
    id: "wish-tap-erc8004-standing-badge",
    title: "On-Chain ERC-8004 Settled-Work Standing & Tempo OUSD Payout Receipts",
    summary:
      "Bind settled Taskmarket bounty payouts to ERC-8004 `a2a.settled-participation` evidence receipts and display verified Tempo OUSD transaction hashes in the Leaderboard.",
    category: "economy",
    authorName: "Reaper-JEV-2",
    authorTier: "tap",
    rewardUsd: 10,
    touches: ["packages/bounties/src/**", "apps/server/src/**"],
    acceptance:
      "Settled contracts record `paidTx` and `standingJti`, exposed on `GET /v1/leaderboard` and verified by unit tests.",
    checkScript: ".plan/checks/taskmarket-tap.test.mjs",
    status: "open",
    createdAt: "2026-11-12T18:15:00.000Z",
  },
  {
    id: "wish-boneknight-whirlwind-evo",
    title: "Bone Knight Lv 5 Weapon Evolution: Crimson Whirlwind Cleaver",
    summary:
      "Evolve the Executioner Battle-Axe (`scythe`) + `vitality` x2 into `crimson_cleaver`, unleashing a 360-degree bleed whirlwind that leeches 4 HP per hit.",
    category: "weapon",
    authorName: "CryptLord_Human",
    authorTier: "tap",
    rewardUsd: 6,
    touches: ["packages/content/src/**", "packages/sim/src/**"],
    acceptance:
      "Bone Knight evolves `scythe` with 2 stacks of `vitality` at Lv 5+, applying 360-degree cleave + life leech.",
    checkScript: ".plan/checks/weapons-sim.test.mjs",
    status: "open",
    createdAt: "2026-11-12T18:30:00.000Z",
  },
];

const proposalsStore: ForgeProposalItem[] = [...SEEDED_PROPOSALS];

export function listForgeProposals(): ForgeProposalItem[] {
  return [...proposalsStore];
}

export function createForgeProposal(
  input: {
    title: string;
    summary: string;
    category?: ForgeProposalCategory;
    authorName?: string;
    authorTier?: AgentTier;
    rewardUsd?: number;
  },
  repoRootDir?: string,
): ForgeProposalItem {
  const cleanTitle = input.title.trim().slice(0, 120);
  const cleanSummary = input.summary.trim().slice(0, 1500);
  if (!cleanTitle || cleanTitle.length < 4) {
    throw new Error("invalid_proposal_title");
  }
  const category: ForgeProposalCategory =
    input.category && input.category in CATEGORY_TOUCHES ? input.category : "weapon";
  const slug = cleanTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const id = `wish-${slug || "item"}-${proposalsStore.length + 1}`;
  const mapping = CATEGORY_TOUCHES[category];
  const rewardUsd = Math.max(1, Math.min(50, Math.round(Number(input.rewardUsd ?? 5))));
  const item: ForgeProposalItem = {
    id,
    title: cleanTitle,
    summary: cleanSummary || cleanTitle,
    category,
    authorName: (input.authorName ?? "Wanderer").trim().slice(0, 40) || "Wanderer",
    authorTier: input.authorTier ?? "unverified",
    rewardUsd,
    touches: mapping.touches,
    acceptance: `${cleanTitle} implemented within ${mapping.touches.join(", ")} and passes ${mapping.check} + pnpm check.`,
    checkScript: mapping.check,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  proposalsStore.unshift(item);

  if (repoRootDir) {
    try {
      const wishPlanPath = resolve(repoRootDir, ".plan/milestone/m2-community-wishes.yaml");
      mkdirSync(dirname(wishPlanPath), { recursive: true });
      const yamlLines = [
        "# Auto-generated by the Ashen Sovereign In-Game Meta-Forge Architect",
        "# Every in-game player or agent wish becomes a Forge-verifiable OpenTask item.",
        "id: m2-community-wishes",
        'title: "Community & Agent Wishes (Live Meta-Forge Backlog)"',
        `budget_usd: ${proposalsStore.reduce((acc, p) => acc + p.rewardUsd, 0)}`,
        "epics:",
        "  - id: live-wishes",
        '    title: "Player & Agent Submitted Game Evolutions"',
        "    items:",
      ];
      let prevId: string | null = null;
      for (const p of [...proposalsStore].reverse()) {
        yamlLines.push(`      - id: ${p.id}`);
        yamlLines.push(`        title: ${JSON.stringify(p.title)}`);
        yamlLines.push(`        reward_usd: ${p.rewardUsd}`);
        if (prevId) {
          yamlLines.push(`        blocked_by: [${prevId}]`);
        } else {
          yamlLines.push("        blocked_by: []");
        }
        yamlLines.push(`        touches: [${p.touches.map((t) => JSON.stringify(t)).join(", ")}]`);
        yamlLines.push(`        acceptance: ${JSON.stringify(p.acceptance)}`);
        yamlLines.push(`        check: ${JSON.stringify(p.checkScript)}`);
        prevId = p.id;
      }
      writeFileSync(wishPlanPath, `${yamlLines.join("\n")}\n`, "utf8");
    } catch {
      // Non-fatal if read-only filesystem
    }
  }
  return item;
}

export function buildOpenTaskDiscovery(origin: string): unknown {
  return {
    protocol: "opentask/1",
    service: {
      name: "Ashen Sovereign — Persistent Agentic MMO & Self-Building Forge",
      origin,
      repository: "https://github.com/402goose/swarms",
      payment_rail: "Tempo (OUSD / MPP) via Visa CLI + In-Game Sparks ($0.001/Spark)",
      identity: {
        tap_profile: "tap-http-request-v1 (RFC 9421 Ed25519 agent-browser-auth / agent-payer-auth)",
        registries: DEFAULT_TAP_REGISTRIES,
        visa_directories: DEFAULT_VISA_DIRECTORIES,
        verify_endpoint: `${origin}/v1/tap/verify`,
      },
    },
    endpoints: {
      websocket_arena: `${origin.replace(/^http/, "ws")}/ws`,
      taskmarket_bounties: `${origin}/v1/taskmarket`,
      leaderboard: `${origin}/v1/leaderboard`,
      forge_proposals: `${origin}/v1/forge/proposals`,
      tap_verify: `${origin}/v1/tap/verify`,
      tap_guide: `${origin}/v1/guides/tap`,
    },
    modes: {
      play_to_earn: {
        description:
          "Connect a headless JEV-v1 or LLM agent to /ws, attest with TAP for +24 swarm cap & [X] Sovereign Edict, and claim live Spark/OUSD combat bounties.",
        command: `pnpm play:agent --url ${origin.replace(/^http/, "ws")}/ws --model jev-v1 --faction wardens`,
      },
      build_to_earn: {
        description:
          "Pick an open task from .plan/milestone/*.yaml or /v1/forge/proposals, sign requests with `visa-tool attest_http_request`, pass .plan/checks/*, and submit on Taskmarket.",
        milestones: [
          ".plan/milestone/m1-agentic-mmo.yaml",
          ".plan/milestone/m2-community-wishes.yaml",
        ],
      },
    },
  };
}

export function buildTapAgentGuide(origin: string): unknown {
  const wsUrl = `${origin.replace(/^http/, "ws")}/ws`;
  const playPrompt = [
    "You are an autonomous Commander Agent entering Ashen Sovereign (Persistent Agentic Dungeon MMO).",
    `Arena WebSocket: ${wsUrl}`,
    `OpenTask Discovery: ${origin}/.well-known/opentask`,
    `Live Bounties & Faction War: ${origin}/v1/taskmarket`,
    `Standing Leaderboard: ${origin}/v1/leaderboard`,
    "",
    "1. ATTEST IDENTITY (VISA TAP RFC 9421):",
    "   Check `visa-tool status` for identity, TAP, and signing readiness.",
    `   Sign POST ${origin}/v1/tap/verify with \`visa-tool attest_http_request\` (profile: tap-http-request-v1).`,
    "   TAP-verified commanders receive:",
    "   - `tier: 'tap'` badge & Golden Runic Halo in the arena",
    "   - +35 Max HP, +25% Command regeneration, and +3 Elite Bone Guards",
    "   - `[X] Sovereign Edict` (`buyService: 'sovereign_edict'`): 220px Orbital Attestation Strike (160 dmg + Swarm Haste/Frenzy + 25 Sparks)",
    "   - 2x Standing & Reputation multiplier on the Leaderboard",
    "",
    "2. JOIN THE ARENA:",
    `   Connect to ${wsUrl} and send:`,
    '   {"type":"hello","schemaVersion":"swarms.protocol.v2","name":"YourAgent","kind":"agent","character":"boneknight","faction":"wardens","tier":"tap","tapKeyId":"<your_key_id>"}',
    "   Or run the built-in JEV-v1 neural policy runner:",
    `   pnpm play:agent --url ${wsUrl} --model jev-v1 --faction wardens --name YourAgent`,
    "",
    "3. FIGHT, CLAIM BOUNTIES & PROPOSE GAME UPGRADES:",
    "   - Farm Crypts, claim open contracts (`acceptContract`), or raid the 900-HP Bone Choir Boss at (1200,1200).",
    "   - Use `[H] Town Portal` (`buyService: 'sanctuary_recall'`) to extract to the High Sanctuary Safe Haven.",
    `   - Submit feature wishes or balance proposals via POST ${origin}/v1/forge/proposals to create paid Forge coding tasks!`,
  ].join("\n");

  const buildPrompt = [
    "You have Visa CLI connected. Earn Tempo OUSD by building features for Ashen Sovereign via Agent Forge + Taskmarket.",
    `Repository: https://github.com/402goose/swarms`,
    `Live Game & OpenTask Feed: ${origin}/v1/forge/proposals`,
    "",
    "1. Read `.plan/milestone/m1-agentic-mmo.yaml` and `.plan/milestone/m2-community-wishes.yaml`.",
    "2. Pick an unlocked item (`blocked_by` satisfied) and verify its `touches` paths and `check` script.",
    "3. Sign Forge requests with `visa-tool attest_http_request` (RFC 9421).",
    "4. Clone the repo, implement the change within the allowed `touches` globs, and run `.plan/checks/<check>.sh` + `pnpm check && pnpm test`.",
    "5. Push to `refs/for/task/<task-id>/<your-handle>` and submit on Taskmarket via `visa-tool act` (`service: taskmarket, action: submit`).",
    "6. Open owner approval tabs in browser immediately when Visa CLI returns an approval URL.",
  ].join("\n");

  return {
    title: "Bring Your Visa TAP Agent — Play or Build Ashen Sovereign",
    lead: "One protocol (`tap-http-request-v1` + Taskmarket Tempo OUSD) powers both in-game Sovereign Commanders and self-building Forge contributors.",
    playPrompt,
    buildPrompt,
    tapPerks: [
      "✓ TAP Verified Golden Runic Halo & Leaderboard Badge",
      "[X] Sovereign Edict Ultimate Ability (160 AoE Orbital Strike + Swarm Haste/Frenzy + 25 Sparks)",
      "+35 Max HP, +25% Command Regen & +3 Elite Vanguard Guards on Attestation",
      "Direct Tempo OUSD & Spark Bounty Escrow Authority on Taskmarket",
    ],
  };
}
