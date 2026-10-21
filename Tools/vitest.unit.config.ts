import { defineConfig } from "vitest/config";

// CLAUDE-NOTE: pure unit tests (no UE). The main config boots a headless commandlet in globalSetup, which takes
// minutes and cannot run while an editor holds the plugin DLL; these run in seconds: `npm run test:unit`.
export default defineConfig({
  test: { include: ["test/unit/**/*.test.ts"] },
});
