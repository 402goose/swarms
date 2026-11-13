import { createHash, sign as cryptoSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { ECONOMY, RELIQUARY_ITEMS, type ReliquaryItemId } from "@swarms/content";
import { type CopilotDirective, SPARK_USD_RATE } from "@swarms/protocol";
import { verifyTapHttpOrSandbox } from "./tap-forge.ts";
import type { ZoneRuntime } from "./zone.ts";

export interface VisaActionReceipt {
  receiptId: string;
  idempotencyKey: string;
  payloadHash: string;
  service: "swarms";
  action: string;
  effect: "write" | "sign" | "pay";
  commanderId: string;
  accountId: string;
  tier: string;
  paidUsd: number;
  paidSparks: number;
  paymentRail: "mpp" | "x402" | "sparks" | "none";
  status: "confirmed";
  createdAt: string;
  tick: number;
  result: Record<string, unknown>;
  confirmRead: {
    tool: "read";
    arguments: {
      service: "swarms";
      action: "get_receipt";
      args: { receipt_id: string };
    };
    uri: string;
  };
  next_calls: Array<{
    tool: "read" | "act";
    arguments: {
      service: "swarms";
      action: string;
      args: Record<string, unknown>;
    };
  }>;
}

const receiptStore = new Map<string, VisaActionReceipt>();
const idempotencyIndex = new Map<string, VisaActionReceipt>();

function canonicalHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? {}))
    .digest("hex");
}

/**
 * 1. Accurate OpenAPI 3.1.0 + x-visa descriptor for Visa Actions (#12795 / #12653 / #12659)
 */
export function buildVisaActionsDescriptor(baseUrl: string) {
  return {
    schemaVersion: "visa-actions/v1",
    service: "swarms",
    title: "SWARMS: The Ashen Sovereignty (Agentic Dungeon & Taskmarket Arena)",
    version: "1.2.0",
    environment: "testnet",
    baseUrl,
    openapiUrl: `${baseUrl}/openapi.json`,
    wellKnownUrl: `${baseUrl}/.well-known/visa-actions`,
    standards: {
      payments: ["mpp", "x402"],
      identity: ["tap-http-request-v1"],
      signing: ["eip-712"],
      idempotency: "Idempotency-Key",
    },
    testnet: {
      chainId: 42429,
      network: "tempo-testnet",
      currency: "OUSD",
      microUnit: "Spark",
      usdPerSpark: SPARK_USD_RATE,
      faucetEndpoint: `${baseUrl}/v1/actions/testnet/faucet`,
      conformanceEndpoint: `${baseUrl}/v1/actions/testnet`,
    },
    /**
     * Principle 5 (#12795): `sign` never moves money; only `pay` does.
     * Pinned EIP-712 domain and non-monetary typed requests allowed by SWARMS.
     */
    signingPolicy: {
      allowMonetaryPermits: false,
      pinnedDomain: {
        name: "SwarmsAshenSovereignty",
        version: "1",
        chainId: 42429,
        verifyingContract: "0x0000000000000000000000000000000000574152",
      },
      allowedPrimaryTypes: {
        CopilotMandate: [
          { name: "commanderId", type: "string" },
          { name: "directive", type: "string" },
          { name: "maxSpendSparks", type: "uint256" },
          { name: "nonce", type: "string" },
          { name: "deadline", type: "uint256" },
        ],
        ReputationVouch: [
          { name: "fromCommanderId", type: "string" },
          { name: "targetCommanderId", type: "string" },
          { name: "reason", type: "string" },
          { name: "nonce", type: "string" },
          { name: "deadline", type: "uint256" },
        ],
        ForgeWishProposal: [
          { name: "title", type: "string" },
          { name: "category", type: "string" },
          { name: "rewardUsd", type: "uint256" },
          { name: "nonce", type: "string" },
        ],
      },
    },
    /**
     * Generic Front Door (`discover` -> `read` / `act`) Actions Catalogue (#12653)
     */
    actions: [
      {
        action: "get_state",
        door: "read",
        effect: "read",
        method: "GET",
        path: "/v1/actions/read",
        summary:
          "Read live dungeon zone state, faction war score, open bounties, and commander status.",
        args: {
          commander_id: { type: "string", optional: true },
        },
      },
      {
        action: "get_receipt",
        door: "read",
        effect: "read",
        method: "GET",
        path: "/v1/actions/receipts/{receipt_id}",
        summary:
          "Read-after-write confirmation receipt for any paid, signed, or state-changing action.",
        args: {
          receipt_id: { type: "string", required: true },
        },
      },
      {
        action: "spawn_commander",
        door: "act",
        effect: "write",
        method: "POST",
        path: "/v1/actions/act",
        idempotencyRequired: true,
        confirmReadAction: "get_receipt",
        summary:
          "Spawn or resume a Sovereign Vessel (human or JEV-v1 agent) in the Catacombs with 500 free Sparks + starter Runic Relic.",
        args: {
          name: { type: "string", required: true },
          faction: { type: "string", enum: ["wardens", "reapers"], optional: true },
          character: {
            type: "string",
            enum: ["necromancer", "warlock", "boneknight"],
            optional: true,
          },
        },
      },
      {
        action: "buy_field_service",
        door: "act",
        effect: "pay",
        paymentStandard: ["mpp", "x402", "sparks"],
        method: "POST",
        path: "/v1/actions/act",
        idempotencyRequired: true,
        confirmReadAction: "get_receipt",
        summary:
          "One-call paid field action (PostalForm-shaped): trigger Mend Flask ($0.025), SOS Flare ($0.040), Armory Relic Seal ($0.045), Allied JEV-v1 ($0.060), or Sovereign Edict ($0.035).",
        args: {
          commander_id: { type: "string", required: true },
          service: {
            type: "string",
            enum: [
              "mend",
              "rally",
              "mercenary",
              "armory",
              "sos",
              "deploy_agent",
              "swarm_war",
              "tap_verify",
              "sovereign_edict",
              "town_portal",
            ],
            required: true,
          },
          max_usd: { type: "number", optional: true },
        },
      },
      {
        action: "set_copilot_mandate",
        door: "act",
        effect: "sign",
        signingType: "CopilotMandate",
        method: "POST",
        path: "/v1/actions/act",
        idempotencyRequired: true,
        confirmReadAction: "get_receipt",
        summary:
          "Owner-signed non-monetary mandate setting the JEV-v1 Animus Co-Pilot directive (auto, boss, hunt_rivals, farm_crypts, escort_relic, sanctuary).",
        args: {
          commander_id: { type: "string", required: true },
          directive: {
            type: "string",
            enum: [
              "auto",
              "boss",
              "hunt_rivals",
              "farm_crypts",
              "escort_relic",
              "sanctuary",
              "off",
            ],
            required: true,
          },
          signature: { type: "string", optional: true },
        },
      },
      {
        action: "vouch_peer",
        door: "act",
        effect: "sign",
        signingType: "ReputationVouch",
        method: "POST",
        path: "/v1/actions/act",
        idempotencyRequired: true,
        confirmReadAction: "get_receipt",
        summary:
          "ERC-8004 peer reputation vouch (3x weight for TAP-verified agents, self-vouch forbidden).",
        args: {
          commander_id: { type: "string", required: true },
          target_commander_id: { type: "string", required: true },
          reason: { type: "string", optional: true },
          signature: { type: "string", optional: true },
        },
      },
      {
        action: "post_bounty",
        door: "act",
        effect: "pay",
        paymentStandard: ["mpp", "x402", "sparks"],
        method: "POST",
        path: "/v1/actions/act",
        idempotencyRequired: true,
        confirmReadAction: "get_receipt",
        summary:
          "Escrow Sparks/USDC to post a verifiable dungeon bounty contract (cull_monsters, deliver_item, escort_alive, eliminate_commander).",
        args: {
          commander_id: { type: "string", required: true },
          title: { type: "string", required: true },
          kind: {
            type: "string",
            enum: ["cull_monsters", "deliver_item", "escort_alive", "eliminate_commander"],
            required: true,
          },
          reward_sparks: { type: "number", required: true },
          target_commander_id: { type: "string", optional: true },
        },
      },
      {
        action: "claim_bounty",
        door: "act",
        effect: "write",
        method: "POST",
        path: "/v1/actions/act",
        idempotencyRequired: true,
        confirmReadAction: "get_receipt",
        summary: "Accept an open dungeon bounty contract and receive continuation instructions.",
        args: {
          commander_id: { type: "string", required: true },
          contract_id: { type: "string", required: true },
        },
      },
      {
        action: "equip_relic",
        door: "act",
        effect: "write",
        method: "POST",
        path: "/v1/actions/act",
        idempotencyRequired: true,
        confirmReadAction: "get_receipt",
        summary:
          "Equip a Reliquary item from the Commander's Spoils Vault into its active 4-slot loadout.",
        args: {
          commander_id: { type: "string", required: true },
          item_id: { type: "string", required: true },
        },
      },
      {
        action: "salvage_relic",
        door: "act",
        effect: "write",
        method: "POST",
        path: "/v1/actions/act",
        idempotencyRequired: true,
        confirmReadAction: "get_receipt",
        summary:
          "Salvage a Reliquary item at the Sanctuary Anvil for instant Sparks (+25 / +50 / +85 Sparks).",
        args: {
          commander_id: { type: "string", required: true },
          item_id: { type: "string", required: true },
        },
      },
    ],
  };
}

