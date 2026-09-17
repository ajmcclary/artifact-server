# Server operations

Use this route only when the user explicitly asks to operate an Artifact Server
installation. Routine publishing, sharing, reviewing, and artifact-version
restore do not require administrator instructions.

## Select the installation and deployment target

Identify the exact installation before changing it. Determine whether it runs
as a local package, Docker Compose, Kubernetes, Cloudflare, AWS, or Google
Cloud. Inspect the matching repository guide instead of translating commands
from another target:

- local package: `docs/deployment.md`
- Docker Compose: `packaging/compose/README.md`
- Kubernetes: `packaging/helm/artifact-server/README.md`
- Cloudflare: `deploy/cloudflare/README.md`
- AWS: `deploy/pulumi/aws/README.md`
- Google Cloud: `deploy/pulumi/gcp/README.md`

Use the target's native tool. Artifact Server does not provide one generic
`artifactserver deploy` command.

## Inspect with the installation commands

These read or change an installation rather than an artifact. Prefer them over
ad-hoc database or storage inspection, and prefer the read-only ones first:

| Intent | Command |
| --- | --- |
| Parse and check one exact configuration | `artifactserver config check --mode <compact\|external-storage>` |
| Product, schema, provider, and configuration versions | `artifactserver support manifest` |
| Verify committed records and bytes | `artifactserver integrity check --mode <mode>` |
| Report Postgres schema compatibility | `artifactserver migrate status` |
| Apply migrations under the advisory lock | `artifactserver migrate apply` |
| Initialize an empty compact data directory | `artifactserver init --admin-email <email>` |
| Start a compact server | `artifactserver start-compact` |
| Start a stateless external-storage process | `artifactserver start-external-storage` |
| Remove expired uncommitted uploads | `artifactserver maintenance cleanup-staging --once` |
| Permanently delete derived Git repositories | `artifactserver history purge --plan` then `--apply` |

`config check` and `integrity check` exit `2` when the installation is not ready
or not healthy, so read the exit code rather than assuming success. `support
manifest` is credential-free and is the right thing to share in a bug report.

`history purge --apply` requires `--confirm-installation <id>` and permanently
deletes derived repositories. Always run `--plan` first, show the plan, and get
explicit confirmation. Disable Git history on every project before applying.

## Plan before changing infrastructure

1. Inspect the current release, deployment configuration, storage drivers,
   identity mode, and health without printing credentials.
2. State the proposed change, affected installation, expected interruption,
   rollback path, and any backup or restore consequence.
3. Confirm that the request authorizes that exact material change. Ask before a
   different installation, destructive restore, data deletion, public network
   exposure, or materially expanded scope.
4. Apply the smallest target-native change.
5. Verify both `/health` and `/ready`, then verify one authenticated product
   operation appropriate to the deployment.

## Protect data and credentials

- Never paste infrastructure, database, object-storage, OIDC, or Artifact
  Server credentials into chat or command output.
- Resolve exact backup objects and destinations before a restore. A server
  backup restore is destructive and is different from making an immutable
  artifact version current.
- Preserve the configured metadata and blob-store pairing. Do not point an
  existing metadata store at an unrelated blob namespace.
- Back up before an upgrade or migration when the deployment guide requires it.
- Stop when the installed release, migration direction, storage ownership, or
  rollback path is uncertain.

## Report the result

Name the installation, deployment target, previous and resulting release,
storage mode, checks that passed, and any remaining operator action. If the
operation did not complete, state the exact failed check and leave the existing
installation state clear.
