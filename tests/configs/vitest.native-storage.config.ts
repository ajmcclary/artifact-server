import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: [
        "src/storage/azure-blob-object-storage.ts",
        "src/storage/cloud-object-storage.ts",
        "src/storage/gcs-failure.ts",
        "src/storage/gcs-object-storage.ts",
        "src/storage/gcs-sealed-promotion-probe.ts",
      ],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage/native-cloud-storage",
    },
    fileParallelism: false,
    include: [
      "tests/integration/azure-blob-object-storage.test.ts",
      "tests/integration/gcs-object-storage.test.ts",
      "tests/integration/gcs-promotion.test.ts",
    ],
    pool: "forks",
    testTimeout: 30_000,
  },
});
