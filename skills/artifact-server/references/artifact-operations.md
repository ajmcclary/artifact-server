# Artifact operations

Use the CLI for local files and MCP for server-only work. Both enforce the same Artifact Server permissions. Invoke the installed `artifactserver` program normally. Inside the Artifact Server source checkout, use `pnpm artifactserver` when the installed program is unavailable.

## CLI publication

Inspect the installed command when compatibility is uncertain:

```sh
artifactserver --version
artifactserver publish --help
artifactserver auth status
```

The publish command always returns structured JSON. Do not add a `--json` flag.

### Create an artifact

```sh
artifactserver publish "<path>" --profile "<profile>" --server "<origin>" --project "<project-id>" --name "<name>"
```

Optional creation flags are repeatable `--tag`, `--public`, and `--entry`. Account-required access is the default.

`--entry <path>` names the file that opens first in a directory publication. `--routing` selects path handling: `static` is the default and serves only published paths; `spa` serves the entry document for unmatched paths. Use `spa` only for a single-page application, because it turns every wrong path into a 200.

### Publish a new version

Obtain `artifact.currentVersionId` with `artifact_get`, then run:

```sh
artifactserver publish "<path>" --profile "<profile>" --server "<origin>" --project "<project-id>" --artifact "<artifact-id>" --expected-version "<current-version-id>"
```

The CLI owns local file inspection, symlink policy, media types, SHA-256 hashing, upload planning, transfer retries, and commit verification. Do not reproduce those steps in a skill script.

## MCP reads

- `artifact_capabilities`: inspect limits, sharing modes, project rules, linked-file availability, and deployment mode.
- `project_list`: resolve a project when more than one exists.
- `artifact_list`: list artifacts; use `projectId`, exact `tag`, cursor, and bounded limit when relevant.
- `artifact_get`: obtain current metadata, manifest, current version ID, tags, access, `current.links.review` for exact full-screen Review, and `links.artifact` for moving latest in one call.
- `artifact_open`: obtain `reviewUrl` for exact full-screen Review and `browserUrl` for raw immutable content for the current or an exact saved version. Prefer `reviewUrl` for human handoff. Never describe `browserUrl` as Review.
- `artifact_version_list`: list immutable versions newest first.
- `artifact_diff`: compare two exact version IDs.

Prefer `artifact_get` over several discovery calls when the artifact ID is already known.

## MCP writes

Call `artifact_get` immediately before a write to obtain the current version ID. Generate a new opaque idempotency key for the action and reuse it only for an exact retry.

- `artifact_set_visibility`: set `account_required` or `public_link` without changing file bytes.
- `artifact_set_tags`: replace the complete tag set. Preserve existing tags the user did not ask to remove.
- `artifact_restore_version`: make an existing saved version current. This restores an artifact version; it does not restore a server backup. When the user identifies the target relatively, such as "the older of the latest two," run `artifact_version_list` again immediately before the restore and confirm that the chosen version still has that relationship to the current version. An optimistic current-version guard alone does not preserve a relative description.
- `artifact_delete`: use only for an explicit request to delete one artifact. Repeat the artifact name, server, and project before the destructive call. This does not delete the installation.

Project creation, rename, archive, or unarchive are ordinary product actions but must be explicit. Use `project_create`, `project_rename`, `project_archive`, or `project_unarchive`. Archiving a project preserves readable history and stops new publication until it is unarchived.

## Comments

Review comments are threads with replies. Read before writing, and never invent a thread ID.

- `comment_list`: list threads on an artifact. Threads held by a queued, claimed, or delivered agent dispatch are hidden from default listings but stay readable by ID.
- `comment_get`: read one exact thread with its replies.
- `comment_create`: open a new thread. `comment_reply`: add a reply to an existing thread.
- `comment_update`: edit a comment the user owns. Do not edit another person's comment on their behalf without an explicit request.
- `comment_resolve`: mark a thread resolved. Resolving every thread in a dispatched bundle is what closes an agent feedback loop; there is no separate completion report.
- `comment_delete`: delete one thread or reply.
- `comment_clear`: delete every matching thread on one artifact in bulk — `resolved`, or `all`. This is destructive and not a resolve. Name the artifact and the scope, and confirm before calling it. Threads held by queued, claimed, or delivered dispatches are skipped and counted rather than deleted; report that count instead of retrying.

When replying on behalf of an agent that received a dispatched bundle, reply to each thread with what changed, then resolve it. Do not wait for confirmation between threads.

## Linked files

A linked artifact tracks a file that stays on the server's own machine rather than storing an uploaded snapshot. It works only on a local installation with linked files enabled, so call `artifact_capabilities` first and read `linkedArtifacts.available`.

- `artifactserver link "<path>" --project "<project-id>" --name "<name>"` registers the file from the CLI.
- `artifact_link` does the same through MCP. Pass the absolute path only. MCP never carries file bytes; the server reads the file itself.
- `artifact_capture` saves the source file's current bytes as a new immutable version. Pass the current version ID as `expectedCurrentVersionId`. Capturing an unchanged source returns the current version rather than saving a duplicate, which is success, not a failure.
- `artifact_relink` re-points an artifact at the same file in a new location. It is accepted only when the file at the new path hashes to `expectedSha256`, normally the current version's entry file SHA-256. Versions, comments, and the artifact ID are untouched.

Never use a linked-file tool against a remote installation, and never substitute an upload when the user asked to link a file. They are different products: one tracks the file, the other freezes a copy.

## Git history

Optional Git-backed history is off by default and enabled one project at a time.

- `project_git_history_status` and `project_git_history_estimate`: read state and a fresh copy estimate.
- `project_set_git_history`: enable or disable it. Enabling requires a confirmed current estimate; provider configuration alone copies nothing. Report the returned state and never describe `waiting`, `degraded`, or `budget-limited` history as ready.
- `artifact_history_clone_token`: issue a short-lived read credential for one artifact's derived repository. Use it directly for the clone. Never print it, quote it back to the user, or write it to a file.

`artifactserver history clone` and `history checkout-project` clone from the CLI. `history purge` permanently deletes derived repositories; route it to server operations rather than running it as routine artifact work.

## MCP file upload

Do not use MCP upload tools when the files exist on the user's machine and the CLI is available. The CLI provides the one-step authenticated experience.

Use `artifact_create_upload` and `artifact_commit_upload` only when the current agent environment can actually read the file bytes and execute the returned authenticated HTTP uploads. Call `artifact_capabilities` first. Never place file bytes, base64, or a local path in MCP arguments, and never expose the MCP bearer credential to the model or output.

## Final result

For publication, collect these fields from the structured result:

- server origin;
- project ID;
- artifact ID;
- exact version ID;
- full-screen review link, stable artifact link, and exact-version raw link;
- access setting.

Present the full-screen review link first because it is the primary human link
for viewing and commenting on the exact published version. Present the raw
immutable link second when direct artifact content is useful.

For comparisons, summarize added, removed, renamed, and changed files and link the compared versions. For a mutation, report the new current version ID or confirm that the current immutable version did not change, as appropriate.
