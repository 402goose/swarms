import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@swarms/protocol": `${root}packages/protocol/src/index.ts`,
    },
  },
  server: {
    host: "127.0.0.1",
    port: 15173,
  },
});
