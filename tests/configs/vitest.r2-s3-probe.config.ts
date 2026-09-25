import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/integration/r2-s3-object-storage.probe.test.ts"],
    testTimeout: 120_000,
  },
});
