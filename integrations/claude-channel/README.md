# Claude Code live feedback

Connect a Claude Code session to Artifact Server through
[Claude Code Channels](https://code.claude.com/docs/en/channels-reference).
Reviewers can send open comment threads to the session. Claude receives the
threads, completes the work, replies, and resolves them in Artifact Server.

## Current support

Claude Code Channels are a research preview. Custom channels require a
development flag. Availability is decided by a server-side feature flag on
the signed-in Claude account; Team and Enterprise administrators must also
enable the `channelsEnabled` organization policy.

The Artifact Server channel is currently available from a source checkout.
The npm package is not published yet.

## Live verification

Last qualified live against **Claude Code 2.1.330** (2026-11-23, 4/4, with
the lifetime and sanitization changes below in place); first qualified
against **Claude Code 2.1.282** (2026-09-24, 3/3). The `tests/claude-live`
suite drives a real `claude` process in a PTY with
the channel loaded through `.mcp.json` and
`--dangerously-load-development-channels`, against a real Artifact Server
and a scripted offline model — no metered provider usage. The round trip
(`CLAUDE-LIVE 1`: the channel registers the session, a dispatch is
`delivered`, the model works the thread through `artifact_comments`, the
thread resolves, and the dispatch reads `addressed`), a lost `delivered`
acknowledgement (`CLAUDE-LIVE 2`: the report is dropped before it reaches
the server, the bundle is requeued at lease expiry and redelivered
byte-identically, the host tolerates the duplicate channel event, and the
dispatch settles `delivered` — never `failed`), and a duplicate lease
delivery (`CLAUDE-LIVE 3`: a replayed claim delivers a second,
byte-identical channel event, the second `delivered` report is refused with
409 `DISPATCH_STATE_CONFLICT`, and settlement stays singular) all pass.
`CLAUDE-LIVE 4` runs the round trip again with the server's tools forced
deferred (see below). Evidence: `project/evidence/claude-live.json`
(`pnpm test:claude-live` re-runs it).

### Tool search (found on 2.1.330)

Claude Code defers MCP tools behind its `ToolSearch` step by default, and
since 2.1.304 it does this behind an `ANTHROPIC_BASE_URL` gateway too. A
deferred tool is left out of the request's `tools` until the model loads it.
On 2.1.330 the round trip failed with `No such tool available:
artifact_comments` (kept as
`project/evidence/claude-live-2026-11-23-deferred-tool.failed.json`; the
same failure reproduced on the pre-merge commit, so it was host drift).

This affected real sessions too, not just the suite. In a fresh session
whose first message is the channel event, the bundle turn on 2.1.330 had no
deferred-tool list in context yet. The model saw only the channel's
instruction to use `artifact_comments`, and calling it directly failed. A
model that searched first would recover, at the cost of a round trip per
session.

The fix is in the channel, not the suite: `artifact_comments` is listed with
`_meta: {"anthropic/alwaysLoad": true}`, the per-tool marker Claude Code
documents for MCP server authors, so it is always in the request.
`CLAUDE-LIVE 1` asserts the tool is advertised on the bundle turn.
A user can still force the server deferred with `"alwaysLoad": false` on its
`.mcp.json` entry. `CLAUDE-LIVE 4` covers that path: the tool is absent on the
bundle turn, the model loads it with one `ToolSearch` query for
`artifact_comments`, and the thread still closes and the dispatch reads
`addressed`.

The suite's isolated HOME seeds the account feature-flag cache
(`cachedGrowthBookFeatures.tengu_harbor` in `.claude.json`), because a
signed-out install has no bootstrap to fetch the flag from.

## Structural coverage

`tests/client/claude-channel.test.ts` drives the real channel process over
stdio against a real spawn, so every claim below is observed through the
process boundary, not a mock:

- Missing configuration: with no credentials the channel registers nothing,
  pushes no notification, and answers `artifact_comments` with the real reason
  ("Artifact Server is not configured; the bridge is dormant") instead of
  pretending to work.
- Follow-up delivery as one `notifications/claude/channel` event, its
  sanitization, and the tool closing both threads.
- `tools/list` advertises `artifact_comments` with
  `_meta: {"anthropic/alwaysLoad": true}`, so the ordinary gate catches a
  regression of the tool-search fix without the live suite.

Host-agnostic behaviors are covered once for every adapter by the extracted
bridge core: the structural floor is
`tests/conformance/dsp-006-claim-lease.test.ts` (lost acknowledgement and
duplicate lease delivery — both also proven live here as `CLAUDE-LIVE 2` and
`CLAUDE-LIVE 3`) and `tests/conformance/dsp-012-bridge-fail-open.test.ts`
(the 1 s → 30 s jittered backoff cap with fail-open dormancy — measured live
once for every adapter by the opencode suite's `OPENCODE-LIVE 4`, since the
backoff lives in the shared core).

Two behaviors are recorded gaps rather than tests:

- **Compaction hold is not applicable.** No compaction signal crosses the
  stdio boundary (`isCompacting()` is always false); Claude Code queues channel
  events itself while the session is busy.
- **Asynchronous notification refusal is not structurally separable.** This
  tier's delivery evidence is transport admission, and the only way to make
  the notification reject in this harness is to close the transport, which the
  adapter maps to bridge shutdown. The live round trip above is the current
  evidence; T17 tracks the gap.

### Changed since the Claude Code 2.1.282 qualification

These changes landed after the Claude Code 2.1.282 live run. The 2.1.330 run
on 2026-11-23 had them in place and passed 4/4, so they no longer break the
live paths. Their own behavior (the session-end and signal paths) is still
proven only by spawning the real channel process in
`tests/client/claude-channel-lifetime.test.ts`:

- The channel lives exactly as long as its session. The MCP SDK's stdio
  transport never watches stdin for end-of-file, so the channel does: stdin
  ending or closing, a broken stdout, or the MCP connection closing stops the
  bridge, sends the courtesy disconnect, and exits. Previously a channel whose
  Claude Code had died kept claiming bundles and could report them
  `delivered` into a dead pipe. A bundle whose write races the session's end
  is left unreported for lease expiry, never reported `delivered`.
- The close hook is the SDK's `Server.onclose`, which the SDK chains from the
  transport handler it installs; the channel no longer replaces that handler
  by assigning `transport.onclose`.
- A second `SIGINT`/`SIGTERM` while the stop is pending exits immediately
  (status 1), and any stop still pending after 10 s is abandoned.
- `artifact_comments` sanitizes its final text and its error messages, as a
  second layer over the bridge's own sanitization.

Not proven: what a live Claude Code does to the channel process on exit
(closing stdin, signalling, or both). The stdin and signal paths are each
covered structurally.
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

## Before you start

Before you start, make sure that:

- Artifact Server is running.
- The Artifact Server source is available locally.
- Node.js 24.12.0 or later is installed.
- pnpm 10.34.3 is installed.
- Claude Code supports Channels.

From the Artifact Server source directory, install the dependencies:

```bash
pnpm install
```

## Connect to Artifact Server

### Local installation

If `artifactserver start` runs the server, the channel reads the connection
from these files:

- `~/.artifact-server/local-service.json`
- `~/.artifact-server/local-api-token`

No additional connection settings are necessary.

If `pnpm dev` runs the server from source, set the origin and token in the
shell that starts Claude Code:

```bash
export ARTIFACT_SERVER_ORIGIN="http://127.0.0.1:8787"
export ARTIFACT_SERVER_AGENT_TOKEN="$(<.artifact-server/local-api-token)"
```

Run these commands from the Artifact Server source directory. Do not print or
commit the token.

### Team installation

Ask an Artifact Server administrator to issue an API key with these
permissions:

- **Connect agents**
- **Manage comments**

Set the server origin and API key in the shell that starts Claude Code:

```bash
export ARTIFACT_SERVER_ORIGIN="https://artifacts.example.com"
export ARTIFACT_SERVER_AGENT_TOKEN="replace-with-the-api-key"
```

Do not add the API key to `.mcp.json` or source control.

You can also set `ARTIFACT_SERVER_AGENT_NAME` to change the session name that
appears in Artifact Server. The default name is the current directory name.

## Add the channel to Claude Code

Add this entry to `.mcp.json` in the project where you use Claude Code:

```json
{
  "mcpServers": {
    "artifact-server": {
      "command": "node",
      "args": [
        "/absolute/path/to/artifact-server/integrations/claude-channel/bin/claude-channel.js"
      ]
    }
  }
}
```

Replace the example path with the absolute path to your Artifact Server
checkout.

## Start Claude Code

Start Claude Code from the project that contains `.mcp.json`:

```bash
claude --dangerously-load-development-channels server:artifact-server
```

Claude Code shows a warning for the development channel. Select **I am using
this for local development**. If Claude Code also asks whether to use the MCP
server, select **Use this MCP server**.

## Send comments to Claude

1. Open an artifact in Artifact Server.
2. Add one or more comments.
3. Select the Claude session in the agent picker.
4. Send the open comments to the session.

Claude receives the comments as follow-up work. The channel gives Claude the
`artifact_comments` tool to read, reply to, and resolve each thread.

## Troubleshooting

If the channel does not start, run `/mcp` in Claude Code. Make sure that the
server entry uses the correct absolute path.

If Claude Code reports that an organization policy blocked the channel, ask
an administrator to enable `channelsEnabled`.

If the channel starts but no agent appears in Artifact Server, make sure that
Artifact Server is running. Then make sure that the connection settings are
available in the shell that started Claude Code.

If `MCP_PROTOCOL_NEGOTIATION=auto` is set, Claude Code can reject the MCP
version of the channel. Unset the variable. Then restart Claude Code.

Claude Code writes channel errors to
`~/.claude/debug/<session-id>.txt`.
