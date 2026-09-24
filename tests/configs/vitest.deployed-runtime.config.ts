import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["tests/integration/*.live.test.ts"],
    pool: "forks",
    testTimeout: 300_000,
  },
});