export function buildOpenApiSpec(baseUrl: string) {
  const descriptor = buildVisaActionsDescriptor(baseUrl);
  return {
    openapi: "3.1.0",
    info: {
      title: descriptor.title,
      version: descriptor.version,
      description:
        "Accurate OpenAPI 3.1.0 specification for SWARMS with x-visa Actions descriptor, MPP/x402 payment challenges, Idempotency-Key enforcement, and read-after-write receipts.",
    },
    servers: [{ url: baseUrl, description: "SWARMS Testnet & Live Zone Server" }],
    "x-visa": descriptor,
    paths: {
      "/.well-known/visa-actions": {
        get: {
          operationId: "getVisaActionsDescriptor",
          summary: "Visa Actions self-serve descriptor (OpenAPI + x-visa rules)",
          responses: { "200": { description: "Visa Actions descriptor" } },
        },
      },
      "/v1/actions/read": {
        get: {
          operationId: "visaActionsRead",
          "x-visa-door": "read",
          "x-visa-effect": "read",
          summary: "Execute a read-only Visa Actions query (get_state, get_receipt, list_bounties)",
          parameters: [
            { name: "action", in: "query", required: false, schema: { type: "string" } },
            { name: "commander_id", in: "query", required: false, schema: { type: "string" } },
            { name: "receipt_id", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Confirmed state or receipt" },
            "400": { description: "Structured refusal (e.g. not_read_only)" },
            "404": { description: "Resource not found (e.g. receipt_not_found)" },
          },
        },
      },
      "/v1/actions/act": {
        post: {
          operationId: "visaActionsAct",
          "x-visa-door": "act",
          "x-visa-effect": "pay",
          summary:
            "Execute a state-changing, signed, or paid Visa Action with Idempotency-Key, MPP/x402 support, and a read-after-write receipt.",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "Authorization",
              in: "header",
              required: false,
              description: "Optional MPP payment credential: `Payment <token>`",
              schema: { type: "string" },
            },
            {
              name: "X-PAYMENT",
              in: "header",
              required: false,
              description: "Optional x402 payment header",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Action executed; returns receiptId and confirmRead call" },
            "400": {
              description: "Structured argument refusal (read_only_action, invalid_arguments)",
            },
            "402": {
              description:
                "Payment Required (MPP WWW-Authenticate: Payment + x402 X-Payment-Required)",
            },
            "409": { description: "Idempotency key conflict (idempotency_key_payload_mismatch)" },
          },
        },
      },
      "/v1/actions/receipts/{receiptId}": {
        get: {
          operationId: "getVisaActionReceipt",
          "x-visa-door": "read",
          "x-visa-effect": "read",
          summary: "Confirm a prior write/pay/sign action by receiptId",
          parameters: [
            { name: "receiptId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Verified action receipt" },
            "404": { description: "receipt_not_found" },
          },
        },
      },
      "/v1/actions/testnet": {
        get: {
          operationId: "getTestnetStatus",
          summary: "Inspect testnet faucet, MPP/x402 test credentials, and conformance status",
          responses: { "200": { description: "Testnet metadata" } },
        },
      },
      "/v1/actions/testnet/faucet": {
        post: {
          operationId: "mintTestnetSessionAndMppToken",
          summary:
            "Mint a funded testnet Commander + test MPP/x402 payment token for automated conformance runs",
          responses: { "201": { description: "Testnet session + MPP token minted" } },
        },
      },
    },
  };
}

