# Phase 10: CLI authentication and remote publishing

Status: implementation present locally; complete combined CLI proof and hosted activation remain gated

## Outcome

One installed `artifactserver` program can publish a local file or finished
directory to the local server or an exact remote Artifact Server without a
credential in the command, project, shell history, or output.

The user-facing commands are:

```text
artifactserver auth login https://team.example.com
artifactserver auth status
artifactserver auth logout
artifactserver publish ./dist --profile team --project prj_example
```

`publish` keeps its existing explicit `--server`, environment-token, and
token-file paths for CI and recovery. A saved profile is the normal interactive
remote path. Local publication continues to read the private local credential
from the selected local data directory without creating a remote profile.

## Profile model

The non-secret profile index is user-local state. Each profile records:

- a stable ID and human name;
- the exact normalized HTTP or HTTPS server origin;
- the authenticated Artifact Server principal and installation IDs;
- whether the credential is an OAuth grant or an Artifact Server API key;
- when the profile was created and last verified.

The origin has no path, query, fragment, embedded credentials, or implicit
cross-origin fallback. Profile names are unique. An origin and principal pair
identifies one profile. Project configuration may contain a profile name or
origin, but never a credential.

Remote secrets are stored under an opaque profile credential ID in the
operating-system credential store:

- macOS Keychain through `security`;
- Linux Secret Service through `secret-tool`;
- Windows Credential Manager through the native credential APIs invoked by
  PowerShell;
- an explicit credential-helper process for enterprise integration and tests.

Secrets go to helpers on standard input, not in process arguments. The profile
index contains no access token, refresh token, API key, authorization code,
client secret, or PKCE verifier. Artifact Server does not silently fall back to
plain-text remote credential storage when the operating-system store is
unavailable.

## Login modes

### Browser-authorized remote server

The CLI treats the remote HTTP API as its own OAuth protected resource. It
discovers the server's RFC 9728 metadata for the exact `<origin>/api` resource,
discovers the advertised authorization server, and performs an authorization
code flow with S256 PKCE in the system browser. The callback listener binds
only to a loopback IP and closes after one valid response.

The authorization server may identify the public CLI through a Client ID
Metadata Document or use Dynamic Client Registration during the compatibility
period. The CLI stores the returned access token, refresh token, client
registration, and discovery binding together in the operating-system
credential store. A refresh is attempted before a remote operation when the
access token is no longer accepted. Refresh never opens a browser; an invalid
grant tells the user to run `auth login` again.

The API resource and MCP resource are separate audiences. A CLI token issued
for `<origin>/api` is never accepted merely because a token for
`<origin>/mcp` would be valid, and the CLI never copies an MCP client's grant.

### Self-hosted remote server without browser authorization

`artifactserver auth login <origin> --api-key-stdin` reads one
administrator-issued scoped key from standard input, verifies it through the
server's session inspection endpoint, and stores it in the same secure profile
boundary. The command requires piped standard input and never accepts a key as
a command argument.

### Local and unattended use

Loopback publication with `--data` uses the existing private local credential
file. It does not create a profile or open a browser. CI supplies a scoped
service credential through `ARTIFACT_SERVER_API_TOKEN` or `--token-file`; the
CLI does not copy that credential into an interactive profile.

## Status and logout

`auth status` lists only profile name, origin, principal ID, installation ID,
credential kind, and verification state. It verifies the selected credential
against `GET /api/v1/session`, refreshing an OAuth grant when possible. It
never prints or decodes credential claims as proof of server acceptance.

`auth logout` removes both the operating-system credential and non-secret
profile record. OAuth grant revocation is attempted when the authorization
server advertises a revocation endpoint. Local deletion still completes when a
remote revoke endpoint is unavailable; the command reports that remote
revocation could not be confirmed.

## Publication path

Credential resolution order is explicit and fail-closed:

1. `ARTIFACT_SERVER_API_TOKEN` or `--token-file` with an explicit server;
2. `--profile <name>`;
3. an exact `--server <origin>` with exactly one saved matching profile;
4. the private local credential when a loopback server was selected;
5. the saved default profile when no server or profile was selected, otherwise
   the default local loopback server when no remote profile exists.

An ambiguous or missing selection is an error. The resolved bearer is passed
to the existing file publication client as a redacted value. File preparation,
upload-plan validation, concurrent streaming, idempotent commit, and result
decoding remain in that client. Output contains the project, artifact, exact
version, and canonical browser links; it does not contain upload URLs, local
paths, credentials, or retry state.

Before the first upload request, the CLI writes a private pending-operation
record under the user-local profile directory. The record binds one random
idempotency key to the exact server origin, command scope, and prepared file
manifest. It contains no credential, local path, or file byte. The CLI keeps
the record when a request or response is lost and removes it only after it has
printed the committed result.

Running the same command after a process or network failure reuses the pending
key. The server can therefore return the original commit result without
creating another artifact or version, even when the CLI must create a new
staging upload. If the source bytes or effective publication target changed
while that operation is pending, the CLI fails closed and tells the user to
restore the original input. It does not silently start a second publication.

## Implementation boundaries

- `cli-profile-store` owns only non-secret profile metadata and atomic files.
- `system-credential-store` owns operating-system secret persistence.
- `cli-oauth-client` owns discovery, PKCE, callback, refresh, and revoke.
- `cli-auth-commands` composes login, status, and logout.
- `publish-command` resolves a credential, then calls the existing
  `file-publication-client`.
