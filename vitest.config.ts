import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts", "web/**/*.test.ts", "web/**/*.test.tsx"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