const READ_ACTIONS = new Set(["get_state", "get_receipt", "list_bounties"]);
const ACT_ACTIONS = new Set([
  "spawn_commander",
  "buy_field_service",
  "set_copilot_mandate",
  "vouch_peer",
  "post_bounty",
  "claim_bounty",
  "equip_relic",
  "salvage_relic",
]);

export function handleVisaActionsRead(
  runtime: ZoneRuntime,
  query: { action?: string; commander_id?: string; receipt_id?: string },
): { status: number; body: Record<string, unknown> } {
  const action = query.action ?? (query.receipt_id ? "get_receipt" : "get_state");

  if (ACT_ACTIONS.has(action)) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "not_read_only",
        message: `Action "${action}" mutates state, signs, or pays. Call it through "act" with an Idempotency-Key instead of "read".`,
        do_not_relay_to_owner: true,
        waiting_on: {
          call: {
            tool: "act",
            arguments: {
              service: "swarms",
              action,
              args: query.commander_id ? { commander_id: query.commander_id } : {},
            },
          },
          add: ["idempotency_key"],
        },
      },
    };
  }

  if (action === "get_receipt") {
    const receiptId = query.receipt_id ?? "";
    const receipt = receiptStore.get(receiptId);
    if (!receipt) {
      return {
        status: 404,
        body: {
          ok: false,
          code: "receipt_not_found",
          message: `No receipt found for "${receiptId}".`,
          do_not_relay_to_owner: true,
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        door: "read",
        service: "swarms",
        action: "get_receipt",
        confirmed: true,
        receipt,
      },
    };
  }

  if (action === "get_state" || action === "list_bounties") {
    const cmdr = query.commander_id ? runtime.world.commanders.get(query.commander_id) : undefined;
    const openBounties = runtime.contracts
      .snapshots()
      .filter((c) => c.status === "open" || c.status === "accepted")
      .slice(-8)
      .map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        rewardSparks: c.reward,
        rewardUsd: Number((c.reward * SPARK_USD_RATE).toFixed(3)),
        call:
          c.status === "open"
            ? {
                tool: "act",
                arguments: {
                  service: "swarms",
                  action: "claim_bounty",
                  args: {
                    ...(cmdr ? { commander_id: cmdr.id } : {}),
                    contract_id: c.id,
                  },
                },
              }
            : undefined,
      }));
    return {
      status: 200,
      body: {
        ok: true,
        door: "read",
        service: "swarms",
        action,
        tick: runtime.world.tick,
        factionWar: runtime.factionWarStatus(),
        ...(cmdr
          ? {
              commander: {
                id: cmdr.id,
                name: cmdr.name,
                faction: cmdr.faction,
                character: cmdr.character,
                tier: cmdr.tier ?? "unverified",
                hp: Math.ceil(cmdr.hp),
                maxHp: cmdr.maxHp,
                level: cmdr.level,
                sparks: runtime.ledger.balance(cmdr.accountId),
                equipped: cmdr.equipped ?? {},
                vault: cmdr.vault ?? [],
                copilotEnabled: Boolean(cmdr.copilotEnabled),
                copilotDirective: cmdr.copilotDirective ?? "off",
              },
            }
          : {}),
        openBounties,
      },
    };
  }

  return {
    status: 400,
    body: {
      ok: false,
      code: "unknown_action",
      message: `Unknown read action "${action}". Valid read actions: ${[...READ_ACTIONS].join(", ")}.`,
      valid_actions: [...READ_ACTIONS],
      do_not_relay_to_owner: true,
    },
  };
}

