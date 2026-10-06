import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/integration/cloudflare-artifacts-product.live.test.ts"],
    pool: "forks",
    sequence: {concurrent: false},
    testTimeout: 180_000,
  },
});
