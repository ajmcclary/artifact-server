#!/usr/bin/env bash

set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly bucket="${1:-${ARTIFACT_SERVER_R2_S3_PROBE_BUCKET:-}}"

if [[ ! "${bucket}" =~ ^artifact-server-qual-r2-[a-z0-9-]+$ ]]; then
  echo "Pass an exact artifact-server-qual-r2-* qualification bucket." >&2
  exit 64
fi
if [[ ! -f "${repository_root}/.env" ]]; then
  echo "The ignored repository .env file is required for R2 credentials." >&2
  exit 64
fi

cd "${repository_root}"
ARTIFACT_SERVER_R2_S3_PROBE_BUCKET="${bucket}" \
  node --env-file=.env node_modules/vitest/vitest.mjs run \
    --config tests/configs/vitest.r2-s3-promotion-probe.config.ts \
    --reporter=default \
    --reporter=json \
    --outputFile.json=project/evidence/r2-s3-promotion-probe.json
