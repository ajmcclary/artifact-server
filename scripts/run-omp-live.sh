#!/usr/bin/env bash

# Runs the live-omp bridge suite: a REAL omp process in a real PTY, loaded
# with integrations/omp/index.ts, against a real Artifact Server on a
# temporary data directory and an offline scripted model. No API key and no
# network provider are involved. This suite is deliberately NOT part of
# pnpm verify:iteration.

set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repository_root}"

# 1. Find an omp CLI: an explicit override or the installed omp on PATH.
omp_cli="${ARTIFACT_SERVER_OMP_LIVE_CLI:-}"
if [[ -z "${omp_cli}" ]] && command -v omp >/dev/null 2>&1; then
  omp_cli="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v omp)")"
fi
if [[ -z "${omp_cli}" || ! -f "${omp_cli}" ]]; then
  cat >&2 <<'MESSAGE'
No omp CLI was found, so the live-omp suite cannot run.

Install omp (https://github.com/plannotator/omp), or point the suite at a
binary directly:

  ARTIFACT_SERVER_OMP_LIVE_CLI=/path/to/omp pnpm test:omp-live
MESSAGE
  exit 1
fi
export ARTIFACT_SERVER_OMP_LIVE_CLI="${omp_cli}"
echo "Using omp CLI: ${omp_cli}"
"${omp_cli}" --version

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
pnpm exec vitest run --config tests/configs/vitest.omp-live.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile.json=project/evidence/omp-live.json