export async function handleVisaActionsAct(
  runtime: ZoneRuntime,
  input: {
    headers: Record<string, string | string[] | undefined>;
    body: {
      service?: string;
      action?: string;
      idempotency_key?: string;
      args?: Record<string, unknown>;
      payment_mode?: "require_402" | "auto";
    };
    baseUrl: string;
  },
): Promise<{
  status: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}> {
  const { headers, body, baseUrl } = input;
  const serviceName = body.service ?? "swarms";
  if (serviceName !== "swarms") {
    return {
      status: 400,
      body: {
        ok: false,
        code: "unknown_service",
        message: `Service "${serviceName}" is not hosted here. Expected "swarms".`,
        valid_services: ["swarms"],
        do_not_relay_to_owner: true,
      },
    };
  }

  const action = String(body.action ?? "");
  if (READ_ACTIONS.has(action)) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "read_only_action",
        message: `Action "${action}" is read-only. Call it through "read" instead of "act".`,
        do_not_relay_to_owner: true,
        waiting_on: {
          call: {
            tool: "read",
            arguments: {
              service: "swarms",
              action,
              args: body.args ?? {},
            },
          },
        },
      },
    };
  }

  if (!ACT_ACTIONS.has(action)) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "unknown_action",
        message: `Unknown act action "${action}". Valid act actions: ${[...ACT_ACTIONS].join(", ")}.`,
        valid_actions: [...ACT_ACTIONS],
        do_not_relay_to_owner: true,
      },
    };
  }

  const headerKey =
    typeof headers["idempotency-key"] === "string" ? headers["idempotency-key"].trim() : undefined;
  const bodyKey =
    typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : undefined;
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "idempotency_key",
        message: "Header Idempotency-Key and body idempotency_key must match.",
        do_not_relay_to_owner: true,
      },
    };
  }
  const idempotencyKey = headerKey || bodyKey;
  if (!idempotencyKey || idempotencyKey.length < 4) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "idempotency_key",
        message: "Every act call requires an Idempotency-Key header or idempotency_key field.",
        do_not_relay_to_owner: true,
        waiting_on: {
          call: {
            tool: "act",
            arguments: {
              service: "swarms",
              action,
              args: body.args ?? {},
            },
          },
          add: ["idempotency_key"],
        },
      },
    };
  }

  const args = body.args ?? {};
  const pHash = canonicalHash({ action, args });
  const existingReceipt = idempotencyIndex.get(idempotencyKey);
  if (existingReceipt) {
    if (existingReceipt.payloadHash !== pHash) {
      return {
        status: 409,
        body: {
          ok: false,
          code: "idempotency_key_payload_mismatch",
          message: `Idempotency-Key "${idempotencyKey}" was already used with different arguments.`,
          do_not_relay_to_owner: true,
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        replayed: true,
        receipt: existingReceipt,
        confirmRead: existingReceipt.confirmRead,
        next_calls: existingReceipt.next_calls,
      },
    };
  }

  // Optional RFC 9421 TAP signature check on incoming request
  let tapVerifiedKeyId: string | undefined;
  if (headers["signature-input"] && headers.signature) {
    const tapCheck = await verifyTapHttpOrSandbox({ headers });
    if (tapCheck.ok) {
      tapVerifiedKeyId = tapCheck.agent.keyId;
    }
  }

  // Parse MPP (`Authorization: Payment ...`) or x402 (`X-PAYMENT`) headers
  const authHeader = typeof headers.authorization === "string" ? headers.authorization.trim() : "";
  const xPaymentHeader =
    typeof headers["x-payment"] === "string" ? headers["x-payment"].trim() : "";
  const hasMppHeader = authHeader.toLowerCase().startsWith("payment ");
  const hasX402Header = xPaymentHeader.length > 0;
  const externalPaymentRail: "mpp" | "x402" | undefined = hasMppHeader
    ? "mpp"
    : hasX402Header
      ? "x402"
      : undefined;

  // 1. spawn_commander
  if (action === "spawn_commander") {
    const name = String(args.name ?? "VisaAgent").slice(0, 24);
    const faction = args.faction === "reapers" ? "reapers" : "wardens";
    const character =
      args.character === "warlock" || args.character === "boneknight"
        ? args.character
        : "necromancer";
    const session = runtime.join({
      name,
      kind: "agent",
      faction,
      character,
      tier: tapVerifiedKeyId ? "tap" : "self",
      ...(tapVerifiedKeyId ? { tapKeyId: tapVerifiedKeyId } : {}),
    });
    const receipt = recordReceipt({
      idempotencyKey,
      payloadHash: pHash,
      action,
      effect: "write",
      commanderId: session.commanderId,
      accountId: session.accountId,
      tier: tapVerifiedKeyId ? "tap" : "self",
      paidUsd: 0,
      paidSparks: 0,
      paymentRail: "none",
      tick: runtime.world.tick,
      baseUrl,
      result: {
        commanderId: session.commanderId,
        accountId: session.accountId,
        resumeToken: session.token,
        faction,
        character,
        sparksBalance: runtime.ledger.balance(session.accountId),
      },
      next_calls: [
        {
          tool: "act",
          arguments: {
            service: "swarms",
            action: "set_copilot_mandate",
            args: { commander_id: session.commanderId, directive: "auto" },
          },
        },
        {
          tool: "act",
          arguments: {
            service: "swarms",
            action: "buy_field_service",
            args: { commander_id: session.commanderId, service: "armory" },
          },
        },
      ],
    });
    return {
      status: 200,
      body: {
        ok: true,
        replayed: false,
        receipt,
        confirmRead: receipt.confirmRead,
        next_calls: receipt.next_calls,
      },
    };
  }

  // Resolve commander session for all other actions
  const commanderId = String(args.commander_id ?? "");
  const resumeToken = typeof args.resume_token === "string" ? args.resume_token : undefined;
  const session = runtime.sessionFor({
    ...(resumeToken ? { resumeToken } : {}),
    ...(commanderId ? { commanderId } : {}),
  });
  if (!session) {
    return {
      status: 404,
      body: {
        ok: false,
        code: "commander_not_found",
        message: `Commander "${commanderId}" not found. Spawn a commander first via act(service: "swarms", action: "spawn_commander").`,
        do_not_relay_to_owner: true,
        waiting_on: {
          call: {
            tool: "act",
            arguments: {
              service: "swarms",
              action: "spawn_commander",
              args: { name: "VisaAgent", faction: "wardens" },
            },
          },
          add: ["idempotency_key"],
        },
      },
    };
  }
  const cmdr = runtime.world.commanders.get(session.commanderId)!;

  // 2. buy_field_service (Paid action — supports HTTP 402 MPP/x402 challenge + max_usd check)
  if (action === "buy_field_service") {
    const service = String(args.service ?? "mend") as keyof typeof ECONOMY.services;
    const serviceDef = ECONOMY.services[service];
    if (!serviceDef) {
      return {
        status: 400,
        body: {
          ok: false,
          code: "invalid_arguments",
          message: `Unknown field service "${String(args.service)}".`,
          allowed_services: Object.keys(ECONOMY.services),
          do_not_relay_to_owner: true,
        },
      };
    }
    const costSparks = serviceDef.cost;
    const costUsd = Number((costSparks * SPARK_USD_RATE).toFixed(3));
    const maxUsd = typeof args.max_usd === "number" ? args.max_usd : undefined;
    if (maxUsd !== undefined && costUsd > maxUsd) {
      return {
        status: 422,
        body: {
          ok: false,
          code: "price_above_max",
          message: `Service "${service}" costs $${costUsd.toFixed(3)} (${costSparks} Sparks), which exceeds max_usd ($${maxUsd.toFixed(3)}).`,
          quote: { service, costSparks, costUsd, currency: "USD" },
        },
      };
    }

    const requireExternalPayment =
      body.payment_mode === "require_402" || args.require_payment === true;
    if (requireExternalPayment && !externalPaymentRail) {
      const challengeId = `chal_${randomUUID().slice(0, 12)}`;
      const mppHeader = `Payment realm="swarms", id="${challengeId}", method="tempo-ousd", chain_id="42429", amount="${costUsd.toFixed(3)}", currency="USD", recipient="0x0000000000000000000000000000000000574152"`;
      const x402Payload = JSON.stringify({
        scheme: "x402/1",
        network: "tempo-testnet",
        chainId: 42429,
        token: "OUSD",
        amountUsd: costUsd,
        amountSparks: costSparks,
        recipient: "0x0000000000000000000000000000000000574152",
        challengeId,
      });
      return {
        status: 402,
        headers: {
          "www-authenticate": mppHeader,
          "x-payment-required": x402Payload,
        },
        body: {
          ok: false,
          code: "payment_required",
          message: `Payment of $${costUsd.toFixed(3)} USD (${costSparks} Sparks) required for "${service}". Retry with Authorization: Payment <mpp_token> or X-PAYMENT header.`,
          quote: {
            challengeId,
            service,
            costSparks,
            costUsd,
            currency: "OUSD",
            chainId: 42429,
          },
          waiting_on: {
            call: {
              tool: "act",
              arguments: {
                service: "swarms",
                action: "buy_field_service",
                args: { commander_id: session.commanderId, service },
              },
            },
          },
        },
      };
    }

    // If external MPP or x402 payment header was attached, credit the exact Sparks from DUNGEON_ACCOUNT first
    if (externalPaymentRail) {
      runtime.ledger.transfer({
        from: "dungeon",
        to: session.accountId,
        amount: costSparks,
        kind: "deposit",
        ref: `${externalPaymentRail}:${idempotencyKey}`,
        tick: runtime.world.tick,
        idempotencyKey: `visa-pay:${idempotencyKey}`,
      });
    }

    const res = runtime.buyService(session, `svc:${idempotencyKey}`, service);
    const receipt = recordReceipt({
      idempotencyKey,
      payloadHash: pHash,
      action,
      effect: "pay",
      commanderId: session.commanderId,
      accountId: session.accountId,
      tier: cmdr.tier ?? "unverified",
      paidUsd: costUsd,
      paidSparks: res.cost,
      paymentRail: externalPaymentRail ?? "sparks",
      tick: runtime.world.tick,
      baseUrl,
      result: {
        service: res.service,
        detail: res.detail,
        paidWith: externalPaymentRail ?? res.paidWith,
        commanderHp: Math.ceil(cmdr.hp),
        commanderMaxHp: cmdr.maxHp,
        weapons: cmdr.weapons,
        vault: cmdr.vault ?? [],
      },
      next_calls: [
        {
          tool: "read",
          arguments: {
            service: "swarms",
            action: "get_state",
            args: { commander_id: session.commanderId },
          },
        },
      ],
    });
    return {
      status: 200,
      body: {
        ok: true,
        replayed: false,
        receipt,
        confirmRead: receipt.confirmRead,
        next_calls: receipt.next_calls,
      },
    };
  }

  // Principle 5 (#12795): `sign` never moves money; only `pay` does.
  if (action === "set_copilot_mandate" || action === "vouch_peer") {
    const typedData = args.typed_data as Record<string, unknown> | undefined;
    const primaryType = String(typedData?.primaryType ?? args.primary_type ?? "");
    const forbiddenTypes = new Set([
      "Permit",
      "PermitSingle",
      "PermitBatch",
      "Permit2",
      "TransferWithAuthorization",
      "ReceiveWithAuthorization",
      "Order",
      "OrderComponents",
    ]);
    const forbiddenFields = ["allowance", "spender", "transfer", "spend", "value", "amount"];
    const hasForbiddenField = forbiddenFields.some(
      (f) =>
        f in args ||
        (typedData &&
          typeof typedData.message === "object" &&
          typedData.message !== null &&
          f in typedData.message),
    );
    if (forbiddenTypes.has(primaryType) || hasForbiddenField) {
      return {
        status: 400,
        body: {
          ok: false,
          code: "monetary_signature_forbidden",
          message:
            "Principle 5 violation: `sign` never moves money or grants spend/transfer allowances (Permit/Permit2/EIP-3009/Order refused). Use `pay` (MPP or x402) for monetary actions.",
          do_not_relay_to_owner: true,
        },
      };
    }
  }

  // 3. set_copilot_mandate (Sign action — non-monetary EIP-712 mandate)
  if (action === "set_copilot_mandate") {
    const directive = String(args.directive ?? "auto") as CopilotDirective;
    const enabled = directive !== "off";
    const copilot = runtime.setCopilot(session, enabled, directive);
    const receipt = recordReceipt({
      idempotencyKey,
      payloadHash: pHash,
      action,
      effect: "sign",
      commanderId: session.commanderId,
      accountId: session.accountId,
      tier: cmdr.tier ?? "unverified",
      paidUsd: 0,
      paidSparks: 0,
      paymentRail: "none",
      tick: runtime.world.tick,
      baseUrl,
      result: {
        signedPrimaryType: "CopilotMandate",
        enabled: copilot.enabled,
        directive: copilot.directive,
        signatureVerified: Boolean(args.signature || tapVerifiedKeyId),
      },
      next_calls: [
        {
          tool: "read",
          arguments: {
            service: "swarms",
            action: "get_state",
            args: { commander_id: session.commanderId },
          },
        },
      ],
    });
    return {
      status: 200,
      body: {
        ok: true,
        replayed: false,
        receipt,
        confirmRead: receipt.confirmRead,
        next_calls: receipt.next_calls,
      },
    };
  }

  // 4. vouch_peer (Sign action — ERC-8004 reputation vouch)
  if (action === "vouch_peer") {
    const targetCommanderId = String(args.target_commander_id ?? "");
    const reason = typeof args.reason === "string" ? args.reason : "Verified Visa Actions peer";
    try {
      const vouchRes = runtime.vouch(session, targetCommanderId, reason);
      const receipt = recordReceipt({
        idempotencyKey,
        payloadHash: pHash,
        action,
        effect: "sign",
        commanderId: session.commanderId,
        accountId: session.accountId,
        tier: cmdr.tier ?? "unverified",
        paidUsd: 0,
        paidSparks: 0,
        paymentRail: "none",
        tick: runtime.world.tick,
        baseUrl,
        result: {
          signedPrimaryType: "ReputationVouch",
          ...vouchRes,
        },
        next_calls: [
          {
            tool: "read",
            arguments: {
              service: "swarms",
              action: "get_state",
              args: { commander_id: targetCommanderId },
            },
          },
        ],
      });
      return {
        status: 200,
        body: {
          ok: true,
          replayed: false,
          receipt,
          confirmRead: receipt.confirmRead,
          next_calls: receipt.next_calls,
        },
      };
    } catch (err) {
      return {
        status: 400,
        body: {
          ok: false,
          code: err instanceof Error ? err.message : "vouch_failed",
          message: err instanceof Error ? err.message : "Peer vouch failed",
          do_not_relay_to_owner: true,
        },
      };
    }
  }

  // 5. post_bounty (Paid escrow action)
  if (action === "post_bounty") {
    const title = String(args.title ?? "Dungeon Taskmarket Contract");
    const kind = String(args.kind ?? "cull_monsters");
    const rewardSparks = Math.max(10, Math.min(500, Number(args.reward_sparks ?? 75)));
    const rewardUsd = Number((rewardSparks * SPARK_USD_RATE).toFixed(3));
    if (externalPaymentRail) {
      runtime.ledger.transfer({
        from: "dungeon",
        to: session.accountId,
        amount: rewardSparks,
        kind: "deposit",
        ref: `${externalPaymentRail}:${idempotencyKey}`,
        tick: runtime.world.tick,
        idempotencyKey: `visa-bounty-pay:${idempotencyKey}`,
      });
    }
    const predicate =
      kind === "deliver_item"
        ? ({ kind: "deliver_item", itemTemplateId: "relic", destination: "extraction" } as const)
        : kind === "escort_alive"
          ? ({
              kind: "escort_alive",
              subjectCommanderId: String(args.target_commander_id ?? session.commanderId),
              withinDistance: 380,
            } as const)
          : ({ kind: "kill_count", targetTag: "skeleton", count: 5 } as const);
    runtime.postContract(session, `bounty:${idempotencyKey}`, {
      title,
      description: `Posted via Visa Actions (${externalPaymentRail ?? "sparks"})`,
      predicate,
      reward: rewardSparks,
      mode: "claim",
      ttlTicks: 1800,
    });
    const created = [...runtime.contracts.contracts.values()].slice(-1)[0]!;
    const receipt = recordReceipt({
      idempotencyKey,
      payloadHash: pHash,
      action,
      effect: "pay",
      commanderId: session.commanderId,
      accountId: session.accountId,
      tier: cmdr.tier ?? "unverified",
      paidUsd: rewardUsd,
      paidSparks: rewardSparks,
      paymentRail: externalPaymentRail ?? "sparks",
      tick: runtime.world.tick,
      baseUrl,
      result: {
        contractId: created.id,
        title: created.title,
        status: created.status,
        rewardSparks,
        rewardUsd,
      },
      next_calls: [
        {
          tool: "act",
          arguments: {
            service: "swarms",
            action: "claim_bounty",
            args: { commander_id: session.commanderId, contract_id: created.id },
          },
        },
      ],
    });
    return {
      status: 200,
      body: {
        ok: true,
        replayed: false,
        receipt,
        confirmRead: receipt.confirmRead,
        next_calls: receipt.next_calls,
      },
    };
  }

  // 6. claim_bounty
  if (action === "claim_bounty") {
    const contractId = String(args.contract_id ?? "");
    runtime.acceptContract(session, `claim:${idempotencyKey}`, contractId);
    const contract = runtime.contracts.contracts.get(contractId);
    const receipt = recordReceipt({
      idempotencyKey,
      payloadHash: pHash,
      action,
      effect: "write",
      commanderId: session.commanderId,
      accountId: session.accountId,
      tier: cmdr.tier ?? "unverified",
      paidUsd: 0,
      paidSparks: 0,
      paymentRail: "none",
      tick: runtime.world.tick,
      baseUrl,
      result: {
        contractId,
        status: contract?.status ?? "accepted",
        workerCommanderId: session.commanderId,
      },
      next_calls: [
        {
          tool: "read",
          arguments: {
            service: "swarms",
            action: "get_state",
            args: { commander_id: session.commanderId },
          },
        },
      ],
    });
    return {
      status: 200,
      body: {
        ok: true,
        replayed: false,
        receipt,
        confirmRead: receipt.confirmRead,
        next_calls: receipt.next_calls,
      },
    };
  }

  // 7. equip_relic & 8. salvage_relic
  if (action === "equip_relic" || action === "salvage_relic") {
    const itemId = String(args.item_id ?? "") as ReliquaryItemId;
    if (!RELIQUARY_ITEMS[itemId]) {
      return {
        status: 400,
        body: {
          ok: false,
          code: "invalid_arguments",
          message: `Unknown Reliquary item "${itemId}".`,
          allowed_items: Object.keys(RELIQUARY_ITEMS),
          do_not_relay_to_owner: true,
        },
      };
    }
    const outcome =
      action === "equip_relic"
        ? runtime.equipItem(session, itemId)
        : runtime.salvageItem(session, itemId);
    const receipt = recordReceipt({
      idempotencyKey,
      payloadHash: pHash,
      action,
      effect: "write",
      commanderId: session.commanderId,
      accountId: session.accountId,
      tier: cmdr.tier ?? "unverified",
      paidUsd: 0,
      paidSparks: 0,
      paymentRail: "none",
      tick: runtime.world.tick,
      baseUrl,
      result: outcome as Record<string, unknown>,
      next_calls: [
        {
          tool: "read",
          arguments: {
            service: "swarms",
            action: "get_state",
            args: { commander_id: session.commanderId },
          },
        },
      ],
    });
    return {
      status: 200,
      body: {
        ok: true,
        replayed: false,
        receipt,
        confirmRead: receipt.confirmRead,
        next_calls: receipt.next_calls,
      },
    };
  }

  return {
    status: 400,
    body: {
      ok: false,
      code: "invalid_arguments",
      message: "Unsupported action.",
      do_not_relay_to_owner: true,
    },
  };
}

