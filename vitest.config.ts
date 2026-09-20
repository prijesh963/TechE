import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    // One temp root per run, removed at the end. See tests/support/temp-root.ts
    // for why this is here rather than an afterEach in each test file.
    globalSetup: ["tests/support/global-temp.ts"],
    setupFiles: ["tests/support/temp-root.ts"]
  }
});
