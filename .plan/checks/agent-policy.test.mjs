import { execFileSync } from "node:child_process";

execFileSync("pnpm", ["test", "tests/commander.test.ts"], { stdio: "inherit" });
