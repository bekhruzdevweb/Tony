import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "evals/**/*.test.ts"],
    // Times in the tests are written as Tashkent times, as everywhere in Tony.
    env: { TZ: "UTC" },
  },
  resolve: {
    // Server modules start with `import "server-only"`; in tests that is a no-op.
    alias: { "server-only": fileURLToPath(new URL("./tests/support/server-only.ts", import.meta.url)), "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
