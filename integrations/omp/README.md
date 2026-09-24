# @plannotator/artifact-server-omp

The Artifact Server bridge for [Oh My Pi (omp)](https://omp.sh), the
Pi-compatible coding agent. It connects a live omp session to an Artifact
Server installation so that annotation bundles sent from the review UI
arrive in omp as follow-up work, and omp replies to and resolves each
comment thread through the `artifact_comments` tool.

omp is a fork of the Pi coding agent. This adapter targets omp's extension
API directly (the `@oh-my-pi` runtime), and the Pi adapter in this
repository remains the one for stock Pi (`@earendil-works`).

## What it does

- Registers this omp session as an agent (`POST /api/v1/agents`), self-named
  after the working directory. Restarts, `/new`, `/resume`, `/reload`, and
  `/fork` reclaim the same agent identity, so pending bundles survive.
- Long-polls the dispatch mailbox (`POST /api/v1/agents/:id/claims?wait=25`).
  Each claimed bundle is rendered as one message and injected with
  `om.sendUserMessage(text, {deliverAs: "followUp"})` — always follow-up
  delivery, never steering: omp finishes its current work first, then
  receives exactly one bundle per work boundary.
- Holds delivery while the session is compacting, and reports `delivered`
  only after omp accepted the message.
- Registers the `artifact_comments` tool with `get_bundle`, `reply`, and
  `resolve` operations wrapping the comment HTTP routes with the same
  credential, so the agent can close the loop without any human action.
- Fails open. Without configuration it stays dormant after one notice. With
  the server unreachable it backs off between 1 s and 30 s and omp continues
  normally. No bridge failure is ever thrown into omp.

## Install

omp auto-discovers extensions in `~/.omp/agent/extensions/`. Install this
package, then load its entry as an extension:

```bash
npm install -g @plannotator/artifact-server-omp
```

and add `~/.omp/agent/extensions/artifact-server-omp.ts` containing:

```ts
export {default} from "@plannotator/artifact-server-omp";
```

Alternatively, if your omp build supports the Pi-style `pi` extension
manifest (this package ships one), `omp install` / the settings `packages`
array may load it directly.

For development inside this repository:

```bash
# Run omp with the local entry as an extension.
omp --extension /path/to/artifact-server/integrations/omp/index.ts
```

(Check `omp --help` for the exact extension flag on your version.)

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
the session. It never blocks an omp event handler on the network.

## Compatibility

- omp extension API: the adapter types its narrow API slice structurally and
  keeps no hard dependency on omp's own type package. Live-host qualification
  has run against **omp 18.2.11** (2026-09-24): the `tests/omp-live` suite
  drives a real omp process in a PTY with this extension loaded against a
  real Artifact Server and a scripted offline model — round trip
  (`OMP-LIVE 1`), FIFO drain (`OMP-LIVE 2`), session replacement
  (`OMP-LIVE 3`), a lost `delivered` acknowledgement requeued at lease
  expiry and redelivered byte-identically (`OMP-LIVE 4`), a duplicate lease
  delivery tolerated by the host with singular settlement (`OMP-LIVE 5`),
  and a bundle held through a real `/compact` compaction and released at the
  compaction boundary (`OMP-LIVE 6`) all pass. Evidence:
  `project/evidence/omp-live.json` (`pnpm test:omp-live` re-runs it). Events
  exercised live: `session_start`, `session_shutdown`, `registerTool`,
  `sendUserMessage`, and the compaction pair (`session_before_compact` /
  `session_compact`). A synchronous refusal is covered by the structural test
  `tests/client/omp-bridge.test.ts`: a throw from `sendUserMessage` is the
  protocol's lost-handle signal, so the loop ends dormant without reporting
  `delivered` or `failed` and the claimed dispatch is left for lease expiry.
  It is not exercisable live — `sendUserMessage` is a synchronous void call
  that does not refuse an admitted message. The 1 s → 30 s jittered backoff
  cap lives in the shared bridge core and is measured live once for every
  adapter by the opencode suite (`OPENCODE-LIVE 4`); the structural floor is
  `tests/conformance/dsp-012-bridge-fail-open.test.ts`.
- Host behaviors observed on omp 18.2.11 during live qualification:
  - `/new` emits no session lifecycle events at all (no `session_shutdown`,
    no new `session_start`): the extension host survives, so the original
    registration stays connected and the replacement session inherits the
    pending FIFO through it. The agent row's `agentSessionId` keeps the first
    session's value.
  - A bundle accepted while the session is fully idle does not start a turn
    on its own; it drains at the next work boundary (the user's next
    prompt). While the session is busy, bundles drain one per boundary.
  - A duplicate lease delivery is admitted, not deduplicated: the replayed
    bundle is queued as a second, byte-identical follow-up. The server
    refuses the second `delivered` report with 409
    `DISPATCH_STATE_CONFLICT`, so settlement stays singular.
  - `/compact` refuses with "Nothing to compact (session too small)" unless
    the branch holds more than `compaction.keepRecentTokens` (default
    20000) tokens, and its soft-compaction summarization calls carry a
    "Summarize user–AI coding-assistant conversations" system prompt —
    the live compaction-hold test pads the first exchange past the floor
    and detects the summarization turn by that prompt. The padding must
    not repeat an exact character cycle: omp's loop guard aborts such
    streams.
  - Terminal input typed while a model turn is in flight is queued as input,
    not executed as a command, so `/new` cannot be issued mid-work.
- omp's `session_shutdown` event does not carry the `reason` field that Pi's
  does (`reason: "quit" | "reload" | "new" | ...`). This adapter therefore
  sends the courtesy disconnect on every shutdown rather than only on a
  confirmed quit; that is safe because registration identity is a stable
  upsert keyed on (hostname, workingDirectory), so a successor session
  reclaims the same agent row on its own `session_start`.
- The bridge fails soft on missing API surface (dormant plus one notice,
  never a crash).
- The package version tracks Artifact Server releases; it is a client of the
  server's dispatch API (`project/spec/agent-dispatch-spec.md`).
- Ships TypeScript source; omp loads extensions through its own loader with
  no build step.
