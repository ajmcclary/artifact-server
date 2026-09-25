#!/usr/bin/env bash

set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly default_bucket="artifact-server-runtime-ajmcclary-20260923"
readonly bucket="${1:-${ARTIFACT_SERVER_AWS_S3_PROMOTION_BUCKET:-${default_bucket}}}"

if [[ "${bucket}" != "${default_bucket}" ]]; then
  echo "This probe must target ${default_bucket}." >&2
  exit 64
fi

if command -v aws >/dev/null 2>&1; then
  AWS_PROFILE=artifact-server-runtime \
    aws sts get-caller-identity --profile artifact-server-runtime >/dev/null
fi

cd "${repository_root}"
AWS_PROFILE=artifact-server-runtime \
  ARTIFACT_SERVER_AWS_S3_PROMOTION_BUCKET="${bucket}" \
  node --import tsx node_modules/vitest/vitest.mjs run \
    --config tests/configs/vitest.aws-s3-promotion-probe.config.ts \
    --reporter=default \
    --reporter=json \
    --outputFile.json=project/evidence/aws-s3-promotion-probe.json
