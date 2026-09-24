# Live account snapshot — 2026-09-23 (pre-run verification)

Recorded before the deployed-runtime resume (T05), managed-Postgres measurement
(T04/T06), and GCS probe (T02) live runs, per `AGENTS.md` live-provider
qualification rules. No credential values are recorded here; credentials live in
the gitignored `.env` and `~/.config/artifact-server/` with restrictive modes.

## Neon (managed Postgres)

- Plan: Neon Free (as recorded in NEXT-STEPS T04, September 23 setup).
- Endpoint: pooled TLS, `us-east-1` (`*.pooler.us-east-1.aws.neon.tech`).
- Observed: PostgreSQL 17.11 (aarch64), database `artifactserver`,
  size 8,953,856 bytes, migration ledger at version 14 — matches the September
  23 setup record. Connectivity, query, and migration-ledger read verified at
  snapshot time.
- Cost behavior: Neon Free has no per-request billing; compute-hour and storage
  caps apply. The planned runs are short-lived, low-row-count workloads well
  inside the free allowance.

## AWS (runtime object storage)

- Profile: `artifact-server-runtime` (named local profile; no keys in repo).
- Account: SHA-256 `bd616353cc3a087a8e7b6aa9025b0947dc62828b06545df179c7ce22c4c2c1c5`
  — matches `aws-runtime-storage.json`.
- Bucket: `artifact-server-runtime-ajmcclary-20260923` (us-east-1), versioning +
  AES256 + public access blocked (recorded September 23).
- Observed: `sts get-caller-identity` passes for the same principal. The
  least-privilege policy still denies bucket-configuration reads
  (`GetBucketVersioning`, `GetPublicAccessBlock` → AccessDenied), confirming the
  policy scope is unchanged (exact bucket and objects, runtime actions only).
- Cost behavior: S3 requests and storage are metered; the planned runs use
  run-scoped prefixes in the existing bucket, small objects, and self-clean.
  Volume is far below any free-tier or billing threshold.

## GCS (probe object storage)

- Project: `gen-lang-client-0757185985`; bucket
  `artifact-server-gcs-probe-0757185985` (US-EAST1, STANDARD, versioning off).
- Credentials: bucket-scoped service-account key at
  `~/.config/artifact-server/gcp/artifact-server-gcs-probe.json` (mode 600).
- Observed: bucket metadata readable via ADC at snapshot time.
- Cost behavior: GCS operations/storage are metered; the probe creates only
  run-scoped objects under a guarded prefix and deletes them on exit.

## Cloudflare

No Cloudflare live runs are planned or authorized in this round. The dedicated
namespace unavailability and runtime 503 from September 23 remain standing gaps
for T03 live-provider items and T05 Worker resume.
