# @plannotator/artifact-server-opencode

The Artifact Server bridge for [OpenCode](https://opencode.ai). It connects
an OpenCode instance to an Artifact Server installation so that annotation
bundles sent from the review UI arrive in the active OpenCode session as
follow-up prompts, and the agent replies to and resolves each comment thread
through the `artifact_comments` tool.

## What it does

- Registers this OpenCode instance as an agent (`POST /api/v1/agents`,
  kind `opencode`, capabilities `{beacon: true, evidence: "native"}`),
  self-named after the project directory. Restarts reclaim the same agent
  identity, so pending bundles survive.
- Long-polls the dispatch mailbox (`POST /api/v1/agents/:id/claims?wait=25`).
  Each claimed bundle is rendered as one message and injected with
  `client.session.promptAsync` into the most recently active top-level
  session — follow-up delivery, never steering or interrupt: OpenCode
  queues the prompt server-side and the running loop picks it up at its
  next work boundary. Subagent (task) sessions are never targeted.
- Holds delivery while no top-level session exists yet or while the target
  session is compacting (`experimental.session.compacting` hook, cleared by
  the `session.compacted` event, bounded at five minutes).
- Registers the `artifact_comments` tool (`get_bundle`, `reply`, `resolve`)
  through OpenCode's plugin tool hook, wrapping the comment HTTP routes with
  the same credential, so the agent closes the loop without human action.
- Sends the best-effort activity beacon at the natural work boundaries
  (bundle accepted → thinking, first reply → replying, last thread
  resolved → idle).
- Fails open. A plugin context without the expected surface, or no resolved
  configuration, leaves the bridge dormant; an unreachable server only
  produces bounded backoff (1–30 s). No bridge failure is ever thrown into
  OpenCode. Notices go through `client.tui.showToast` and are dropped
  silently on headless hosts.

## Install

Add the package to your OpenCode config:

```json title="opencode.json"
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@plannotator/artifact-server-opencode"]
}
```

For development inside this repository, copy or symlink `index.ts` into a
plugin directory (`.opencode/plugins/` or `~/.config/opencode/plugins/`)
with `@plannotator/agent-bridge` and `zod` resolvable (see OpenCode's
plugin-dependency docs).

## Configuration

Resolved once when the plugin loads, in order:

| Source | Setting | Meaning |
| --- | --- | --- |
| Environment | `ARTIFACT_SERVER_ORIGIN` | Server origin, e.g. `https://artifacts.example.com`. Used together with the token below. |
| Environment | `ARTIFACT_SERVER_AGENT_TOKEN` | Bearer credential. Needs `agent:connect` plus comment read/write for the tool; the local API token carries everything. |
| Environment | `ARTIFACT_SERVER_AGENT_NAME` | Optional display-name override (default: the project directory's basename). |
| Local discovery | `~/.artifact-server/local-service.json` | The managed local server's discovery record (loopback origin). |
| Local discovery | `~/.artifact-server/local-api-token` | The local installation's private API credential. |

If neither source resolves, the bridge notifies once (when a TUI is
attached) and stays dormant.

## Pinned OpenCode version

Coded and verified against the OpenCode source at version **1.18.18**
(`@opencode-ai/plugin` 1.18.18, repository commit `ad905f8e6c`, dev branch,
2026-08-18), using the **V1 plugin API** (`(input) => Promise<Hooks>`). A
beta V2 plugin API (`@opencode-ai/plugin/v2/*`) exists at that commit; this
adapter deliberately pins V1, the API OpenCode loads for plain exported
plugin functions.

## Verified vs. assumed

Verified by reading the pinned source:

- Plugins load in-process and receive `client`, an SDK client bound to the
  same OpenCode server instance that backs the TUI.
- `client.session.promptAsync` (`POST /session/:id/prompt_async`) answers
  204 once the prompt is accepted; while the session is busy the appended
  user message is picked up at the running loop's boundary — real
  follow-up semantics. Interrupt would be `session.abort`; this bridge
  never uses it, and steering is not claimed. The bridge awaits that answer
  before it reports `delivered`; a refusal reports the dispatch `failed` and
  leaves the plugin available for later bundles.
- Plugins register model-callable tools through the `tool` hook (zod
  argument shapes converted to JSON Schema by OpenCode's tool registry),
  so `artifact_comments` is a native tool — no MCP fallback needed.
- `client.tui.showToast` exists as the notification surface.
- Compaction is observable via the `experimental.session.compacting` hook
  and the `session.compacted` event.

Verified by the fake plugin context against a real spawned Artifact Server:

- Deleting the target session while `promptAsync` is pending makes that
  dispatch fail and releases its comments. Selecting another session lets the
  same bridge deliver the next dispatch without restarting OpenCode.
- A bundle claimed while the target session is compacting stays `claimed` and
  no prompt is injected; `session.compacted` releases it and the follow-up
  lands as one prompt on that session.
- A missing plugin surface fails open: no registration, no crash, and an
  honest tool error.

Qualified live against **OpenCode 1.18.32**: 7/7 on 2026-09-24, and 7/7
again on 2026-11-23 against `main` at `d2dfdbb`, with the merged bridge fixes
below in place. The `tests/opencode-live` suite drives a real `opencode serve` plus
`run --attach` clients with this plugin loaded against a real Artifact
Server and a scripted offline model — round trip (`OPENCODE-LIVE 1`), FIFO
drain (`OPENCODE-LIVE 2`), fail-open against an unreachable origin
(`OPENCODE-LIVE 3`), the 1 s → 30 s jittered retry-backoff cap measured on
destroyed registration attempts (`OPENCODE-LIVE 4`), a lost `delivered`
acknowledgement requeued at lease expiry and redelivered byte-identically
(`OPENCODE-LIVE 5`), a duplicate lease delivery tolerated by the host with
singular settlement (`OPENCODE-LIVE 6`), and a bundle held through a real
auto-compaction and released at the compaction boundary (`OPENCODE-LIVE 7`)
all pass. Evidence: `project/evidence/opencode-live.json`
(`pnpm test:opencode-live` re-runs it). The cross-instance zod interop below
is exercised by that suite, since the plugin loads through OpenCode's own
Bun plugin loader.

Host behaviors observed on OpenCode 1.18.32 during live qualification:

- A `run --attach` client exits shortly after its first paint; the server
  keeps the session alive and processes queued follow-up prompts one per
  work boundary. Host observation therefore goes through the `opencode
  serve` HTTP API (`GET /session`, `GET /session/:id/message`), not the
  attach client's terminal output.
- OpenCode makes a small title-generation model call before the main
  prompt's call, so turn indexes in a scripted-model harness are offset
  by one.
- A duplicate lease delivery is admitted, not deduplicated: the replayed
  bundle enters the session as a second, byte-identical follow-up. The
  server refuses the second `delivered` report with 409
  `DISPATCH_STATE_CONFLICT`, so settlement stays singular.
- Manual compaction is not available in 1.18.32 (`/api/session/:id/compact`
  answers 503 "Session compact is not available yet" and the legacy route
  serves the SPA), but auto-compaction is: a turn whose reported usage
  overflows the model's context window compacts the session, fires the
  `experimental.session.compacting` hook and `session.compacted` event, and
  runs a summarization call whose system prompt names it a "context
  summarization agent". The live compaction hold drives that path.

Still not covered live:

- The `experimental.*` hook names are marked experimental by OpenCode and
  may change in later versions; the bridge degrades to "no compaction
  hold" if they stop firing. The scripted plugin-context test
  (`tests/client/opencode-bridge.test.ts`) covers that degradation and the
  hold-starting-while-a-delivery-is-pending race, which the live suite
  cannot schedule deterministically.
- Host refusal of an admitted bundle is not deterministically exercisable
  on this host: deleting the target session removes the delivery target
  (the two-minute target-loss hold), it does not make `promptAsync` refuse.
  Refusal remains covered by the scripted plugin-context test.
- The
  [August 27 staging report](../../project/research/STAGING-E2E-REPORT-2026-08-27.md)
  separately records a bounded live pass on OpenCode 1.18.23. It does not prove
  every compaction or session-deletion race. Any remaining live qualification
  is tracked in [T17](../../docs/archive/planning-2026-10-08/NEXT-STEPS.md#t17-complete-live-bridge-qualification-without-changing-citizenship).

### Changed since the 2026-09-24 qualification

These changes landed after the first OpenCode 1.18.32 live run. The
2026-11-23 re-run had all of them in place and passed 7/7, so they no longer
break the live paths. The races and failure paths they target (a child
session's compaction overlapping the target's, `dispose` before admission,
guest markers, request bounds) are not driven by the live suite. They are
still proven only by the scripted plugin context in
`tests/client/opencode-bridge.test.ts` against a real Artifact Server:

- Compaction is tracked per session id. A subagent (child) session's
  compaction window can no longer overwrite or end the target session's
  hold; previously one slot held whichever session compacted last.
- `dispose` while OpenCode has not yet admitted a prompt returns promptly
  and reports nothing, leaving the uncertain delivery for lease expiry.
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

## Compatibility

- The package version tracks Artifact Server releases; it is a client of
  the server's dispatch API (`project/spec/agent-dispatch-spec.md`).
- Ships TypeScript source; OpenCode loads plugins with Bun, no build step.
