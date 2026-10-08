#!/usr/bin/env bash
# Hosted qualification of the Forms review pilot (DSN-007 … DSN-011) against a
# deployed Artifact Server. It signs in with the operator's existing CLI profile
# for that origin and never prints the credential. It publishes a disposable
# scenario fixture and, per engine, a copy of a pinned Forms version it reads
# from that origin, then deletes each with its comments. It never registers an
# agent under the operator's key.
#
# Setup for DSN-011 hosted delivery. The DSN-011-B test registers an MCP mailbox
# and a native bridge under a dedicated agent principal, so the operator's own
# mailbox is never touched. Once, a human administrator creates in the admin
# console a service API key not bound to a member, with agent:connect and
# artifact:read only and an expiry. The suite reads it from the CLI profile
# directory named by ARTIFACT_SERVER_HOSTED_AGENT_PROFILE_DATA, or else from
# BACKEND_AGENT_KEY (the hosted Playwright config takes only that variable from
# the repository's ignored .env, mode 0600). With neither set the test skips; it
# never falls back to the operator's key. The operator must be able to send
# dispatches: a browser (OAuth) sign-in, or a key holding artifact:manage:any.
# A thread sits in one dispatch at a time, so the run reopens the comment once
# between the two sends; its dispatch and activity records outlive the artifact.
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
