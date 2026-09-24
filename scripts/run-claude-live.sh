#!/usr/bin/env bash

# Runs the live-Claude bridge suite: a REAL claude process in a real PTY with
# the Artifact Server channel loaded through .mcp.json +
# --dangerously-load-development-channels, against a real Artifact Server on a
# temporary data directory. The model is redirected to a scripted offline
# Anthropic Messages endpoint (ANTHROPIC_BASE_URL + dummy token, isolated
# HOME), so no API key, no real account, and no metered usage is involved.
# This suite is deliberately NOT part of pnpm verify:iteration.

set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repository_root}"

# 1. Find a claude CLI: an explicit override or the installed claude on PATH.
claude_cli="${ARTIFACT_SERVER_CLAUDE_LIVE_CLI:-}"
if [[ -z "${claude_cli}" ]] && command -v claude >/dev/null 2>&1; then
  claude_cli="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v claude)")"
fi
if [[ -z "${claude_cli}" || ! -f "${claude_cli}" ]]; then
  cat >&2 <<'MESSAGE'
No claude CLI was found, so the live-Claude suite cannot run.

Install Claude Code (https://code.claude.com), or point the suite at a binary:

  ARTIFACT_SERVER_CLAUDE_LIVE_CLI=/path/to/claude pnpm test:claude-live
MESSAGE
  exit 1
fi
export ARTIFACT_SERVER_CLAUDE_LIVE_CLI="${claude_cli}"
echo "Using claude CLI: ${claude_cli}"
"${claude_cli}" --version

# 2. node-pty ships a prebuilt spawn-helper whose executable bit does not
#    survive npm/pnpm tarball extraction; without it every PTY spawn fails with
#    "posix_spawnp failed".
node -e '
const {chmodSync, constants, accessSync} = require("node:fs");
const path = require("node:path");
const helper = path.join(
  path.dirname(require.resolve("node-pty/package.json")),
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper",
);
try {
  accessSync(helper, constants.X_OK);
} catch {
  chmodSync(helper, 0o755);
  console.log(`Restored the executable bit on ${helper}`);
}
'

# 3. Run the suite serially; PTY-driven agents are timing sensitive.
pnpm exec vitest run --config tests/configs/vitest.claude-live.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile.json=project/evidence/claude-live.json
