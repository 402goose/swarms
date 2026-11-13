import { execFileSync } from "node:child_process";

execFileSync("pnpm", ["test", "tests/core.test.ts"], { stdio: "inherit" });
