#!/usr/bin/env bash
# Bounded live qualification of the Node/Postgres Git-history product path.
# Requires explicit opt-in, Docker, and a qualification token file. It uses only
# the dedicated qualification namespace and removes its own repositories.

set -euo pipefail

if [[ "${ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE:-}" != "1" ]]; then
  echo "Set ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE=1 to authorize the bounded live suite." >&2
  exit 64
fi

readonly token_file="${ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE:-${HOME}/.config/artifact-server/cloudflare-artifacts/qualification.token}"
if [[ ! -r "${token_file}" ]]; then
  echo "The qualification token file is not readable: ${token_file}" >&2
  exit 66
fi
if [[ -z "${ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID:-}" ]]; then
  echo "Set ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID to the qualification account." >&2
  exit 64
fi

readonly run_stamp="$(date -u +%Y-%m-%dT%H%MZ)"
readonly evidence_dir="project/evidence"
readonly summary="${evidence_dir}/cloudflare-artifacts-node-postgres-qualification-${run_stamp}.json"
readonly report="${evidence_dir}/cloudflare-artifacts-node-postgres-qualification-${run_stamp}.vitest.json"

source_commit="$(git rev-parse HEAD)"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  source_commit="${source_commit}+dirty"
fi

pnpm build

ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE="${token_file}" \
ARTIFACT_SERVER_QUALIFICATION_EVIDENCE="${summary}" \
ARTIFACT_SERVER_QUALIFICATION_SOURCE_COMMIT="${source_commit}" \
  bash scripts/with-external-storage-test-providers.sh \
  pnpm exec vitest run --config tests/configs/vitest.cloudflare-artifacts-product.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile="${report}"
