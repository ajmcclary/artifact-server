# Deploy Artifact Server

Artifact Server supports local, single-server, Kubernetes, and managed-cloud deployments.

## Choose a deployment

| Deployment | Data layer | Detailed guide |
| --- | --- | --- |
| Cloudflare | D1 and R2 | [Cloudflare](../deploy/cloudflare/README.md) |
| Compact Compose | SQLite and one file volume | [Compose](../packaging/compose/README.md) |
| External-storage Compose | PostgreSQL and S3-compatible storage | [Compose](../packaging/compose/README.md) |
| Kubernetes | PostgreSQL and object storage | [Helm](../packaging/helm/artifact-server/README.md) |
| AWS | ECS, RDS, and S3 | [AWS Pulumi](../deploy/pulumi/aws/README.md) |
| Google Cloud | Cloud Run, Cloud SQL, and Cloud Storage | [Google Cloud Pulumi](../deploy/pulumi/gcp/README.md) |

## Configure the shared boundaries

Each remote deployment needs these boundaries:

1. Configure one HTTPS application origin.
2. Configure a separate wildcard content domain.
3. Configure WorkOS or one generic OIDC provider.
4. Admit team members through Artifact Server.
5. Store service credentials outside source control.
6. Back up the database and artifact files.
7. Pin release deployments to an immutable image digest.

The application origin serves Artifact Server, its API, and its MCP endpoint. The content domain serves untrusted artifact files.

## Select storage

Compact Compose uses one SQLite database and one file volume. Run only one application process with this data layer.

External-storage deployments use PostgreSQL and object storage. These deployments support replaceable application processes and horizontal scaling.

## Configure authentication

Local-owner access works only on an exact loopback origin. Do not use it for remote access.

Remote deployments use WorkOS or a generic OIDC provider. Network access and application authorization remain separate controls.

### Admit colleagues by verified email domain

Optional `ARTIFACT_SERVER_AUTO_ADMIT_EMAIL_DOMAINS` accepts a comma-separated
list of exact domains on Node, Compose, and Helm deployments. Cloudflare, AWS,
and GCP accept `autoAdmitEmailDomains` as a list in their deployment settings.
Sign in as the configured bootstrap administrator first. Subsequent people on
an allowed domain are admitted as members only when the identity provider
explicitly asserts email verification. An absent OIDC `email_verified` claim
does not qualify for automatic admission, though established login behavior
for pre-admitted people remains unchanged. Leave the setting absent for closed
admission; removing a domain does not deactivate existing members.

### Use a generic OIDC issuer for MCP

The issuer configured for browser login also protects `/mcp`. Agents present an
end-user access token, and the server records the person who obtained it. The
server never issues client credentials and never runs an authorization server of
its own.

The issuer must provide four things:

- an OpenID Connect discovery document at `<issuer>/.well-known/openid-configuration`;
- access tokens signed as JWTs with RS256 or ES256, verifiable against the
  published JWKS;
- the authorization code flow with S256 PKCE;
- an access token whose `aud` contains the exact `<ARTIFACT_SERVER_ORIGIN>/mcp`.

The audience is the one step an operator must configure. Providers do not bind a
resource URL on their own. In Keycloak, add a client scope with an audience
mapper whose included custom audience is that exact URL, and assign the scope to
the client the agents use. Entra exposes an API and uses its application ID URI.
Okta sets the audience on a custom authorization server. A provider that
supports RFC 8707 resource indicators can bind it per request instead.

Register the client the agents use in one of two supported ways:

- the issuer offers RFC 7591 dynamic client registration, its discovery document
  advertises `registration_endpoint`, and each client registers itself;
- an administrator registers one client in the issuer and gives its client ID to
  the agents that need it.

Artifact Server publishes RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp` naming the issuer, and answers an
unauthenticated MCP request with `401` and a `resource_metadata` challenge, so a
compliant client finds the issuer without further configuration.

Clients that cannot complete OAuth keep using administration-issued API keys.
Tokens that name another resource, and ID tokens, are refused.

### Enable linked files on a local installation

Optional `ARTIFACT_SERVER_LINKED_FILES=on` lets the server register a file that
stays on its own machine and read that file's current bytes on demand. It is
`off` by default, and it can only be enabled on the local deployment runtime:
an external-storage deployment that sets it refuses to start, because the
server process and the file must share a filesystem.

`ARTIFACT_SERVER_LINK_ROOTS` bounds which directories can be linked. It takes a
colon-separated list of absolute paths and defaults to the server user's home
directory. A path outside every configured root is refused.

Reach a linked-files installation on its loopback address. See
[`artifactserver link`](./cli.md#link-a-working-file) and the linked-file MCP
tools in [MCP and AI agents](./mcp.md#work-with-linked-files).

## Operate the installation

These commands run against a deployment rather than an artifact:

```sh
artifactserver init --admin-email admin@example.com
artifactserver config check --mode external-storage
artifactserver migrate status
artifactserver migrate apply
artifactserver integrity check --mode compact
artifactserver support manifest
artifactserver maintenance cleanup-staging --once
```

`config check` and `integrity check` exit `2` when the installation is not
ready or not healthy, so they work as deployment gates. `support manifest` is
credential-free and safe to attach to a bug report. `migrate apply` takes an
advisory lock, so a rolling deploy can run it from one process. The full
reference is in the [CLI guide](./cli.md#operator-commands).

## Back up the installation

Back up metadata and artifact files as one coordinated recovery set. Use the procedure in the selected deployment guide.

Do a restore test before the first production release. Then repeat the test after a storage or deployment change.
