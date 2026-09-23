# Artifact Server agent instructions

Build toward the contracts in `project/spec/conformance.yml`. Product prose lives in `project/spec/artifact-server-product-spec.html`; the ledger is the machine-checkable index of its promises.

## Engineering rules

- Keep product logic independent of SQLite, disk storage, HTTP, MCP, and deployment providers.
- Put concrete providers behind narrow ports named for product behavior.
- Do not weaken TypeScript, Oxlint, or anti-slop rules to make a change pass.
- Do not use module mocks. Tests should use real application services, temporary disk storage, temporary SQLite databases, and real HTTP boundaries where those behaviors matter.
- Test observable behavior and failure recovery, not private implementation details.
- Name conformance tests with their requirement IDs, such as `ART-004-B` and `ART-004-F`.
- A feature is not complete until its normal and hostile tests pass and durable evidence can be attached to the ledger.
- Preserve immutable version bytes and IDs across retries, crashes, restarts, and restores.
- Never let untrusted paths, hostnames, tokens, or installation IDs select raw storage locations.
- Linked files are a local-only capability. A link path must resolve inside a configured `ARTIFACT_SERVER_LINK_ROOTS` root, and an external-storage runtime must refuse to start with linked files enabled.
- Sanitize untrusted human text that reaches an agent's context. Comment bodies, bundle notes, and quoted selections are stripped of bidirectional overrides and zero-width characters in the bridge render path.

## Agent bridge adapters

The adapters in `integrations/` (Pi, omp, OpenCode, Claude Code Channels) implement the [agent bridge protocol](docs/agent-bridge-protocol.md). Its citizenship rules are binding engineering rules here:

- Deliver bundles as follow-up input only. Never steer, interrupt, or preempt a host session.
- Fail open toward the host and closed toward the server: a bridge failure goes dormant with one notice rather than degrading the host's own work, and an uncertain delivery is never reported `delivered`.
- Never throw into the host. Contain every exception at the bridge boundary.
- Back off from 1 second to a 30-second ceiling with jitter. No error path may spin or sleep past the ceiling.
- Type each host's API as a narrow structural slice rather than depending on the host's own type package.

An adapter that only typechecks is not qualified. Mark live-host verification status honestly in its README.

## Learning more about Effect

This repository uses the Effect TypeScript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the
guide does not cover, search through the source code in `node_modules/effect/src`.

## Performance verification

- `pnpm verify:iteration` is the canonical end-of-iteration gate. It runs the complete correctness, conformance, build, coverage report, smoke, and bounded performance path.
- Run the critical cross-engine browser matrix after changing Review sandboxing, exact-version leases, historical asset delivery, or comment convergence: install the engines once with `pnpm exec playwright install firefox webkit`, then run `BROWSER_CRITICAL_ENGINES=all pnpm test:web`. The CI full gate sets `BROWSER_CRITICAL_ENGINES=all` and installs all three engines; the PR job stays Chromium-only, so a matrix break surfaces at the full gate rather than on every pull request.
- Coverage is diagnostic. Do not add a test only to move a percentage, lower a threshold, or exercise an implementation detail. A test must prove an observable product behavior, security boundary, recovery path, or measured performance characteristic.
- Run `pnpm smoke` after changing HTTP delivery, publication, SQLite, blob storage, restart behavior, or cleanup.
- Run `pnpm perf:baseline` before and after a performance-sensitive change. Compare the same machine, Node version, workload, and storage class.
- Run `pnpm verify:object-storage` after changing remote blob or staging storage. It requires Docker and proves the S3-compatible adapter against pinned MinIO.
- Run `pnpm verify:external-storage-runtime` after changing Postgres persistence, external-storage composition, external-storage configuration, migrations, or backup behavior. It requires Docker and drives multiple compiled server processes against pinned Postgres and MinIO.
- Run `pnpm verify:external-storage-performance` after changing the compiled external-storage publish/read path, Postgres query shape, S3 object operations, connection-pool settings, or file-client concurrency. It requires Docker and records a bounded two-process Postgres/MinIO baseline.
- Treat `project/performance/FINDINGS.md` as the current risk register, not as a permanent excuse for a known bottleneck.
- Do not tighten machine-timing gates from one laptop run. CI smoke limits catch gross failures; controlled repeated baselines establish regression budgets.
- Do not reintroduce inline base64 publication to add large-file support. Use the specified staged direct-upload and streaming-delivery paths.

## Live provider qualification

- Treat every live suite as metered even when the account is on a free plan. Before a run, confirm the active account, current allowance and overage behavior; record the dated snapshot in the relevant evidence file and `project/performance/CLOUDFLARE-COST-ENVELOPE.md`.
- Keep provider credentials outside the repository. Prefer named local profiles or provider identity chains, and record hashes, principal names, resource names and restrictive file modes rather than credential values.
- The Cloudflare account probe uses a private configuration outside the repository and exact `probe-` resource names. Its operator needs Workers Scripts, D1 and R2 edit plus Account Settings read; current Alchemy state bootstrap also needs Secrets Store edit. Never use wildcard cleanup, and do not treat a passing lifecycle-only probe as runtime qualification.
- The local AWS external-storage setup uses the `artifact-server-runtime` profile and the exact private bucket recorded in `project/evidence/aws-runtime-storage.json`. A deployed AWS workload should use its task role rather than copying this long-lived local key.
- Preserve failed live evidence. A created/deployed/cleaned resource lifecycle and an HTTP runtime pass are separate claims, as are host registration and end-to-end bridge delivery.

## Before handing off work

Run `pnpm verify:iteration`. Report any requirement that is still specified but not proved; do not mark it verified optimistically.