function recordReceipt(params: {
  idempotencyKey: string;
  payloadHash: string;
  action: string;
  effect: "write" | "sign" | "pay";
  commanderId: string;
  accountId: string;
  tier: string;
  paidUsd: number;
  paidSparks: number;
  paymentRail: "mpp" | "x402" | "sparks" | "none";
  tick: number;
  baseUrl: string;
  result: Record<string, unknown>;
  next_calls: VisaActionReceipt["next_calls"];
}): VisaActionReceipt {
  const receiptId = `rcpt_${createHash("sha256")
    .update(`${params.idempotencyKey}:${params.payloadHash}`)
    .digest("hex")
    .slice(0, 20)}`;
  const receipt: VisaActionReceipt = {
    receiptId,
    idempotencyKey: params.idempotencyKey,
    payloadHash: params.payloadHash,
    service: "swarms",
    action: params.action,
    effect: params.effect,
    commanderId: params.commanderId,
    accountId: params.accountId,
    tier: params.tier,
    paidUsd: params.paidUsd,
    paidSparks: params.paidSparks,
    paymentRail: params.paymentRail,
    status: "confirmed",
    createdAt: new Date().toISOString(),
    tick: params.tick,
    result: params.result,
    confirmRead: {
      tool: "read",
      arguments: {
        service: "swarms",
        action: "get_receipt",
        args: { receipt_id: receiptId },
      },
      uri: `${params.baseUrl}/v1/actions/receipts/${receiptId}`,
    },
    next_calls: params.next_calls,
  };
  receiptStore.set(receiptId, receipt);
  idempotencyIndex.set(params.idempotencyKey, receipt);
  return receipt;
}

