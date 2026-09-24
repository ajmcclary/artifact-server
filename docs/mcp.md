# Connect AI agents with MCP

Artifact Server exposes one MCP endpoint at `POST /mcp`. MCP uses the same product operations and permissions as the CLI and HTTP API.

## Connect a local client

Run the automatic connection command:

```sh
artifactserver connect
```

If more than one supported client is installed, select one client:

```sh
artifactserver connect codex
artifactserver connect claude
artifactserver connect cursor
artifactserver connect vscode
```

Inspect or remove a managed connection:

```sh
artifactserver doctor codex
artifactserver disconnect codex
```

The command registers a local stdio bridge. The bridge starts or locates the local service and handles its private credential.

The credential does not appear in client configuration, command output, or startup logs.

## Connect to a team server

Add the exact MCP address to the client:

```text
https://artifacts.example.com/mcp
```

The client opens the configured identity provider. Complete browser authorization, then return to the client.

The access token is valid for that exact `/mcp` resource. A token for another installation or application resource does not qualify.

## Publish from an agent

MCP sends metadata and small results. Artifact files use the staged upload API.

An agent uses this sequence:

1. Call `artifact_capabilities` to read limits and available features.
2. Call `artifact_create_upload` with each path, size, media type, and SHA-256 fingerprint.
3. Upload each file to its returned opaque upload URL.
4. Call `artifact_commit_upload` with the publication target and idempotency key.

When the agent publishes a new version, it first reads the current version ID. It sends that ID as `expectedCurrentVersionId`.

The current upload URLs are scoped binary PUTs on the application origin.
Provider-native signed transfers and operation-status/file-resume tools are
planned work, not current capabilities. Retain the publication idempotency key
when reconciling an uncertain commit; do not assume a lost response means no
version was saved.

`artifact_capabilities` reports the detected MCP protocol era and wire revision
in `protocol.era` and `protocol.version`.

`artifact_get` accepts an optional `projection` argument. Use `projection: "full"`
(default) for the complete manifest, including every `manifest.entries` item, or
`projection: "compact"` to omit `manifest.entries` while keeping
`manifest.digest`, `manifest.entryPath`, `manifest.routingMode`, and
`manifest.entryCount`.

`artifact_create_upload` accepts an optional `idempotencyKey`. Replaying the same
key before commit returns the same upload plan with `resumed: true`. After the
publication commits, the same key returns the committed publication. Reusing the
key with a different manifest before commit returns `IDEMPOTENCY_CONFLICT`.

`artifact_version_list` returns every saved version; pagination is not yet
implemented. Modern stateless MCP HTTP and legacy compatibility are both
supported. Subscriptions remain unavailable until a shared event service has its
own replay, authorization, and recovery proof.

## Use the publication result

Every successful publication returns structured data and a short text summary.

```json
{
  "links": {
    "review": "https://artifacts.example.com/review?...&view=focus",
    "artifact": "https://artifacts.example.com/artifacts/art_example",
    "version": "https://ver-example.content.example.com/"
  }
}
```

The server instructions tell the agent to share `links.review` first. This link opens the exact version full screen with comments.

`links.artifact` follows the current version. `links.version` opens the immutable raw artifact without the Artifact Server interface.

The agent must not place bootstrap URLs, access tokens, or credentials in chat.

Read operations use the same link roles. `artifact_get.current.links.review`
opens the current exact version in full-screen Review. `artifact_open.reviewUrl`
opens the selected exact version in Review, while `artifact_open.browserUrl`
opens its raw immutable content. Agents should hand people the Review URL.

## Tool groups

| Group | Tools |
| --- | --- |
| Discovery | `artifact_capabilities` |
| Projects | `project_list`, `project_create`, `project_rename`, `project_archive`, `project_unarchive` |
| Artifacts | `artifact_list`, `artifact_get`, `artifact_open`, `artifact_version_list`, `artifact_diff` |
| Publication | `artifact_create_upload`, `artifact_commit_upload` |
| Management | `artifact_set_visibility`, `artifact_set_tags`, `artifact_restore_version`, `artifact_delete` |
| Linked files | `artifact_link`, `artifact_relink`, `artifact_capture` |
| Comments | `comment_list`, `comment_get`, `comment_create`, `comment_reply`, `comment_update`, `comment_resolve`, `comment_delete`, `comment_clear` |
| Git history | `project_git_history_status`, `project_git_history_estimate`, `project_set_git_history`, `artifact_history_clone_token` |

## Work with linked files

A linked artifact tracks a file that stays on the server's own machine instead of storing an uploaded snapshot.

- `artifact_link` registers an absolute path as an artifact and captures its current bytes as the first version.
- `artifact_capture` saves the source file's current bytes as a new immutable version. Pass the artifact's current version ID as `expectedCurrentVersionId`. Capturing an unchanged source returns the current version rather than saving a duplicate.
- `artifact_relink` re-points an artifact at the same file in a new location. The move is accepted only when the file at the new path hashes to `expectedSha256`, so a rename cannot silently swap in different content. Versions, comments, and the artifact ID are untouched.

These tools are always listed, so call `artifact_capabilities` first and read `linkedArtifacts.available`: they work only on a local installation with linked files enabled. MCP never carries file bytes — pass the absolute path and let the server read the file itself. A source that changes mid-read fails with `SourceDrifted` and saves no version; retry the same call.

## Clear comment threads in bulk

`comment_clear` deletes every matching thread on one artifact — `resolved`, or `all` — together with its replies, recording one ledger action per thread. Threads held by queued, claimed, or delivered dispatches are skipped and counted rather than deleted. Cancel queued or claimed work, or resolve delivered work, before clearing those.

## Enable optional Git history

`project_set_git_history` enables one project only after an authorized caller confirms a fresh estimate. Provider configuration alone copies nothing. Read `project_git_history_status` and `project_git_history_estimate` first.

Agents should report the returned project state and must not describe `waiting`, `degraded`, or `budget-limited` history as ready.

`artifact_history_clone_token` issues a short-lived read credential for one artifact's derived repository. Use it directly for a clone; never quote it back to the user. See [Cloudflare Artifacts](./cloudflare-artifacts.md).

## Receive review feedback in a live session

A person can select comment threads in Review and send them to a connected coding-agent session. The agent replies to each thread and resolves it, closing the loop without copying feedback by hand.

Adapters ship for Pi, Oh My Pi, OpenCode, and Claude Code Channels. Any harness can implement the same loop — see the [agent bridge protocol](./agent-bridge-protocol.md).

An MCP-capable host can use `comment_reply` and `comment_resolve` for the return path instead of the HTTP comment routes. The effect is identical.

## Install the Artifact Server skill

Install the portable Agent Skill:

```sh
npx skills add ajmcclary/artifact-server
```

The skill routes artifact work and explicit server-administration work to separate internal instructions. It uses the CLI for files on the developer machine and MCP for server data and agent-held context.

In clients that expose installed skills as slash commands, publish finished work with a request such as:

```text
/artifact-server upload that HTML design doc
```

The agent returns the full-screen review link first so the recipient can view and comment on the exact version.

Read the [MCP product baseline](../project/spec/artifact-server-mcp-baseline.md) for the protocol and authorization contracts.
