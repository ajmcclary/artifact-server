import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/integration/gcs-promotion.probe.test.ts"],
    pool: "forks",
    testTimeout: 180_000,
  },
});
