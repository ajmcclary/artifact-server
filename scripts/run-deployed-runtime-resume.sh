#!/usr/bin/env bash
# Live deployed-runtime resume qualification (T05): runs the compiled
# external-storage server against managed Postgres and a real S3 bucket.
# Credentials come from the operator environment (AWS provider chain); this
# script never prints them.
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$artifactserver_repository"

export ARTIFACT_SERVER_TEST_DATABASE_URL="${ARTIFACT_SERVER_TEST_DATABASE_URL:-${ARTIFACT_SERVER_DATABASE_URL:-}}"
export ARTIFACT_SERVER_TEST_S3_BUCKET="${ARTIFACT_SERVER_TEST_S3_BUCKET:-${ARTIFACT_SERVER_S3_BUCKET:-}}"
export ARTIFACT_SERVER_TEST_S3_REGION="${ARTIFACT_SERVER_TEST_S3_REGION:-${ARTIFACT_SERVER_S3_REGION:-us-east-1}}"

if [[ -z "$ARTIFACT_SERVER_TEST_DATABASE_URL" || -z "$ARTIFACT_SERVER_TEST_S3_BUCKET" ]]; then
  echo "Set ARTIFACT_SERVER_TEST_DATABASE_URL and ARTIFACT_SERVER_TEST_S3_BUCKET" >&2
  echo "(or ARTIFACT_SERVER_DATABASE_URL and ARTIFACT_SERVER_S3_BUCKET) first." >&2
  exit 64
fi

pnpm build

pnpm exec vitest run \
  --config tests/configs/vitest.deployed-runtime.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile.json=project/evidence/deployed-runtime-resume.json
