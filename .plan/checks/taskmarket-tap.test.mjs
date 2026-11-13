import { execFileSync } from "node:child_process";

execFileSync("pnpm", ["test", "tests/zone.test.ts"], { stdio: "inherit" });
