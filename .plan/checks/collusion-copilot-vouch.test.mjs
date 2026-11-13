import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const html = readFileSync("apps/web/index.html", "utf8");
assert(html.includes('id="onboarding-agent-deck"'), "Missing #onboarding-agent-deck");
assert(html.includes('id="copilot-bar"'), "Missing #copilot-bar");
assert(html.includes('id="comms-widget"'), "Missing #comms-widget");

execFileSync("pnpm", ["test", "tests/zone.test.ts"], { stdio: "inherit" });
