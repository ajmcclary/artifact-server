#!/usr/bin/env bash
# Live GCS probe (T02): exercises the GCS blob/staging adapters against a real
# bucket with a bucket-scoped service account. Credentials come from
# GOOGLE_APPLICATION_CREDENTIALS / ADC; this script never prints them.
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$artifactserver_repository"

export ARTIFACT_SERVER_GCS_PROBE_BUCKET="${ARTIFACT_SERVER_GCS_PROBE_BUCKET:-${ARTIFACT_SERVER_GCS_BUCKET:-}}"
export ARTIFACT_SERVER_GCS_PROBE_PROJECT_ID="${ARTIFACT_SERVER_GCS_PROBE_PROJECT_ID:-${ARTIFACT_SERVER_GCS_PROJECT_ID:-}}"

if [[ -z "$ARTIFACT_SERVER_GCS_PROBE_BUCKET" || -z "$ARTIFACT_SERVER_GCS_PROBE_PROJECT_ID" ]]; then
  echo "Set ARTIFACT_SERVER_GCS_PROBE_BUCKET and ARTIFACT_SERVER_GCS_PROBE_PROJECT_ID" >&2
  echo "(or ARTIFACT_SERVER_GCS_BUCKET and ARTIFACT_SERVER_GCS_PROJECT_ID) first." >&2
  exit 64
fi

# The bucket-scoped service account cannot create buckets, so the probe uses
# the configured bucket and only creates run-scoped objects under
# installations/<sha256(random installation id)>/, which the test deletes on
# completion.
pnpm exec vitest run \
  --config tests/configs/vitest.gcs-probe.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile.json=project/evidence/gcs-gcp-probe.json
