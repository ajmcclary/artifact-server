import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/integration/aws-s3-promotion.probe.test.ts"],
    testTimeout: 120_000,
  },
});
