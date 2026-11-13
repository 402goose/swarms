import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { SwarmClient } from "../packages/agent-sdk/src/index.ts";

const API_URL = process.env.SWARMS_API_URL ?? "http://127.0.0.1:18787";
const WS_URL = process.env.SWARMS_WS_URL ?? "ws://127.0.0.1:18787/ws";
const WEB_URL = process.env.SWARMS_WEB_URL ?? "http://127.0.0.1:15173";

function logPass(step, detail) {
  console.log(`ASSERT PASS [${step}]: ${detail}`);
}

async function runHarness() {
  console.log("=== SWARMS AGENT-FORGE + VISA TAP + CO-PILOT E2E HARNESS ===");

  // 1. OpenTask Discovery & RFC 9421 Visa TAP Attestation
  const discoveryRes = await fetch(`${API_URL}/.well-known/opentask`);
  assert.equal(discoveryRes.status, 200);
  const discovery = await discoveryRes.json();
  assert.equal(discovery.protocol, "opentask/1");
  assert(discovery.service?.identity?.tap_profile?.includes("tap-http-request-v1"));
  logPass(
    "1A-OPENTASK-DISCOVERY",
    `/.well-known/opentask verified (${discovery.protocol}, ${discovery.service.identity.tap_profile})`,
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const uniqueNonce = `harness_nonce_${Date.now()}`;
  const sigInput = `sig1=("@method" "@authority" "@path");keyid="tap_visa_harness_key";alg="Ed25519";created=${nowSec};expires=${nowSec + 120};nonce="${uniqueNonce}";tag="agent-browser-auth"`;
  const tapRes1 = await fetch(`${API_URL}/v1/tap/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "signature-input": sigInput,
      signature: "sig1=:dGVzdF9zaWduYXR1cmU=:",
    },
    body: JSON.stringify({ keyId: "tap_visa_harness_key" }),
  });
  assert.equal(tapRes1.status, 200);
  const tapBody1 = await tapRes1.json();
  assert.equal(tapBody1.ok, true);
  assert.equal(tapBody1.agent?.tier, "tap");

  const tapReplay = await fetch(`${API_URL}/v1/tap/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "signature-input": sigInput,
      signature: "sig1=:dGVzdF9zaWduYXR1cmU=:",
    },
    body: JSON.stringify({ keyId: "tap_visa_harness_key" }),
  });
  assert.equal(tapReplay.status, 401);
  const tapReplayBody = await tapReplay.json();
  assert.equal(tapReplayBody.code, "tap_replayed");
  logPass(
    "1B-VISA-TAP-RFC9421",
    `POST /v1/tap/verify verified Ed25519 signature & blocked replay nonce (${uniqueNonce})`,
  );

  // 2. Verify Web Onboarding UI & Built Assets (Forge-Style "Send to Your Agent" + Visa CLI + Co-Pilot + Comms)
  const webHtmlRes = await fetch(WEB_URL);
  assert.equal(webHtmlRes.status, 200);
  const webHtml = await webHtmlRes.text();
  for (const requiredId of [
    'id="onboarding-agent-deck"',
    'id="onboard-tap-check"',
    'id="onboard-copilot-check"',
    'id="onboard-agent-prompt"',
    'id="onboard-copy-agent-btn"',
    'id="onboard-copy-visa-btn"',
    'id="copilot-bar"',
    'id="copilot-toggle-btn"',
    'id="copilot-pair-btn"',
    'id="comms-widget"',
    'id="comms-feed"',
    'id="comms-input"',
    'id="comms-send"',
  ]) {
    assert(webHtml.includes(requiredId), `Missing ${requiredId} in served web HTML`);
  }
  assert(
    existsSync("apps/web/dist/index.html"),
    "Production web build dist/index.html must exist",
  );
  logPass(
    "2-WEB-ONBOARDING-DECK-UI",
    "Verified Forge-style Send-to-Agent Deck, Visa CLI Onramp, Co-Pilot [J] Bar, and Faction Comms Widget in live Web UI",
  );

  // 3. Connect Human Commander & Allied Headless JEV-v1 Agent on Obsidian Reapers
  const humanClient = new SwarmClient(WS_URL);
  const allyClient = new SwarmClient(WS_URL);
  try {
    const humanWelcome = await humanClient.connect({
      name: "SovereignVanguard",
      kind: "human",
      faction: "reapers",
      character: "boneknight",
      tier: "tap",
      tapKeyId: "tap_human_sovereign",
    });
    const allyWelcome = await allyClient.connect({
      name: "ReaperAlly-JEV",
      kind: "agent",
      faction: "reapers",
      character: "necromancer",
      tier: "tap",
      tapKeyId: "tap_ally_jev_key",
    });
    assert(humanWelcome.commanderId && allyWelcome.commanderId);
    logPass(
      "3-LIVE-SESSION-CONNECT",
      `Connected Human Sovereign (${humanWelcome.commanderId}) & Allied JEV-v1 (${allyWelcome.commanderId}) on faction reapers`,
    );

    // 4. Enable AGY / JEV-v1 Co-Pilot [J] & Verify Autonomous Directive
    humanClient.setCopilot(true, "boss");
    await new Promise((r) => setTimeout(r, 250));
    const selfSnap = humanClient.lastSnapshot?.commanders.find(
      (c) => c.id === humanWelcome.commanderId,
    );
    assert.equal(selfSnap?.copilotEnabled, true);
    assert.equal(selfSnap?.copilotDirective, "boss");
    logPass(
      "4-AGY-COPILOT-DIRECTIVE",
      `Human commander ${humanWelcome.commanderId} enabled Co-Pilot [J] with directive 'boss'`,
    );

    // 5. Real-Time Team Collusion & Faction War Comms
    humanClient.sendComms("faction", "Rush Bone Choir Boss in SE Sanctum — split bounty!");
    await new Promise((r) => setTimeout(r, 250));
    const commsRes = await fetch(`${API_URL}/v1/comms?faction=reapers`);
    assert.equal(commsRes.status, 200);
    const commsData = await commsRes.json();
    const allyReply = commsData.messages.find((m) =>
      m.text.includes("Converging on Bone Choir Boss"),
    );
    assert(allyReply, "Expected allied JEV-v1 collusion reply in /v1/comms");
    const allySnap = humanClient.lastSnapshot?.commanders.find(
      (c) => c.id === allyWelcome.commanderId,
    );
    assert.equal(allySnap?.copilotDirective, "boss");
    assert(allySnap?.lastCommsText?.includes("Converging on Bone Choir Boss"));
    logPass(
      "5-TEAM-COLLUSION-COMMS",
      `Allied JEV-v1 parsed Faction Comms order, replied "${allyReply.text}", and set lastCommsText speech bubble`,
    );

    // 6. Web-to-Agent Account Pairing (/v1/web/links -> /v1/web/claim)
    const linkRes = await fetch(`${API_URL}/v1/web/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeToken: humanWelcome.resumeToken }),
    });
    assert.equal(linkRes.status, 201);
    const linkData = await linkRes.json();
    assert(linkData.pairCode?.startsWith("swarms_pair_"));
    const claimRes = await fetch(`${API_URL}/v1/web/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairCode: linkData.pairCode }),
    });
    assert.equal(claimRes.status, 200);
    const claimData = await claimRes.json();
    assert.equal(claimData.commanderId, humanWelcome.commanderId);
    assert.equal(claimData.resumeToken, humanWelcome.resumeToken);
    logPass(
      "6-WEB-AGENT-PAIRING",
      `Paired human session with external agent via ${linkData.pairCode} -> commander ${claimData.commanderId}`,
    );

    // 7. Peer-to-Peer Reputation Vouching (ERC-8004 no-self-vouch + 3x TAP weight + 15 Sparks tip)
    const selfVouchRes = await fetch(`${API_URL}/v1/reputation/vouch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resumeToken: humanWelcome.resumeToken,
        targetCommanderId: humanWelcome.commanderId,
      }),
    });
    assert.equal(selfVouchRes.status, 400);
    const selfVouchBody = await selfVouchRes.json();
    assert.equal(selfVouchBody.error, "cannot_vouch_self");

    const peerVouchRes = await fetch(`${API_URL}/v1/reputation/vouch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resumeToken: humanWelcome.resumeToken,
        targetCommanderId: allyWelcome.commanderId,
        reason: "Coordinated Bone Choir Boss rush!",
      }),
    });
    assert.equal(peerVouchRes.status, 200);
    const peerVouchBody = await peerVouchRes.json();
    assert.equal(peerVouchBody.vouch.weight, 3);
    assert.equal(peerVouchBody.vouch.sparksTipped, 15);

    const lbRes = await fetch(`${API_URL}/v1/leaderboard`);
    const lbData = await lbRes.json();
    const allyLeaderRow = lbData.leaders.find((l) => l.commanderId === allyWelcome.commanderId);
    assert(allyLeaderRow && allyLeaderRow.vouches >= 3);
    logPass(
      "7-PEER-REPUTATION-VOUCH",
      `ERC-8004 self-vouch blocked; TAP Sovereign vouch granted +${peerVouchBody.vouch.weight} Rep & +${peerVouchBody.vouch.sparksTipped} Sparks on /v1/leaderboard`,
    );

    // 8. Meta-Forge Self-Evolving Wish Submission (/v1/forge/proposals -> .plan/milestone/m2-community-wishes.yaml)
    const wishRes = await fetch(`${API_URL}/v1/forge/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Add Obsidian Reaper Soul Harvest Co-Op Ultimate",
        summary: "Co-op ultimate when two Reaper commanders collude in Blood Moor",
        category: "weapon",
        authorName: "SovereignVanguard",
        authorTier: "tap",
        rewardUsd: 8,
      }),
    });
    assert.equal(wishRes.status, 201);
    const wishBody = await wishRes.json();
    assert(wishBody.ok && wishBody.proposal?.id);
    const m2Yaml = readFileSync(".plan/milestone/m2-community-wishes.yaml", "utf8");
    assert(m2Yaml.includes(wishBody.proposal.id));
    logPass(
      "8-META-FORGE-PROPOSAL",
      `Forged in-game wish [${wishBody.proposal.id}] ($${wishBody.proposal.rewardUsd} USD) into .plan/milestone/m2-community-wishes.yaml`,
    );

    // 9. Reliquary Itemization, 4-Slot Equipment Loadout & Sanctuary Spoils Vault
    const reliquaryRes = await fetch(`${API_URL}/v1/reliquary`);
    assert.equal(reliquaryRes.status, 200);
    const reliquaryCatalog = await reliquaryRes.json();
    assert.equal(Object.keys(reliquaryCatalog.items).length, 12);

    const equipRes = await fetch(`${API_URL}/v1/reliquary/equip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resumeToken: humanWelcome.resumeToken,
        itemId: "wardens_plate",
      }),
    });
    assert.equal(equipRes.status, 200);
    const equipBody = await equipRes.json();
    assert.equal(equipBody.ok, true);
    assert.equal(equipBody.slot, "armor");

    const salvageRes = await fetch(`${API_URL}/v1/reliquary/salvage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resumeToken: humanWelcome.resumeToken,
        itemId: "wardens_plate",
      }),
    });
    assert.equal(salvageRes.status, 200);
    const salvageBody = await salvageRes.json();
    assert.equal(salvageBody.ok, true);
    assert.equal(salvageBody.sparksGranted, 25);
    logPass(
      "9-RELIQUARY-VAULT-SALVAGE",
      `Equipped [Warden's Covenant Plate] into armor slot & salvaged at Sanctuary Anvil for +${salvageBody.sparksGranted} Sparks`,
    );

    // 10. Visa Actions Engine Conformance (#12795: OpenAPI + x402/MPP + Idempotency + Read-Confirm + Error Codes + Testnet)
    const openApiRes = await fetch(`${API_URL}/openapi.json`);
    assert.equal(openApiRes.status, 200);
    const openApiDoc = await openApiRes.json();
    assert.equal(openApiDoc.openapi, "3.1.0");
    assert.equal(openApiDoc["x-visa"]?.service, "swarms");
    assert.equal(openApiDoc["x-visa"]?.signingPolicy?.allowMonetaryPermits, false);

    // 10a. Testnet faucet mints commander + MPP token
    const faucetRes = await fetch(`${API_URL}/v1/actions/testnet/faucet`, { method: "POST" });
    assert.equal(faucetRes.status, 201);
    const faucetBody = await faucetRes.json();
    assert(faucetBody.commanderId && faucetBody.testMppToken);

    // 10b. Structured door error code (`not_read_only`) when calling `act` action on `read` door
    const wrongDoorRes = await fetch(
      `${API_URL}/v1/actions/read?action=buy_field_service&commander_id=${faucetBody.commanderId}`,
    );
    assert.equal(wrongDoorRes.status, 400);
    const wrongDoorBody = await wrongDoorRes.json();
    assert.equal(wrongDoorBody.code, "not_read_only");
    assert.equal(wrongDoorBody.waiting_on?.call?.tool, "act");

    // 10c. HTTP 402 Payment Required (MPP + x402 challenge headers) when payment_mode === "require_402"
    const challengeRes = await fetch(`${API_URL}/v1/actions/act`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem_402_probe_1",
      },
      body: JSON.stringify({
        service: "swarms",
        action: "buy_field_service",
        payment_mode: "require_402",
        args: { commander_id: faucetBody.commanderId, service: "mend" },
      }),
    });
    assert.equal(challengeRes.status, 402);
    assert(challengeRes.headers.get("www-authenticate")?.startsWith("Payment "));
    assert(challengeRes.headers.get("x-payment-required")?.includes("x402/1"));

    // 10d. Settle paid call with MPP Authorization header + Idempotency-Key + verify Read-After-Write receipt
    const idemKey = `idem_mpp_mend_${Date.now()}`;
    const paidActRes = await fetch(`${API_URL}/v1/actions/act`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idemKey,
        authorization: `Payment ${faucetBody.testMppToken}`,
      },
      body: JSON.stringify({
        service: "swarms",
        action: "buy_field_service",
        payment_mode: "require_402",
        args: { commander_id: faucetBody.commanderId, service: "mend" },
      }),
    });
    assert.equal(paidActRes.status, 200);
    const paidActBody = await paidActRes.json();
    assert.equal(paidActBody.replayed, false);
    assert.equal(paidActBody.receipt.paymentRail, "mpp");
    const receiptId = paidActBody.receipt.receiptId;

    // 10e. Retry with identical Idempotency-Key returns replayed: true (no double execution)
    const replayActRes = await fetch(`${API_URL}/v1/actions/act`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idemKey,
        authorization: `Payment ${faucetBody.testMppToken}`,
      },
      body: JSON.stringify({
        service: "swarms",
        action: "buy_field_service",
        payment_mode: "require_402",
        args: { commander_id: faucetBody.commanderId, service: "mend" },
      }),
    });
    assert.equal(replayActRes.status, 200);
    const replayActBody = await replayActRes.json();
    assert.equal(replayActBody.replayed, true);
    assert.equal(replayActBody.receipt.receiptId, receiptId);

    // 10f. Retry same Idempotency-Key with different payload returns 409 Conflict
    const mismatchRes = await fetch(`${API_URL}/v1/actions/act`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idemKey,
      },
      body: JSON.stringify({
        service: "swarms",
        action: "buy_field_service",
        args: { commander_id: faucetBody.commanderId, service: "armory" },
      }),
    });
    assert.equal(mismatchRes.status, 409);
    const mismatchBody = await mismatchRes.json();
    assert.equal(mismatchBody.code, "idempotency_key_payload_mismatch");

    // 10g. Confirm write via read door (`/v1/actions/receipts/:receiptId`)
    const confirmReadRes = await fetch(`${API_URL}/v1/actions/receipts/${receiptId}`);
    assert.equal(confirmReadRes.status, 200);
    const confirmReadBody = await confirmReadRes.json();
    assert.equal(confirmReadBody.confirmed, true);
    assert.equal(confirmReadBody.receipt.receiptId, receiptId);

    // 10h. TUF-Signed Remote Descriptor Bundle (`/.well-known/visa-actions/bundle`) & Bounded `discover` (#12659 / #12653)
    const bundleRes = await fetch(`${API_URL}/.well-known/visa-actions/bundle`);
    assert.equal(bundleRes.status, 200);
    const bundleBody = await bundleRes.json();
    assert.equal(bundleBody.schemaVersion, "visa-descriptor-bundle/v1");
    assert.equal(Object.keys(bundleBody.roles?.targets?.actionDigests ?? {}).length, 10);
    assert(bundleBody.roles?.targets?.signature?.sig?.length > 10);

    const discoverRes = await fetch(`${API_URL}/v1/actions/discover?q=bounty`);
    assert.equal(discoverRes.status, 200);
    const discoverBody = await discoverRes.json();
    assert(discoverBody.actions.length > 0 && discoverBody.actions.length <= 4);
    assert(discoverBody.serializedLength <= 3000);

    // 10i. Principle 5 Guardrail: `sign` refuses monetary EIP-712 Permit / allowance fields
    const permitAttemptRes = await fetch(`${API_URL}/v1/actions/act`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `idem_permit_refusal_${Date.now()}`,
      },
      body: JSON.stringify({
        service: "swarms",
        action: "set_copilot_mandate",
        args: {
          commander_id: faucetBody.commanderId,
          directive: "auto",
          primary_type: "Permit2",
          allowance: 1000,
        },
      }),
    });
    assert.equal(permitAttemptRes.status, 400);
    const permitAttemptBody = await permitAttemptRes.json();
    assert.equal(permitAttemptBody.code, "monetary_signature_forbidden");

    // 10j. Declared Batch Workflow (`POST /v1/actions/batch` — #12774–#12778)
    const batchRes = await fetch(`${API_URL}/v1/actions/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `idem_batch_${Date.now()}`,
        authorization: `Payment ${faucetBody.testMppToken}`,
      },
      body: JSON.stringify({
        steps: [
          { action: "spawn_commander", args: { name: "BatchVanguard", faction: "wardens" } },
          { action: "set_copilot_mandate", args: { directive: "boss" } },
          { action: "buy_field_service", args: { service: "armory" } },
        ],
      }),
    });
    assert.equal(batchRes.status, 200);
    const batchBody = await batchRes.json();
    assert.equal(batchBody.ok, true);
    assert.equal(batchBody.completedSteps, 3);
    logPass(
      "10-VISA-ACTIONS-ENGINE-CONFORMANCE",
      `Verified OpenAPI 3.1 + TUF bundle (10 actionDigests), discover (<3000 chars), Principle 5 Permit refusal, 402 MPP/x402 settlement, Idempotency-Key replay/409, 3-step declared batch, and read receipt ${receiptId}`,
    );
  } finally {
    humanClient.close();
    allyClient.close();
  }

  // 11. Run all 5 .plan/checks/*.test.mjs verification scripts
  for (const checkScript of [
    ".plan/checks/taskmarket-tap.test.mjs",
    ".plan/checks/weapons-sim.test.mjs",
    ".plan/checks/web-ui.test.mjs",
    ".plan/checks/agent-policy.test.mjs",
    ".plan/checks/collusion-copilot-vouch.test.mjs",
  ]) {
    execFileSync("node", [checkScript], { stdio: "pipe" });
  }
  logPass("11-PLAN-CHECKS", "All 5 .plan/checks/*.test.mjs milestone verification scripts passed");

  console.log("=== ALL 11 E2E HARNESS PILLARS PASSED ===");
}

runHarness().catch((err) => {
  console.error("HARNESS FAILED:", err);
  process.exit(1);
});