- HTTP, MCP, and CLI continue to reach the same application services and
  provider-neutral principal.

## Verification

The phase is complete only when these observable paths pass:

- real CLI processes log in with a scoped API key through standard input,
  report status without the key, publish a real file and directory to a real
  remote server, survive a server restart, and log out;
- two exact origins cannot use each other's profile credential;
- a real loopback OAuth test server proves discovery, browser redirect, state,
  S256 PKCE, code exchange, refresh, issuer binding, and logout revocation;
- malformed metadata, hostile callbacks, wrong state, wrong issuer, expired or
  revoked credentials, missing credential stores, and ambiguous profiles fail
  without leaking secrets;
- local publication and explicit CI credentials remain compatible;
- the compiled direct-local package includes and runs the same commands;
- lint, type checking, the complete test suite, bounded smoke and performance
  checks, and the conformance ledger pass.

Provider-specific hosted WorkOS activation remains gated on the separate
WorkOS staging and named-client matrix. Passing this phase proves the portable
CLI contract; it does not claim that an unconfigured deployment advertises
browser OAuth.

The current `CLI-001` acceptance-ID test proves the remote PKCE, refresh,
status, and revoke path. It does not attach the local automatic-authentication
and CI credential paths, or every named credential-leak surface, to the same
behavior and failure IDs. The ledger therefore remains `implementing`.

## Standards basis

- [OAuth 2.0 for Native Apps (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252)
  defines system-browser authorization, loopback callbacks, and PKCE for an
  installed CLI.
- [OAuth 2.0 Protected Resource Metadata (RFC 9728)](https://www.rfc-editor.org/rfc/rfc9728)
  defines how the CLI discovers the authorization server for the exact API
  resource.
- [WorkOS AuthKit CLI authorization](https://workos.com/docs/authkit/cli-auth)
  documents the hosted authorization-code and PKCE path that must pass staging
  before it is enabled for a hosted Artifact Server.


## Remembered publications

CLI-004 makes publication receipts durable client state under the user-local
profile directory. Each validated source, origin, installation, principal, and
project has a private record. A successful publish binds that source to the
returned artifact and version; another ordinary publish creates the next version.
An unchanged canonical manifest returns the current receipt with `unchanged: true`
after checking the expected server version, without starting an upload. Entry,
routing, content digests, paths, sizes, and media types participate in comparison.
Explicit entry choices persist while automatic generated catalogs remain automatic.

`--new-artifact` deliberately creates and remembers another artifact. Explicit
`--artifact` and `--expected-version` remain authoritative. Creation metadata may
be repeated only when it agrees with the existing artifact. Credentials resolve
normally and are not part of receipts; changed installation or principal identity
must not silently replace a remembered artifact.

`publications list` inventories saved targets; `status <path>` checks their remote
version; `import <path> --receipt <file>` validates and binds an existing receipt;
`refresh <path>` explicitly accepts the current version of an existing binding.
These management operations never upload. Imports refuse stale or mismatched
receipts and different existing bindings. A moved source can import its receipt.

Pending intent and idempotency identity are durable before network mutation. The
receipt and settled state replace the pending record atomically before stdout.
A durable undelivered-receipt marker is acknowledged only after stdout accepts the
result; a lost process replays that receipt before another intent, including
explicit new-artifact requests.
An uncertain result remains pending and must reconcile the same command; changed
input or target is refused. A definitive commit-time PUBLISH_CONFLICT is settled
without adopting a newer version, permitting explicit refresh. An exclusive
process-owned lock protects each scope; only a demonstrably dead local owner is
reclaimed. Corrupt records or ambiguous locks fail closed. Matching legacy pending journals are reconciled with their original command.
Unrelated journals are preserved and do not block verified receipt imports. An
imported binding takes precedence over old unbound create attempts. State must remain outside uploaded
source trees, and no conformance status for a server deployment is implied by
local CLI verification.


## Publication groups

CLI-005 adds ordered repository-defined groups over the remembered publisher.
`artifactserver.publish.json` has versioned shared defaults, path-only named
targets, and groups containing target names with optional profile/project
overrides. CLI destination selections take precedence. Relative sources are
confined to the configuration directory, and duplicate canonical sources,
configuration inclusion, and private CLI state inclusion are refused.

`publish --group <name>` is mutually exclusive with a positional path and
per-artifact mutation flags. `--config` explicitly selects a file; discovery stops
at the checkout boundary. `publications groups` lists definitions offline.
Preflight resolves one shared destination and checks all sources, remembered
bindings, identities, manifests, version guards, and recoverable pending intent.
Any blocker prevents all uploads. Unregistered sources require `--allow-create`;
matching pending operations preserve existing recovery semantics. `--dry-run`
creates no publication records, journals, locks, or run reports; normal auth
refresh/cache behavior is allowed.

Execution is sequential and rechecks state under the existing publisher lock.
Independent member failures continue by default; `--fail-fast` leaves remaining
members skipped. Partial success is retained. Structured JSON and human summaries
report published, unchanged, recovered, failed, and skipped outcomes, with nonzero
exit status for blockers or failures. Private generated-ID run reports are atomic
and durable before per-target receipt delivery is acknowledged. Report storage
failure stops further members and preserves undelivered receipts. No second
upload recovery protocol or server API is introduced.
