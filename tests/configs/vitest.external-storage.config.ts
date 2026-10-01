import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/external-storage/**/*.ts", "src/storage/postgres-*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage/external-storage-runtime",
    },
    fileParallelism: false,
    include: [
      "tests/integration/external-storage-runtime.test.ts",
      "tests/integration/postgres-activity-log-migration.test.ts",
      "tests/integration/postgres-activity-log-writes.test.ts",
      "tests/integration/postgres-expired-staging-cleanup.test.ts",
      "tests/integration/postgres-pool-shutdown.test.ts",
      "tests/integration/postgres-staged-upload-idempotency.test.ts",
      "tests/integration/postgres-staged-upload-preparation.test.ts",
      "tests/integration/postgres-version-pagination.test.ts",
    ],
    pool: "forks",
    testTimeout: 60_000,
  },
});