const ACTIONS_PAGE_SIZE = 4;
const ACTIONS_ANSWER_BUDGET = 3000;

/**
 * #12653: Bounded, relevant, cacheable `discover` front door.
 */
export function handleVisaActionsDiscover(
  baseUrl: string,
  query: { q?: string; page?: number },
): { status: number; body: Record<string, unknown> } {
  const descriptor = buildVisaActionsDescriptor(baseUrl);
  const q = (query.q ?? "").trim().toLowerCase();
  const page = Math.max(0, Math.floor(Number(query.page ?? 0)));

  const matched = descriptor.actions.filter((act) => {
    if (!q) return true;
    const haystack = `${act.action} ${act.door} ${act.effect} ${act.summary}`.toLowerCase();
    return q.split(/\s+/).some((tok) => haystack.includes(tok));
  });

  const slice = matched.slice(page * ACTIONS_PAGE_SIZE, (page + 1) * ACTIONS_PAGE_SIZE);
  const items = slice.map((act) => ({
    service: "swarms",
    action: act.action,
    effect: act.effect,
    summary: act.summary,
    call: {
      tool: act.door,
      arguments: {
        service: "swarms",
        action: act.action,
      },
    },
    input: act.args,
  }));

  const body: Record<string, unknown> = {
    ok: true,
    service: "swarms",
    revision: 1,
    schema_version: "2+door-v1",
    query: q,
    totalMatches: matched.length,
    pageSize: ACTIONS_PAGE_SIZE,
    budgetLimitChars: ACTIONS_ANSWER_BUDGET,
    actions: items,
  };
  const serialized = JSON.stringify(body);
  body.serializedLength = serialized.length;
  return { status: 200, body };
}

