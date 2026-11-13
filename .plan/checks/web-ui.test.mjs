import { execFileSync } from "node:child_process";

execFileSync("pnpm", ["--filter", "@swarms/web", "build"], { stdio: "inherit" });
