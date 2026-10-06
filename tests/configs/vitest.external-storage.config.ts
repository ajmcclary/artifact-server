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
      "tests/integration/postgres-activity-feed.test.ts",
      "tests/integration/postgres-activity-log-migration.test.ts",
      "tests/integration/postgres-activity-log-writes.test.ts",
      "tests/integration/postgres-content-variant-index.test.ts",
      "tests/integration/postgres-expired-staging-cleanup.test.ts",
      "tests/integration/postgres-content-access-revocation.test.ts",
      "tests/integration/postgres-library-dates.test.ts",
      "tests/integration/postgres-invitations.test.ts",
      "tests/integration/postgres-login-attempt-invite.test.ts",
      "tests/integration/postgres-pool-shutdown.test.ts",
      "tests/integration/postgres-principal-activity.test.ts",
      "tests/integration/postgres-staged-upload-idempotency.test.ts",
      "tests/integration/postgres-staged-upload-preparation.test.ts",
      "tests/integration/postgres-version-pagination.test.ts",
      "tests/integration/prj-004-project-migration.test.ts",
    ],
    pool: "forks",
    testTimeout: 60_000,
  },
});