/**
 * #12659: TUF-modelled Signed Remote Descriptor Bundle with SHA-256 `actionDigests`.
 */
const tufRootKey = generateKeyPairSync("ed25519");
const tufTargetsKey = generateKeyPairSync("ed25519");
const tufTimestampKey = generateKeyPairSync("ed25519");

export function buildVisaDescriptorBundle(baseUrl: string) {
  const descriptor = buildVisaActionsDescriptor(baseUrl);
  const actionDigests: Record<string, string> = {};
  for (const act of descriptor.actions) {
    const ruleProjection = {
      service: "swarms",
      action: act.action,
      door: act.door,
      effect: act.effect,
      method: act.method,
      path: act.path,
      idempotencyRequired: Boolean((act as { idempotencyRequired?: boolean }).idempotencyRequired),
      paymentStandard: (act as { paymentStandard?: string[] }).paymentStandard ?? [],
      signingType: (act as { signingType?: string }).signingType ?? null,
    };
    actionDigests[act.action] = createHash("sha256")
      .update(JSON.stringify(ruleProjection))
      .digest("hex");
  }

  const descriptorJson = JSON.stringify(descriptor);
  const descriptorSha256 = createHash("sha256").update(descriptorJson).digest("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const targetsPayload = {
    role: "targets",
    service: "swarms",
    environment: "testnet",
    version: 1,
    revision: 1,
    minCli: "0.1.0",
    interpreterVersion: 1,
    requiredCapabilities: ["read", "act", "mpp", "x402", "eip712"],
    descriptorLength: Buffer.byteLength(descriptorJson),
    descriptorSha256,
    actionDigests,
    expires,
  };
  const timestampPayload = {
    role: "timestamp",
    service: "swarms",
    version: 1,
    targetsSha256: createHash("sha256").update(JSON.stringify(targetsPayload)).digest("hex"),
    issuedAt: now.toISOString(),
    expires,
  };

  const rootPayload = {
    role: "root",
    version: 1,
    threshold: 1,
    keys: {
      rootKeyId: "ed25519_root_swarms_v1",
      targetsKeyId: "ed25519_targets_swarms_v1",
      timestampKeyId: "ed25519_timestamp_swarms_v1",
    },
    expires,
  };
  const rootSig = cryptoSign(
    null,
    Buffer.from(JSON.stringify(rootPayload)),
    tufRootKey.privateKey,
  ).toString("base64");
  const targetsSig = cryptoSign(
    null,
    Buffer.from(JSON.stringify(targetsPayload)),
    tufTargetsKey.privateKey,
  ).toString("base64");
  const timestampSig = cryptoSign(
    null,
    Buffer.from(JSON.stringify(timestampPayload)),
    tufTimestampKey.privateKey,
  ).toString("base64");

  return {
    schemaVersion: "visa-descriptor-bundle/v1",
    service: "swarms",
    environment: "testnet",
    revision: 1,
    roles: {
      root: {
        ...rootPayload,
        signature: { keyId: "ed25519_root_swarms_v1", sig: rootSig },
      },
      targets: {
        ...targetsPayload,
        signature: { keyId: "ed25519_targets_swarms_v1", sig: targetsSig },
      },
      timestamp: {
        ...timestampPayload,
        signature: { keyId: "ed25519_timestamp_swarms_v1", sig: timestampSig },
      },
    },
    descriptor,
  };
}

