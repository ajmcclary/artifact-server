#!/usr/bin/env bash
# Hosted qualification of the Forms review pilot (DSN-007 … DSN-011) against a
# deployed Artifact Server. It signs in with the operator's existing CLI profile
# for that origin and never prints the credential. It publishes one disposable
# artifact, then deletes it with its comments. It registers no agent.
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$artifactserver_repository"

origin="${ARTIFACT_SERVER_HOSTED_URL:-https://artifacts.backend.app}"
deployment="${ARTIFACT_SERVER_HOSTED_DEPLOYMENT:-kubernetes}"
revision="${ARTIFACT_SERVER_HOSTED_REVISION:-}"
if [[ -z "$revision" ]]; then
  echo "Set ARTIFACT_SERVER_HOSTED_REVISION to the image digest deployed at $origin." >&2
  exit 64
fi
stamp=$(date -u +%Y-%m-%dT%H%MZ)
evidence="project/evidence/hosted-design-review-$stamp.json"

set +e
ARTIFACT_SERVER_HOSTED_URL="$origin" pnpm exec playwright test --config playwright.hosted.config.ts
exit_code=$?
set -e

PLAYWRIGHT_EXIT_CODE="$exit_code" \
PLAYWRIGHT_CONFIG_PATH=playwright.hosted.config.ts \
BROWSER_REPORT_PATH=test-results/hosted/playwright-report.json \
BROWSER_EVIDENCE_PATH="$evidence" \
BROWSER_EVIDENCE_TARGET="$deployment" \
BROWSER_EVIDENCE_ORIGIN="$origin" \
BROWSER_EVIDENCE_REVISION="$revision" \
  node --import tsx scripts/write-browser-evidence.ts
echo "Evidence: $evidence"
exit "$exit_code"
