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
| `--artifact <id>` | Artifact ID when publishing a new version. |
| `--expected-version <id>` | Current version ID required when publishing a new version. |
| `--entry <path>` | Directory file that opens first. |
| `--routing <mode>` | `static` (default) or `spa`. |
| `--server <origin>` | Artifact Server origin. Also read from `ARTIFACT_SERVER_URL`. |
| `--profile <name>` | Saved profile to authenticate with. |
| `--profile-data <dir>` | User-local profile directory. Also read from `ARTIFACT_SERVER_HOME`. |
| `--data <dir>` | Local data directory. Defaults to `.artifact-server`. |
| `--token-file <path>` | File containing an Artifact Server API token. |

`--name`, `--public`, and `--tag` apply only when creating a new artifact. Use `artifact_set_tags` and `artifact_set_visibility` to change them afterwards.

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

Provide the artifact ID and expected current version:

```sh
artifactserver publish ./dist \
  --artifact art_example \
  --expected-version ver_example
```

The expected version prevents an old client from replacing a newer current pointer. Read the current value from `artifact_get` before publishing.

### Recover an interrupted publication

The CLI keeps a private pending-operation identity and binds its staged upload
to that operation, so an unchanged retry resumes instead of starting over. Files
the server already verified are not sent again, and an operation the server
already committed returns its original artifact and links without touching
staging. Keep the input, selected entry, target and expected version unchanged
while reconciling that attempt; the same operation identity with changed files
is rejected as a conflict, and an expired staged upload is recreated fresh.

A conflict on commit means the current pointer moved; inspect the new current
version before choosing a new publication intent. Scoped upload URLs accept
binary bytes at the application origin; they are not provider-native signed
uploads (that remains [T11](../NEXT-STEPS.md)). Do not delete staged server
data manually to recover a client operation.

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

Publish complete Claude Design System and Project directories to generate a preview catalog automatically when no root `index.html` exists. An explicit `--entry` always wins. See [Claude Design exports](./claude-design.md) for supported layouts and boundaries.
