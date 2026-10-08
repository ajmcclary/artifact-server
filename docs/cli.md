# Command-line interface

Agents normally publish through the [Artifact Server Skill](../skills/artifact-server/SKILL.md) or [MCP](./mcp.md). Use the CLI when you want to publish directly, link a working file, or run operator commands from a terminal.

The `artifactserver` command ships in the packaged release. Download it from the [latest GitHub release](https://github.com/ajmcclary/artifact-server/releases/latest), or run it from a source checkout by replacing `artifactserver` with `pnpm artifactserver`.

Every command prints JSON on success. Do not add a `--json` flag; there is none.

## Command reference

| Command | Purpose |
| --- | --- |
| `publish <path>` | Publish one file or a finished directory. |
| `link <path>` | Link a file on this machine as an artifact that tracks it. |
| `auth login <server>` | Sign in to one exact origin and save a profile. |
| `auth status [profile]` | Verify saved profiles without printing credentials. |
| `auth logout [profile]` | Remove one saved credential and profile. |
| `connect [client]` | Connect Artifact Server to an installed AI client. |
| `disconnect [client]` | Remove Artifact Server from one AI client. |
| `doctor [client]` | Inspect local MCP service and client setup without changing it. |
| `mcp` | Serve the local Artifact Server over MCP stdio. |
| `open` | Open the local Artifact Server application in a browser. |
| `start` | Start one direct local Artifact Server process. |
| `history clone <artifact> [dir]` | Clone one artifact's derived Git history. |
| `history checkout-project <project> [dir]` | Clone every provisioned history in a project. |
| `history purge` | Plan or apply permanent removal of derived repositories. |
| `init` | Initialize an empty compact data directory. |
| `start-compact` | Start an initialized compact team server. |
| `start-external-storage` | Start one stateless Postgres and object-storage process. |
| `config check` | Parse and inspect one exact runtime configuration. |
| `migrate status` / `migrate apply` | Inspect or apply external-storage migrations. |
| `support manifest` | Print product, schema, provider, and configuration versions. |
| `integrity check` | Verify committed records and bytes without repairing them. |
| `maintenance cleanup-staging` | Remove expired uploads that were never committed. |

Run `artifactserver --help` or `artifactserver <command> --help` for the authoritative reference.

## Publish an artifact

Publish one finished file or a complete directory:

```sh
artifactserver publish ./report.pdf
artifactserver publish ./dist --public --name "Product prototype" --tag prototype
```

Publication returns JSON with three browser links:

| Link | Purpose |
| --- | --- |
| `links.review` | Opens the exact version full screen with comments. Share this link first. |
| `links.artifact` | Opens the stable link that follows the current version. |
| `links.version` | Opens the immutable raw version without the Artifact Server interface. |

### Publish options

| Option | Effect |
| --- | --- |
| `--name <name>` | Name for a new artifact. |
| `--public` | Allow the link to open without sign-in. Off by default. |
| `--tag <tag>` | Tag for a new artifact; repeat for more tags. |
| `--project <id>` | Project ID. Optional when exactly one active project exists. |
| `--artifact <id>` | Explicit artifact ID; requires `--expected-version`. Successful publication remembers this target. |
| `--new-artifact` | Deliberately create another artifact and remember it after success. |
| `--expected-version <id>` | Current version ID required when publishing a new version. |
| `--entry <path>` | Directory file that opens first. |
| `--routing <mode>` | `static` or `spa`; reuses a remembered choice, otherwise `static`. |
| `--server <origin>` | Artifact Server origin. Also read from `ARTIFACT_SERVER_URL`. |
| `--profile <name>` | Saved profile to authenticate with. |
| `--profile-data <dir>` | User-local profile directory. Also read from `ARTIFACT_SERVER_HOME`. |
| `--data <dir>` | Local data directory. Defaults to `.artifact-server`. |
| `--token-file <path>` | File containing an Artifact Server API token. |

`--name`, `--public`, and `--tag` configure a new artifact. Repeating them for a remembered artifact is allowed when they match its current metadata; conflicting values are refused. Use artifact management to change existing metadata.

### Choose a routing mode

`--routing static` serves each published path exactly as it was published; a request for a path that was never published is a 404. This is correct for reports, design exports, and ordinary static sites.

`--routing spa` serves the entry document for any path that does not match a published file, so a client-side router owns its own URLs. Choose it only for a single-page application, because it turns every wrong path into a 200.

## Use a remote server

Sign in once, save a named profile, and use it when publishing:

```sh
artifactserver auth login https://artifacts.example.com --name team
artifactserver publish ./dist --profile team
```

`auth login` opens a browser. For a self-hosted server that issues administrator API keys instead, pipe the key in rather than typing it:

```sh
artifactserver auth login https://artifacts.example.com --name team --api-key-stdin
```

`auth status` verifies saved profiles and never prints credentials. It exits `2` when any profile is invalid.

## Publish another version

The CLI automatically remembers each successful publication outside your source folder.
Repeat the same command to publish a new version of that artifact:

```sh
artifactserver publish ./dist --profile team --project prj_example
```

If the canonical manifest is unchanged (including entry path and routing), the CLI
checks the saved version against the server and returns `unchanged: true` without
creating an upload or version. Changed publications return `unchanged: false`.
The existing `artifact`, `version`, `links`, and `replayed` response fields remain.
Automatic entry detection stays automatic; explicitly selected entry and routing
options are remembered.

Records live under `<profile-data>/publications/`, normally
`~/.artifact-server/publications/`, scoped to the validated source path, origin,
installation, principal, and project. They include the full successful receipt and
pending recovery intent, never credentials. Do not put `--profile-data` inside the
folder being published. Moving a folder requires importing its receipt at the new
path; the CLI never guesses identity from an artifact name.

Use `--new-artifact` when you deliberately want another artifact. To explicitly
select an existing artifact, pass both `--artifact art_example` and
`--expected-version ver_example`; a successful publication remembers that target.
These options cannot be combined with `--new-artifact`.

### Inspect and import remembered publications

```sh
artifactserver publications list --profile team
artifactserver publications status ./dist --profile team
artifactserver publications import ./dist --profile team --project prj_example --receipt publish-result.json
```

Import accepts the JSON response of an earlier successful publish. It verifies the
receipt against the server and records the binding without uploading. Malformed,
stale, mismatched receipts and replacements of a different binding are refused.
Import restores routing from the receipt; automatic entry detection remains the
default, so specify `--entry` on the next publish if the original entry was selected
explicitly. `list` without destination options reads all local records offline.

A newer server version is a conflict even if local bytes are unchanged. Inspect it
and explicitly accept it before publishing again:

```sh
artifactserver publications refresh ./dist --profile team --project prj_example
artifactserver publish ./dist --profile team --project prj_example
```

`refresh` updates the expected version only; it does not publish. Pending attempts
must be reconciled with their original command before import or refresh. An
unambiguous server rejection of a commit due to a version conflict settles that
attempt, allowing an explicit refresh. Ambiguous network failures retain it.

### Recover an interrupted publication

The CLI keeps a private pending-operation identity and binds its staged upload
to that operation, so an unchanged retry resumes instead of starting over. Files
the server already verified are not sent again, and an operation the server
already committed returns its original artifact and links without touching
staging. Keep the input, selected entry, target and expected version unchanged
while reconciling that attempt; the same operation identity with changed files
is rejected as a conflict, and an expired staged upload is recreated fresh.

The successful receipt and completion state are saved atomically before the CLI
reports success. A durable delivery marker remains until stdout has accepted the
receipt. If the process exits first, retrying the original command returns that
receipt with `replayed: true`, including when `--new-artifact` was selected.
A concurrent command for the same source and destination is
refused; an unambiguously dead local process lock can be reclaimed. Corrupt or
ambiguous ownership is refused. Matching old `publication-operations` journals are recovered with their original
command. Unrelated journals remain untouched and do not block a verified receipt
import. An imported binding controls subsequent automatic publishes; it does not
replay an old, unbound create attempt.

A conflict on commit means the current pointer moved; inspect the new current
version before choosing a new publication intent. Scoped upload URLs accept
binary bytes at the application origin; they are not provider-native signed
uploads (that remains [T11](../ROADMAP.md#open-tasks)). Do not delete staged server
data manually to recover a client operation.

## Publish named groups

A repository can define ordered publication groups in `artifactserver.publish.json`:

```json
{
  "schemaVersion": 1,
  "defaults": {"profile": "team", "project": "prj_example"},
  "targets": {
    "prototype": {"path": "prototype"},
    "reports": {"path": "reports"}
  },
  "groups": {
    "design": {"targets": ["prototype", "reports"]},
    "prototype": {"targets": ["prototype"]}
  }
}
```

Targets contain only relative source paths. Group and target names use lowercase
letters, digits, and hyphens (up to 64 characters). A group can override `profile`
or `project`; explicit CLI settings override the group, then file defaults. If
omitted, normal authentication and single-project selection apply once to the
whole group. Targets inherit remembered entry/routing choices and cannot select
their own destination. Credentials, artifact/version IDs, hooks, nested groups,
and unknown configuration fields are refused. Globs are not expanded.

Paths resolve relative to the configuration directory and must remain inside it.
Sources cannot include the configuration file or private CLI state, or point
inside that state. Duplicate canonical sources within a group are refused.
Configuration discovery searches the current directory and its parents, stopping
at the checkout root; an explicit `--config` works from anywhere.

```sh
artifactserver publications groups
artifactserver publish --group design --dry-run
artifactserver publish --group design
artifactserver publish --group design --json
artifactserver publish --group design --config /path/to/artifactserver.publish.json
```

Preflight inspects every member and reports `changed`, `unchanged`, `unregistered`,
`conflicted`, `resumable`, or `blocked`. Any blocker stops the whole group before
uploads. A dry run leaves publication records, journals, locks, and run reports
untouched; normal authentication cache/token refresh may still occur. A preview
is an observation, not a reservation: execution rechecks source location, saved
binding, destination identity, and server version guards.

Unregistered members block by default. Import their existing receipts, or use
`--allow-create` to explicitly permit first publications with the ordinary private
artifact defaults. A matching pending operation can resume its previously
selected intent. Incompatible pending inputs or options require reconciliation
through the original single-path command. Group mode refuses `--artifact`,
`--expected-version`, `--new-artifact`, and other per-artifact choice flags.

Members execute sequentially. Individual runtime failures are collected while
independent members continue; `--fail-fast` stops subsequent members. Completed
versions remain committed. Rerunning the group skips unchanged successes and
recovers matching interrupted operations without duplicating versions.

Human output shows each outcome and totals for published, unchanged, recovered,
failed, and skipped members. `--json` emits one final result on stdout, with
progress on stderr. Blocked preflight or any runtime failure returns a nonzero
exit status. Existing single-path publication output stays JSON.

Each executing run writes a private atomic report under
`<profile-data>/publication-runs/<generated-run-id>.json`. A target's successful
receipt is persisted there before its publisher acknowledges delivery. If report
storage fails, the run stops and the publisher retains any undelivered receipt.
Interrupted reports preserve completed outcomes; the per-target publication
journal remains the authority for retries. Dry runs and blocked preflight create
no run report.

## Link a working file

`publish` uploads a snapshot. `link` registers a file that stays on this machine, so the server reads its current bytes when someone captures a new version:

```sh
artifactserver link ./docs/architecture.md --project prj_example --name "Architecture"
```

Linking is a same-machine operation: the path is resolved to an absolute path that the server itself must be able to read, so it works against a local installation, not a remote one. Capture a new version with the `artifact_capture` MCP tool. Capturing an unchanged source returns the current version rather than saving a duplicate. See [MCP and AI agents](./mcp.md) for the linked-artifact tools.

## Connect an AI client

```sh
artifactserver connect            # choose among installed clients
artifactserver connect codex      # or name one: codex, claude, cursor, vscode
artifactserver doctor             # inspect without changing anything
artifactserver disconnect codex
```

`connect` registers a local stdio bridge and manages its private credential. The credential never appears in client configuration or command output. See [MCP and AI agents](./mcp.md).

## Clone Git-backed history

Available only when a project has optional Git history enabled. See [Cloudflare Artifacts](./cloudflare-artifacts.md).

```sh
artifactserver history clone art_example ./history --project prj_example
artifactserver history checkout-project prj_example ./project-history --concurrency 3
```

`history checkout-project` writes a `.artifactserver/project.json` manifest recording each artifact's clone status.

Purging is destructive and permanent. Plan first, and name the installation explicitly to apply:

```sh
artifactserver history purge --plan
artifactserver history purge --apply --confirm-installation inst_example
```

## Operator commands

These run against an installation rather than an artifact. See [Deploy Artifact Server](./deployment.md).

```sh
artifactserver init --admin-email admin@example.com
artifactserver start-compact --host 0.0.0.0 --port 8787
artifactserver config check --mode external-storage
artifactserver migrate status
artifactserver migrate apply
artifactserver integrity check --mode compact
artifactserver support manifest
artifactserver maintenance cleanup-staging --once --limit 100
```

`config check` and `integrity check` exit `2` when the installation is not ready or not healthy. `support manifest` is credential-free and safe to attach to a bug report. `migrate apply` takes an advisory lock, so it is safe to run from one process during a rolling deploy.

## Claude Design exports

Publish complete Claude Design System and Project directories, or portable design systems with `*.card.html` previews and `@dsCard` metadata, to publish a preview index automatically when no root `index.html` exists; the version opens on its first preview and Review shows the index as a gallery. An explicit `--entry` always wins. See [Claude Design exports](./claude-design.md) for supported layouts and boundaries.
