#!/usr/bin/env bash

# Runs the live-OpenCode bridge suite: a REAL opencode process in a real PTY,
# loaded with integrations/opencode/index.ts, against a real Artifact Server on
# a temporary data directory and an offline scripted model. No API key and no
# network provider are involved. This suite is deliberately NOT part of pnpm
# verify:iteration.

set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repository_root}"

# 1. Find an OpenCode CLI: an explicit override, the installed opencode, or a
#    local checkout build. The checkout is only read, never built.
opencode_cli="${ARTIFACT_SERVER_OPENCODE_LIVE_CLI:-}"
if [[ -z "${opencode_cli}" ]] && command -v opencode >/dev/null 2>&1; then
  opencode_cli="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v opencode)")"
fi
if [[ -z "${opencode_cli}" || ! -f "${opencode_cli}" ]]; then
  cat >&2 <<'MESSAGE'
No opencode CLI was found, so the live-OpenCode suite cannot run.

Install it (https://opencode.ai), or point the suite at a built checkout:

  ARTIFACT_SERVER_OPENCODE_LIVE_CLI=/path/to/opencode \
    pnpm test:opencode-live
MESSAGE
  exit 1
fi
export ARTIFACT_SERVER_OPENCODE_LIVE_CLI="${opencode_cli}"
echo "Using opencode CLI: ${opencode_cli}"
"${opencode_cli}" --version

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
pnpm exec vitest run --config tests/configs/vitest.opencode-live.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile.json=project/evidence/opencode-live.json
