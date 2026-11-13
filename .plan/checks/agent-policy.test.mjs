import { execFileSync } from "node:child_process";

execFileSync("pnpm", ["test", "tests/agent.test.ts"], { stdio: "inherit" });
