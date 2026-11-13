import { execFileSync } from "node:child_process";

execFileSync("pnpm", ["test", "tests/sim.test.ts"], { stdio: "inherit" });
