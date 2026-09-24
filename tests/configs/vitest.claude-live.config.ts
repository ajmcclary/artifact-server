import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 180_000,
    include: ["tests/claude-live/**/*.test.ts"],
    pool: "forks",
    testTimeout: 360_000,
  },
});
