# @plannotator/artifact-server-pi

The Artifact Server bridge for the [Pi coding agent](https://pi.dev). It
connects a live Pi session to an Artifact Server installation so that
annotation bundles sent from the review UI arrive in Pi as follow-up work,
and Pi replies to and resolves each comment thread through the
`artifact_comments` tool.

## What it does

- Registers this Pi session as an agent (`POST /api/v1/agents`), self-named
  after the working directory. Restarts, `/new`, and `/resume` reclaim the
  same agent identity, so pending bundles survive.
- Long-polls the dispatch mailbox (`POST /api/v1/agents/:id/claims?wait=25`).
  Each claimed bundle is rendered as one message and injected with
  `pi.sendUserMessage(text, {deliverAs: "followUp"})` — always follow-up
  delivery, never steering: Pi finishes its current work first, then receives
  exactly one bundle per work boundary.
- Holds delivery while the session is compacting, and reports `delivered`
  only after Pi accepted the message.
- Registers the `artifact_comments` tool with `get_bundle`, `reply`, and
  `resolve` operations wrapping the comment HTTP routes with the same
  credential, so the agent can close the loop without any human action.
- Fails open. Without configuration it stays dormant after one notice. With
  the server unreachable it backs off between 1 s and 30 s and Pi continues
  normally. No bridge failure is ever thrown into Pi.

## Structural coverage

`tests/client/pi-bridge-core.test.ts` drives the real bridge loop against a
real Artifact Server with a scripted Pi surface:

- Host refusal: a synchronous throw from `pi.sendUserMessage` is the
  protocol's lost-handle signal, so the loop ends dormant without reporting
  `delivered` or `failed` and no exception reaches Pi; the claimed dispatch is
  left for lease expiry. This stays structural-only: no live host surface can
  be made to refuse an injection deterministically.
- Follow-up delivery, registration identity, and the comment tool closing a
  thread.

Live-host qualification against Pi 0.84.4 is recorded in
`project/evidence/pi-live.json` (`pnpm test:pi-live`), 6/6:

- Round trip, FIFO drain, and session rebind (PI-LIVE 1–3).
- Lost acknowledgement (`tests/pi-live/lost-acknowledgement.test.ts`,
  PI-LIVE 4): a destroyed `delivered` report requeues at lease expiry,
  redelivers byte-identically, and settles `delivered` with exactly one report
  ever reaching the server.
- Duplicate lease delivery (`tests/pi-live/duplicate-claim.test.ts`,
  PI-LIVE 5): a replayed claim is admitted twice byte-identically, the second
  `delivered` report is refused 409, and the dispatch never goes `failed`.
- Compaction hold (`tests/pi-live/compaction-hold.test.ts`, PI-LIVE 6): a
  bundle dispatched during a real `/compact` stays `claimed` until
  `session_compact`, then arrives exactly once.

The 1 s → 30 s jittered backoff cap with fail-open dormancy is covered by
`tests/conformance/dsp-012-bridge-fail-open.test.ts` and measured live once
via the OpenCode suite, shared by the common bridge core.

### Changed since the live qualification (structural proof only)

These changes landed after the Pi 0.84.4 live run and have **not** been
re-qualified against a live Pi. They are proven by the scripted Pi surface in
`tests/client/pi-bridge-core.test.ts` against a real Artifact Server:

- The factory validates the extension API surface (`on`, `registerTool`,
  `sendUserMessage`) before registering anything. A build that lacks it stays
  dormant with one notice at the first `session_start` and registers no tool.
  `session_start` validates its context (`cwd`, `ui.notify`); a missing or
  throwing `sessionManager.getSessionId` only costs the optional host session
  id. Both session handlers contain every failure instead of rejecting into
  Pi, and a start superseded by a later boundary never installs a bridge.
- `artifact_comments` sanitizes its final text and its error messages, as a
  second layer over the bridge's own sanitization.
- Bridge fixes carried by this repository's patch of
  `@plannotator/agent-bridge` 0.1.1 (`patches/@plannotator__agent-bridge@0.1.1.patch`):
  `artifact_comments` `get_bundle` leads guest thread bodies and guest
  replies with the guest marker and strips bidirectional and zero-width
  controls from every field; every bridge request is bounded and aborted
  with the session, and the courtesy disconnect gives up after 5 s, so a
  shutdown never waits on a silent server; a stop while the host has not
  yet admitted a bundle leaves it unreported for lease expiry. Structural
  proof: `tests/conformance/prm-008-guest-bundles.test.ts` and
  `tests/client/bridge-core-shutdown.test.ts`.
- **Published npm installs do not get the patch yet.** A pnpm patch applies
  only inside this workspace; `npm install` of this package resolves the
  unpatched `@plannotator/agent-bridge` 0.1.1 from the registry. The release
  workflow refuses to publish the adapters until a patched bridge is
  released upstream and the dependency range is raised past 0.1.1
  (`scripts/check-adapter-bridge-release.mjs`,
  `tests/tooling/adapter-bridge-release-gate.test.ts`). The adapter's own
  final-text sanitization still applies to an unpatched bridge; the guest
  marker in `get_bundle` and the request bounds do not.

## Install

```bash
pi install npm:@plannotator/artifact-server-pi
```

or in `settings.json`:

```json
{
  "packages": ["npm:@plannotator/artifact-server-pi"]
}
```

For development inside this repository:

```bash
pi -e integrations/pi/index.ts
```

## Configuration

Resolved once per session start, in order:

| Source | Setting | Meaning |
| --- | --- | --- |
| Environment | `ARTIFACT_SERVER_ORIGIN` | Server origin, e.g. `https://artifacts.example.com`. Used together with the token below. |
| Environment | `ARTIFACT_SERVER_AGENT_TOKEN` | Bearer credential. Needs `agent:connect` plus comment read/write for the tool; the local API token carries everything. |
| Environment | `ARTIFACT_SERVER_AGENT_NAME` | Optional display-name override (default: the working directory's basename). |
| Local discovery | `~/.artifact-server/local-service.json` | The managed local server's discovery record (loopback origin). |
| Local discovery | `~/.artifact-server/local-api-token` | The local installation's private API credential. |

If neither source resolves, the extension notifies once and stays dormant for
the session. It never blocks a Pi event handler on the network.

## Compatibility

- Pi extension API: tested against `@earendil-works/pi-coding-agent` 0.84.x.
  The bridge fails soft on missing API surface (dormant plus one notice,
  never a crash); that guard is proven structurally, not against a live Pi
  build that lacks the surface.
- The package version tracks Artifact Server releases; it is a client of the
  server's dispatch API (`project/spec/agent-dispatch-spec.md`).
- Ships TypeScript source; Pi loads extensions through jiti with no build
  step.