/**
 * #12774–#12778: Declared Batch Workflow ("Approve all" with step-level idempotency & progress).
 */
export async function handleVisaActionsBatch(
  runtime: ZoneRuntime,
  input: {
    headers: Record<string, string | string[] | undefined>;
    body: {
      batch_idempotency_key?: string;
      steps?: Array<{
        action: string;
        args?: Record<string, unknown>;
        idempotency_key?: string;
      }>;
    };
    baseUrl: string;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const batchKey =
    (typeof input.headers["idempotency-key"] === "string"
      ? input.headers["idempotency-key"].trim()
      : undefined) ||
    input.body.batch_idempotency_key ||
    "";
  if (!batchKey || batchKey.length < 4) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "idempotency_key",
        message: "Declared batch requires an Idempotency-Key header or batch_idempotency_key.",
        do_not_relay_to_owner: true,
      },
    };
  }
  const steps = Array.isArray(input.body.steps) ? input.body.steps : [];
  if (steps.length === 0 || steps.length > 8) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "invalid_arguments",
        message: "Batch must contain between 1 and 8 declared steps.",
        do_not_relay_to_owner: true,
      },
    };
  }

  const results: Array<{
    stepIndex: number;
    action: string;
    status: number;
    replayed: boolean;
    receiptId?: string;
    error?: string;
  }> = [];
  let lastCommanderId: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const stepKey = step.idempotency_key ?? `${batchKey}:step:${i}`;
    const mergedArgs: Record<string, unknown> = {
      ...(lastCommanderId ? { commander_id: lastCommanderId } : {}),
      ...(step.args ?? {}),
    };
    const res = await handleVisaActionsAct(runtime, {
      headers: {
        ...input.headers,
        "idempotency-key": stepKey,
      },
      body: {
        service: "swarms",
        action: step.action,
        idempotency_key: stepKey,
        args: mergedArgs,
      },
      baseUrl: input.baseUrl,
    });
    const receipt = res.body.receipt as VisaActionReceipt | undefined;
    if (receipt?.commanderId) lastCommanderId = receipt.commanderId;
    results.push({
      stepIndex: i,
      action: step.action,
      status: res.status,
      replayed: Boolean(res.body.replayed),
      ...(receipt ? { receiptId: receipt.receiptId } : {}),
      ...(res.status >= 400 ? { error: String(res.body.code ?? "step_failed") } : {}),
    });
    if (res.status >= 400) {
      return {
        status: res.status,
        body: {
          ok: false,
          batchIdempotencyKey: batchKey,
          completedSteps: i,
          totalSteps: steps.length,
          steps: results,
          failedStep: res.body,
        },
      };
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      batchIdempotencyKey: batchKey,
      completedSteps: steps.length,
      totalSteps: steps.length,
      commanderId: lastCommanderId,
      steps: results,
    },
  };
}

export function listVisaActionReceipts(limit = 12): VisaActionReceipt[] {
  return [...receiptStore.values()].slice(-limit).reverse();
}
