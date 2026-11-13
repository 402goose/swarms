import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@swarms/protocol": `${root}packages/protocol/src/index.ts`,
      "@swarms/sim": `${root}packages/sim/src/index.ts`,
      "@swarms/worldgen": `${root}packages/worldgen/src/index.ts`,
      "@swarms/content": `${root}packages/content/src/index.ts`,
      "@swarms/bounties": `${root}packages/bounties/src/index.ts`,
      "@swarms/persistence": `${root}packages/persistence/src/index.ts`,
      "@swarms/agent-sdk": `${root}packages/agent-sdk/src/index.ts`,
      "@swarms/commander": `${root}packages/commander/src/index.ts`,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
