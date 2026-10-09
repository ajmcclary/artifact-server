# Private-Team Deployment Proof (AUTH-025, AUTH-027) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove AUTH-025 and AUTH-027 on the packaged `single_server` (compact Compose, external-storage Compose) and `kubernetes` (two-replica Helm) runtimes against a real Keycloak behind TLS, and attach that evidence to the ledger.

**Architecture:** One deployment-agnostic Vitest suite, `tests/release/private-team-access.test.ts`, owns the four acceptance IDs. Each packaged harness includes it and selects a runtime driver through `ARTIFACT_SERVER_PRIVATE_TEAM_TARGET`; the driver starts, reconfigures, and addresses its packaged runtime. A shared wrapper script runs the pinned Keycloak image over HTTPS with a per-run test CA under one hostname that the test runner and the containers both resolve, so the issuer string is identical on both sides. The packaged runtimes trust that CA through a new Compose overlay and a new Helm value — both real operator features for private-CA identity providers.

**Tech Stack:** TypeScript, Vitest, undici 7.29.0 dispatchers, Docker Compose, kind + Helm, pinned Keycloak (`quay.io/keycloak/keycloak@sha256:09a381c7…`), openssl, Node `NODE_EXTRA_CA_CERTS`.

**Spec:** `project/spec/local-owner-and-private-team-access-spec.md` (sections *Private-team mode*, *Verification matrix → Private-team acceptance*, *Conformance requirements*); ledger rows `AUTH-025` and `AUTH-027` in `project/spec/conformance.yml` (read their `proof_gap`).

## Global Constraints

- Each conformance test ID (`AUTH-025-B`, `AUTH-025-F`, `AUTH-027-B`, `AUTH-027-F`) appears in exactly one `*.test.ts` title (`scripts/check-conformance-test-ids.rb`). The IDs move off `tests/conformance/installation-identity.test.ts`.
- No module mocks. Real packaged images, real Keycloak, real TLS, real HTTP.
- Private-team requires: exactly one of OIDC/WorkOS, `ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL`, an HTTPS `ARTIFACT_SERVER_ORIGIN`, a separate registrable `ARTIFACT_SERVER_CONTENT_DOMAIN`.
- A non-loopback OIDC issuer must be HTTPS (`src/identity/oidc-issuer.ts`); plain http is allowed only for `localhost`, `127.0.0.1`, `::1`.
- Authentication cache bound is 30 seconds (AUTH-022); cross-replica refusal must happen within it, same-process refusal immediately.
- Generic OIDC evidence never stands in for WorkOS token or MCP OAuth evidence.
- Keep provider credentials and generated keys out of the repository; generate the CA and leaf per run in a temporary directory with mode 0700.
- Preserve failed evidence; never mark a requirement verified without a passing report for every listed deployment.
- `pnpm verify:iteration` must pass before handoff (Node 24.15 via mise, `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`).

## Review Focus

- **Cookie prefix on an HTTPS origin.** Packaged runtimes use `https://artifacts.example.com`, so session cookies may be `__Host-artifact_session` / `__Host-artifact_csrf`. `sessionCookies` in Task 3 Step 1 accepts both names, and every packaged login in Task 4 Step 1 goes through it.
- **Discovery failure silently disables MCP OAuth.** `oidcAuthenticationOrBrowserOnly` logs `discovery_failed` and keeps serving browser-only. If TLS trust is broken, AUTH-025 MCP checks would fail confusingly. Task 4 Step 1 asserts the startup log has no `discovery_failed` line.
- **Cross-replica proof addressed to one replica.** A Service port-forward may land on either process. Drivers expose one endpoint per replica; Task 5 Step 3 asserts two distinct containers and Task 6 Step 1 two Ready pods on different nodes, each with its own forward.
- **Deactivation must not erase records.** AUTH-027-F requires the deactivated member's artifact, version, comment, and activity entries to remain readable by an administrator. `expectWorkPreserved` in Task 5 Step 1 asserts each one.
- **Hostile Host on the packaged boundary.** A request to a replica with `Host: evil.example` must not be served as the management host. AUTH-025-F in Task 4 Step 1 pins it.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `scripts/with-private-team-identity.sh` (create) | Generate per-run CA + leaf, start pinned Keycloak over HTTPS on a shared Docker network with a fixed alias, export identity env, run the wrapped command, clean up. |
| `tests/support/keycloak-realm.ts` (create) | Keycloak admin provisioning, user creation, password grant, and login-form sign-in, parameterized by a `fetch`. Moved from `tests/integration/oidc-keycloak.test.ts`. |
| `tests/support/private-team/identity-environment.ts` (create) | Parse the env exported by the wrapper; build the undici dispatcher that trusts the test CA and resolves the identity host to loopback. |
| `tests/support/private-team/application-client.ts` (create) | Address one packaged replica as if it were `https://artifacts.example.com`; provider sign-in; cookie and CSRF helpers that accept `__Host-` names. |
| `tests/support/private-team/runtime.ts` (create) | `PrivateTeamRuntime` driver interface and driver selection by `ARTIFACT_SERVER_PRIVATE_TEAM_TARGET`. |
| `tests/support/private-team/compact-compose-runtime.ts` (create) | Compact Compose driver. |
| `tests/support/private-team/external-compose-runtime.ts` (create) | Two-replica external-storage Compose driver. |
| `tests/support/private-team/helm-runtime.ts` (create) | Two-replica Helm driver on kind. |
| `tests/release/private-team-access.test.ts` (create) | Owns `AUTH-025-B`, `AUTH-025-F`, `AUTH-027-B`, `AUTH-027-F`. |
| `packaging/compose/compose.identity-ca.yaml` (create) | Operator overlay: mount a CA bundle read-only and set `NODE_EXTRA_CA_CERTS`. |
| `packaging/helm/artifact-server/values.yaml`, `values.schema.json`, `templates/deployment.yaml`, `README.md` (modify) | `identity.trustedCertificateAuthorities` value. |
| `scripts/verify-helm-chart.sh` (modify) | Static render checks for the new value. |
| `tests/integration/oidc-keycloak.test.ts` (modify) | Import moved helpers. |
| `tests/conformance/installation-identity.test.ts` (modify) | Drop the four IDs from titles; keep the tests as supporting proof. |
| `tests/configs/vitest.compose.config.ts`, `vitest.external-storage-compose.config.ts`, `vitest.helm.config.ts` (modify) | Include the shared suite. |
| `scripts/run-compact-compose-integration.sh`, `run-external-storage-compose-integration.sh`, `run-helm-integration.sh` (modify) | Wrap with the identity script; set the target. |
| `project/spec/conformance.yml`, `packaging/compose/README.md` (modify) | Evidence, status, operator docs. |

---

### Task 1: TLS Keycloak wrapper and shared realm helpers

**Files:**
- Create: `scripts/with-private-team-identity.sh`
- Create: `tests/support/keycloak-realm.ts`
- Create: `tests/support/private-team/identity-environment.ts`
- Modify: `tests/integration/oidc-keycloak.test.ts` (delete moved helpers at lines 306–335, 371–607 and their interfaces/constants at 20–34, 69–131; import instead)

**Interfaces:**
- Produces (env exported by the wrapper):
  `ARTIFACT_SERVER_TEST_IDENTITY_HOST=identity.artifact-server.test`,
  `ARTIFACT_SERVER_TEST_IDENTITY_PORT=<P>`,
  `ARTIFACT_SERVER_TEST_IDENTITY_URL=https://identity.artifact-server.test:<P>`,
  `ARTIFACT_SERVER_TEST_IDENTITY_CA_FILE=<tmp>/ca.pem`,
  `ARTIFACT_SERVER_TEST_IDENTITY_NETWORK=<docker network>`,
  `ARTIFACT_SERVER_TEST_IDENTITY_CONTAINER=<name>`,
  `ARTIFACT_SERVER_TEST_IDENTITY_CONTAINER_IP=<ip on network>`,
  `ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_USER`, `ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_PASSWORD`.
- Produces (`tests/support/keycloak-realm.ts`):
  ```ts
  export interface KeycloakEnvironment { readonly adminPassword: string; readonly adminUser: string; readonly baseUrl: string; readonly fetch: typeof fetch }
  export interface KeycloakPerson { readonly email: string; readonly firstName: string; readonly lastName: string; readonly password: string; readonly username: string }
  export interface ProvisionedRealm { readonly issuer: string; readonly subjects: ReadonlyMap<string, string> /* email → subject */ }
  export const keycloakRealm: { readonly name: "artifact-server"; readonly oidcClientId: string; readonly oidcClientSecret: string; readonly mcpClientId: string; readonly mcpClientSecret: string; readonly unboundClientId: string; readonly unboundClientSecret: string; readonly scopes: "openid email profile" };
  export function provisionKeycloakRealm(environment: KeycloakEnvironment, applicationOrigin: string, people: readonly KeycloakPerson[]): Promise<ProvisionedRealm>;
  export function createKeycloakUser(environment: KeycloakEnvironment, person: KeycloakPerson): Promise<string>;
  export function requestPasswordToken(environment: KeycloakEnvironment, issuer: string, clientId: string, clientSecret: string, credentials: {readonly username: string; readonly password: string}): Promise<string>;
  export function signInAtKeycloak(environment: KeycloakEnvironment, authorizationUrl: URL, credentials: {readonly username: string; readonly password: string}): Promise<URL>;
  ```
- Produces (`identity-environment.ts`):
  ```ts
  export interface PrivateTeamIdentity { readonly keycloak: KeycloakEnvironment; readonly host: string; readonly port: number; readonly caFile: string; readonly caPem: string; readonly network: string; readonly containerIp: string }
  export function readPrivateTeamIdentity(): Promise<PrivateTeamIdentity>;
  ```

- [ ] **Step 1: Write the wrapper script**

```bash
#!/usr/bin/env bash
# Run a command beside a pinned Keycloak served over HTTPS with a per-run CA.
# The issuer hostname resolves to the container on the shared Docker network
# and to loopback for the test runner, so both sides see one issuer string.
set -euo pipefail

readonly keycloak_image="quay.io/keycloak/keycloak@sha256:09a381c715ab0b111835b70f2905955274843a219c6f27efb348e4d9f4086858"
readonly identity_host="identity.artifact-server.test"
readonly run_id="${$}-${RANDOM}"
readonly container_name="artifact-server-identity-${run_id}"
readonly network="${ARTIFACT_SERVER_TEST_IDENTITY_NETWORK:-artifact-server-identity-${run_id}}"
readonly admin_user="artifactserver"
readonly admin_password="artifactserver-keycloak-integration-only"
work_directory=$(mktemp -d "${TMPDIR:-/tmp}/artifact-server-identity.XXXXXX")
readonly work_directory
chmod 0700 "${work_directory}"
created_network=false

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
  if [[ "${created_network}" == true ]]; then
    docker network rm "${network}" >/dev/null 2>&1 || true
  fi
  rm -rf "${work_directory}"
}
trap cleanup EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=Artifact Server test identity CA ${run_id}" \
  -keyout "${work_directory}/ca.key" -out "${work_directory}/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -subj "/CN=${identity_host}" \
  -keyout "${work_directory}/tls.key" -out "${work_directory}/tls.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "${identity_host}" \
  > "${work_directory}/leaf.ext"
openssl x509 -req -days 1 -in "${work_directory}/tls.csr" \
  -CA "${work_directory}/ca.pem" -CAkey "${work_directory}/ca.key" -CAcreateserial \
  -extfile "${work_directory}/leaf.ext" -out "${work_directory}/tls.pem" >/dev/null 2>&1
# Keycloak runs as UID 1000 and must read the key; the directory stays 0700.
chmod 0644 "${work_directory}/ca.pem" "${work_directory}/tls.pem" "${work_directory}/tls.key"

if ! docker network inspect "${network}" >/dev/null 2>&1; then
  docker network create "${network}" >/dev/null
  created_network=true
fi

port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
docker run --detach \
  --name "${container_name}" \
  --network "${network}" \
  --network-alias "${identity_host}" \
  --env "KC_BOOTSTRAP_ADMIN_USERNAME=${admin_user}" \
  --env "KC_BOOTSTRAP_ADMIN_PASSWORD=${admin_password}" \
  --volume "${work_directory}:/opt/identity-tls:ro" \
  --publish "127.0.0.1:${port}:${port}" \
  "${keycloak_image}" \
  start-dev \
  --http-enabled=false \
  --https-port="${port}" \
  --https-certificate-file=/opt/identity-tls/tls.pem \
  --https-certificate-key-file=/opt/identity-tls/tls.key \
  --hostname="https://${identity_host}:${port}" >/dev/null

identity_url="https://${identity_host}:${port}"
ready=false
for _ in $(seq 1 240); do
  if curl --fail --silent --cacert "${work_directory}/ca.pem" \
    --resolve "${identity_host}:${port}:127.0.0.1" \
    "${identity_url}/realms/master/.well-known/openid-configuration" >/dev/null; then
    ready=true
    break
  fi
  sleep 0.5
done
if [[ "${ready}" != true ]]; then
  echo "Keycloak did not become ready over TLS." >&2
  docker logs --tail 80 "${container_name}" >&2 || true
  exit 1
fi

container_ip=$(docker inspect --format \
  "{{(index .NetworkSettings.Networks \"${network}\").IPAddress}}" "${container_name}")

ARTIFACT_SERVER_TEST_IDENTITY_HOST="${identity_host}" \
ARTIFACT_SERVER_TEST_IDENTITY_PORT="${port}" \
ARTIFACT_SERVER_TEST_IDENTITY_URL="${identity_url}" \
ARTIFACT_SERVER_TEST_IDENTITY_CA_FILE="${work_directory}/ca.pem" \
ARTIFACT_SERVER_TEST_IDENTITY_NETWORK="${network}" \
ARTIFACT_SERVER_TEST_IDENTITY_CONTAINER="${container_name}" \
ARTIFACT_SERVER_TEST_IDENTITY_CONTAINER_IP="${container_ip}" \
ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_USER="${admin_user}" \
ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_PASSWORD="${admin_password}" \
  "$@"
```

- [ ] **Step 2: Verify the wrapper serves a trusted, hostname-checked TLS issuer**

Run:
```bash
chmod +x scripts/with-private-team-identity.sh
scripts/with-private-team-identity.sh bash -c '
  curl --fail --silent --cacert "$ARTIFACT_SERVER_TEST_IDENTITY_CA_FILE" \
    --resolve "$ARTIFACT_SERVER_TEST_IDENTITY_HOST:$ARTIFACT_SERVER_TEST_IDENTITY_PORT:127.0.0.1" \
    "$ARTIFACT_SERVER_TEST_IDENTITY_URL/realms/master/.well-known/openid-configuration" | node -e "process.stdin.on(\"data\",d=>console.log(JSON.parse(d).issuer))"
  if curl --fail --silent --resolve "$ARTIFACT_SERVER_TEST_IDENTITY_HOST:$ARTIFACT_SERVER_TEST_IDENTITY_PORT:127.0.0.1" \
    "$ARTIFACT_SERVER_TEST_IDENTITY_URL/realms/master" >/dev/null; then echo "UNTRUSTED CA ACCEPTED"; exit 1; fi
  echo untrusted-refused'
```
Expected: prints `https://identity.artifact-server.test:<P>/realms/master` then `untrusted-refused`, and `docker ps -a --filter name=artifact-server-identity` is empty afterwards.

- [ ] **Step 3: Move the Keycloak helpers into `tests/support/keycloak-realm.ts`**

Move `requestAdminToken`, `adminRequest`, `createKeycloakUser`, `provisionKeycloakRealm`, `requestPasswordToken`, `signInAtKeycloak`, `storeCookies`, `cookieHeader`, `redirectTarget`, `loginFormPattern`, the Keycloak representation interfaces, and the client constants verbatim from `tests/integration/oidc-keycloak.test.ts`, with two changes: every `fetch(` call becomes `environment.fetch(`, and `provisionKeycloakRealm` takes `people` and returns `subjects` keyed by email:

```ts
export async function provisionKeycloakRealm(
  environment: KeycloakEnvironment,
  applicationOrigin: string,
  people: readonly KeycloakPerson[],
): Promise<ProvisionedRealm> {
  const token = await requestAdminToken(environment);
  await adminRequest(environment, token, "POST", "/admin/realms", {
    enabled: true,
    realm: keycloakRealm.name,
  });
  // The three client registrations below are unchanged from the original.
  await registerClients(environment, token, applicationOrigin);
  const subjects = new Map<string, string>();
  for (const person of people) {
    // Users are created in order so the returned subjects are deterministic.
    // oxlint-disable-next-line no-await-in-loop
    subjects.set(person.email, await createKeycloakUser(environment, person, token));
  }
  return {
    issuer: `${environment.baseUrl}/realms/${keycloakRealm.name}`,
    subjects,
  };
}
```

`registerClients` contains the three existing `POST /admin/realms/${name}/clients` calls exactly as they are today. `createKeycloakUser(environment, person, token?)` requests an admin token itself when `token` is omitted, so tests can add users after provisioning.

- [ ] **Step 4: Point `oidc-keycloak.test.ts` at the moved helpers**

Replace its local definitions with imports; build its environment as `{...readKeycloakEnvironment(), fetch}` and provision with the two existing people (`admitted@example.test`, `stranger@example.test`); read `realm.subjects.get(admittedEmail)` where it used `realm.admittedSubject`.

- [ ] **Step 5: Write `identity-environment.ts`**

```ts
import {readFile} from "node:fs/promises";
import {lookup as dnsLookup} from "node:dns";

import {Agent, fetch as undiciFetch} from "undici";

import type {KeycloakEnvironment} from "../keycloak-realm.js";

export interface PrivateTeamIdentity {
  readonly caFile: string;
  readonly caPem: string;
  readonly containerIp: string;
  readonly host: string;
  readonly keycloak: KeycloakEnvironment;
  readonly network: string;
  readonly port: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Run this suite through scripts/with-private-team-identity.sh (${name} is unset).`);
  }
  return value;
}

/** Read the wrapper's identity and build a fetch that trusts only its CA. */
export async function readPrivateTeamIdentity(): Promise<PrivateTeamIdentity> {
  const host = required("ARTIFACT_SERVER_TEST_IDENTITY_HOST");
  const caFile = required("ARTIFACT_SERVER_TEST_IDENTITY_CA_FILE");
  const caPem = await readFile(caFile, "utf8");
  const agent = new Agent({
    connect: {
      ca: caPem,
      // The identity hostname exists only on the Docker network; the
      // published port makes loopback the runner's route to it.
      lookup: (hostname, options, callback) =>
        hostname === host
          ? callback(null, [{address: "127.0.0.1", family: 4}])
          : dnsLookup(hostname, {...options, all: true}, callback),
    },
  });
  const identityFetch = ((input, init) =>
    undiciFetch(input, {...init, dispatcher: agent})) as typeof fetch;
  return {
    caFile,
    caPem,
    containerIp: required("ARTIFACT_SERVER_TEST_IDENTITY_CONTAINER_IP"),
    host,
    keycloak: {
      adminPassword: required("ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_PASSWORD"),
      adminUser: required("ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_USER"),
      baseUrl: required("ARTIFACT_SERVER_TEST_IDENTITY_URL"),
      fetch: identityFetch,
    },
    network: required("ARTIFACT_SERVER_TEST_IDENTITY_NETWORK"),
    port: Number(required("ARTIFACT_SERVER_TEST_IDENTITY_PORT")),
  };
}
```

- [ ] **Step 6: Run the existing Keycloak suite to prove the move changed nothing**

Run: `LANG=en_US.UTF-8 pnpm test:oidc`
Expected: same tests pass as before (4 in `oidc-keycloak.test.ts`), `project/evidence/oidc-keycloak.json` has `success: true`.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm exec tsc -p tsconfig.json --noEmit && pnpm lint
git add scripts/with-private-team-identity.sh tests/support/keycloak-realm.ts tests/support/private-team/identity-environment.ts tests/integration/oidc-keycloak.test.ts
git commit -m "Serve the test Keycloak over TLS under one shared issuer hostname"
```

---

### Task 2: Packaged identity-CA trust (Compose overlay and Helm value)

**Files:**
- Create: `packaging/compose/compose.identity-ca.yaml`
- Modify: `packaging/compose/README.md`
- Modify: `packaging/helm/artifact-server/values.yaml` (under `identity:`), `values.schema.json` (`identity` object), `templates/deployment.yaml:86-130`, `README.md`
- Modify: `scripts/verify-helm-chart.sh`

**Interfaces:**
- Produces: Compose overlay reading `ARTIFACT_SERVER_IDENTITY_CA_FILE` (host path). Helm value:
  ```yaml
  identity:
    trustedCertificateAuthorities:
      configMapName: ""   # empty disables
      key: ca.crt
  ```
  Mounted at `/etc/artifact-server/identity-ca/ca.crt`; env `NODE_EXTRA_CA_CERTS=/etc/artifact-server/identity-ca/ca.crt`.

- [ ] **Step 1: Write the failing static chart checks**

Add to `scripts/verify-helm-chart.sh`, beside its existing render assertions (reuse its render helper and values fixture variables):

```bash
# A private-CA identity provider is trusted only when the operator names a ConfigMap.
rendered_default=$(helm template ca-check "$chart" --values "$values_fixture")
if grep -q NODE_EXTRA_CA_CERTS <<<"$rendered_default"; then
  echo "The chart trusts an identity CA nobody configured." >&2; exit 1
fi
rendered_ca=$(helm template ca-check "$chart" --values "$values_fixture" \
  --set identity.trustedCertificateAuthorities.configMapName=identity-ca)
grep -q 'name: NODE_EXTRA_CA_CERTS' <<<"$rendered_ca"
grep -q 'value: "/etc/artifact-server/identity-ca/ca.crt"' <<<"$rendered_ca"
grep -q 'name: identity-ca' <<<"$rendered_ca"
if helm template ca-check "$chart" --values "$values_fixture" \
  --set identity.trustedCertificateAuthorities.key='../escape' >/dev/null 2>&1; then
  echo "The chart accepted a CA key that is not a plain file name." >&2; exit 1
fi
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test:helm-static`
Expected: FAIL on the `grep -q 'name: NODE_EXTRA_CA_CERTS'` line (and the schema currently rejects the unknown property).

- [ ] **Step 3: Implement the Helm value**

`values.yaml`:
```yaml
identity:
  workosClientId: ""
  workosIssuer: ""
  oidcClientId: ""
  oidcIssuer: ""
  oidcScopes: ""
  # Trust a private certificate authority for the identity provider.
  trustedCertificateAuthorities:
    configMapName: ""
    key: ca.crt
```
`values.schema.json` → add `"trustedCertificateAuthorities"` to the identity `properties` (keep it out of `required` so existing values files stay valid):
```json
"trustedCertificateAuthorities": {
  "type": "object",
  "additionalProperties": false,
  "required": ["configMapName", "key"],
  "properties": {
    "configMapName": {"type": "string", "pattern": "^$|^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", "maxLength": 253},
    "key": {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]*$", "maxLength": 253}
  }
}
```
`templates/deployment.yaml`: after `{{- include "artifact-server.runtimeEnvironment" . | nindent 12 }}`:
```yaml
            {{- with .Values.identity.trustedCertificateAuthorities }}
            {{- if .configMapName }}
            - name: NODE_EXTRA_CA_CERTS
              value: "/etc/artifact-server/identity-ca/{{ .key }}"
            {{- end }}
            {{- end }}
```
In `volumeMounts`:
```yaml
            {{- if .Values.identity.trustedCertificateAuthorities.configMapName }}
            - name: identity-ca
              mountPath: /etc/artifact-server/identity-ca
              readOnly: true
            {{- end }}
```
In `volumes`:
```yaml
        {{- with .Values.identity.trustedCertificateAuthorities }}
        {{- if .configMapName }}
        - name: identity-ca
          configMap:
            name: {{ .configMapName | quote }}
            defaultMode: 292
            items:
              - key: {{ .key | quote }}
                path: {{ .key | quote }}
        {{- end }}
        {{- end }}
```
The `value:` line renders `/etc/artifact-server/identity-ca/ca.crt` for the default key, matching the Step 1 assertion.

- [ ] **Step 4: Run the static checks**

Run: `pnpm test:helm-static`
Expected: PASS.

- [ ] **Step 5: Write the Compose overlay**

`packaging/compose/compose.identity-ca.yaml`:
```yaml
# Trust a private certificate authority for the identity provider.
# Use with: docker compose -f compose.yaml -f compose.identity-ca.yaml up
services:
  artifact-server:
    environment:
      - NODE_EXTRA_CA_CERTS=/etc/artifact-server/identity-ca.pem
    volumes:
      - type: bind
        source: ${ARTIFACT_SERVER_IDENTITY_CA_FILE:?Set ARTIFACT_SERVER_IDENTITY_CA_FILE to the identity provider CA bundle}
        target: /etc/artifact-server/identity-ca.pem
        read_only: true
```
Document both features in `packaging/compose/README.md` and the chart `README.md` (one short section each: when you need it, the variable/value, that the bundle adds to — never replaces — the default trust store).

- [ ] **Step 6: Verify the overlay composes with both stacks**

Run:
```bash
ARTIFACT_SERVER_IMAGE=x ARTIFACT_SERVER_CONTENT_DOMAIN=c.example.net ARTIFACT_SERVER_ORIGIN=https://a.example.com \
ARTIFACT_SERVER_IDENTITY_CA_FILE=/etc/hosts \
docker compose -f packaging/compose/compose.yaml -f packaging/compose/compose.identity-ca.yaml config \
  | grep -E 'NODE_EXTRA_CA_CERTS|identity-ca.pem'
```
Expected: both lines present. Repeat with `compose.external-storage.yaml` added between the two files (supply its required variables as in `tests/release/external-storage-compose.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add packaging scripts/verify-helm-chart.sh
git commit -m "Let packaged installations trust a private identity-provider CA"
```

---

### Task 3: Packaged-replica client and the runtime driver contract

**Files:**
- Create: `tests/support/private-team/application-client.ts`
- Create: `tests/support/private-team/runtime.ts` (the interface only; Task 4 adds the selector)

**Interfaces:**
- Consumes: `PrivateTeamIdentity`, `signInAtKeycloak`, `keycloakRealm` (Task 1).
- Produces:
  ```ts
  // application-client.ts
  export const packagedApplicationOrigin = "https://artifacts.example.com";
  export const packagedContentDomain = "content.example.net";
  export interface SessionCookies { readonly header: string; readonly csrf: string }
  export interface ReplicaClient {
    readonly endpoint: string;               // "127.0.0.1:<port>", for diagnostics
    fetch(pathOrUrl: string, init?: RequestInit): Promise<Response>;
    readonly host: string;                   // Host header it sends, default the application host
  }
  export function replicaClient(port: number, host?: string): ReplicaClient;
  export function sessionCookies(setCookie: readonly string[]): SessionCookies;   // accepts __Host- names
  export function mutationHeaders(cookies: SessionCookies | null): Headers;
  export function issuedSession(response: Response): boolean;
  export function signInThroughProvider(client: ReplicaClient, identity: PrivateTeamIdentity, credentials: {readonly username: string; readonly password: string}): Promise<Response>; // the /auth/callback response
  // runtime.ts
  export type PrivateTeamTarget = "compact-compose" | "external-compose" | "helm";
  export interface PrivateTeamRuntime {
    readonly target: PrivateTeamTarget;
    readonly deployment: "single_server" | "kubernetes";
    readonly bootstrapAdministrator: {readonly email: string; readonly password: string};
    readonly serviceKey: string;             // the installation's managed as_key_ machine credential
    readonly replicas: readonly ReplicaClient[];
    start(): Promise<void>;                  // valid private-team configuration
    stop(): Promise<void>;
    /** Start with env overrides (null removes a variable); resolve with the refusal text if no replica ever reports ready. */
    expectStartupRefused(overrides: Readonly<Record<string, string | null>>): Promise<string>;
    /** Text of the running replicas' startup logs. */
    startupLogs(): Promise<string>;
    /** Credentials that exist on disk for this runtime and must never authenticate. */
    strayCredentials(): Promise<readonly {readonly name: string; readonly token: string}[]>;
    /** Provider bindings recorded for an email, read from the runtime's own store. */
    externalIdentityCount(email: string): Promise<number>;
  }
  // Added to application-client.ts in Task 5:
  export function publishThroughReplica(client: ReplicaClient, token: string, content: string): Promise<{readonly artifactId: string; readonly versionId: string}>;
  // Added in Task 4 (compact case), extended in Tasks 5 and 6:
  export function selectPrivateTeamRuntime(identity: PrivateTeamIdentity): Promise<PrivateTeamRuntime>;
  ```

- [ ] **Step 1: Write `application-client.ts`**

```ts
import {Agent, type Dispatcher, fetch as undiciFetch} from "undici";

import {signInAtKeycloak} from "../keycloak-realm.js";
import {loginHandshakeCookie} from "../runtime-harness.js";
import type {PrivateTeamIdentity} from "./identity-environment.js";

export const packagedApplicationOrigin = "https://artifacts.example.com";
export const packagedContentDomain = "content.example.net";
const applicationHost = new URL(packagedApplicationOrigin).host;

export interface SessionCookies {
  readonly csrf: string;
  readonly header: string;
}

export interface ReplicaClient {
  readonly endpoint: string;
  readonly host: string;
  fetch(pathOrUrl: string, init?: RequestInit): Promise<Response>;
}

/**
 * Address one packaged replica as the HTTPS management origin it serves:
 * the request travels as plain HTTP to that replica's port while keeping the
 * management Host, the way the TLS gateway in front of it would send it.
 */
export function replicaClient(port: number, host = applicationHost): ReplicaClient {
  const target = `http://127.0.0.1:${port}`;
  const agent = new Agent();
  const dispatcher: Dispatcher = agent.compose((dispatch) => (options, handler) =>
    dispatch({
      ...options,
      headers: {...headerRecord(options.headers), host},
      origin: target,
    }, handler));
  return {
    endpoint: `127.0.0.1:${port}`,
    fetch: (pathOrUrl, init) => {
      const url = new URL(pathOrUrl, packagedApplicationOrigin);
      return undiciFetch(url, {...init, dispatcher, redirect: "manual"}) as Promise<Response>;
    },
    host,
  };
}

function headerRecord(headers: Dispatcher.DispatchOptions["headers"]): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined || headers === null) return record;
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      record[String(headers[index])] = String(headers[index + 1]);
    }
    return record;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && name.toLowerCase() !== "host") record[name] = String(value);
  }
  return record;
}

const cookieName = /^(?:__Host-)?(artifact_session|artifact_csrf)=([^;]*)/u;

export function sessionCookies(setCookie: readonly string[]): SessionCookies {
  const pairs = new Map<string, {readonly pair: string; readonly value: string}>();
  for (const header of setCookie) {
    const match = cookieName.exec(header);
    if (match?.[1] !== undefined && match[2] !== undefined && match[2] !== "") {
      pairs.set(match[1], {pair: header.split(";", 1)[0] ?? "", value: match[2]});
    }
  }
  const session = pairs.get("artifact_session");
  const csrf = pairs.get("artifact_csrf");
  if (session === undefined || csrf === undefined) {
    throw new Error("The response did not issue both application cookies.");
  }
  return {csrf: csrf.value, header: `${session.pair}; ${csrf.pair}`};
}

export function issuedSession(response: Response): boolean {
  return response.headers.getSetCookie().some((header) =>
    /^(?:__Host-)?artifact_session=[^;]+/u.test(header)
  );
}

export function mutationHeaders(cookies: SessionCookies | null): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: packagedApplicationOrigin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  });
  if (cookies !== null) {
    headers.set("Cookie", cookies.header);
    headers.set("X-CSRF-Token", cookies.csrf);
  }
  return headers;
}

/** Drive one browser login through the real provider and return the callback answer. */
export async function signInThroughProvider(
  client: ReplicaClient,
  identity: PrivateTeamIdentity,
  credentials: {readonly password: string; readonly username: string},
): Promise<Response> {
  const login = await client.fetch("/auth/login");
  if (login.status !== 302) throw new Error(`/auth/login answered ${login.status}.`);
  const location = login.headers.get("location");
  if (location === null) throw new Error("/auth/login gave no provider location.");
  const callback = await signInAtKeycloak(identity.keycloak, new URL(location), credentials);
  return client.fetch(callback.toString(), {
    headers: {Cookie: loginHandshakeCookie(login)},
  });
}
```

Before writing it, confirm `Agent#compose` exists in undici 7.29.0 (`grep -n "compose(" node_modules/undici/types/dispatcher.d.ts`) and that `loginHandshakeCookie` already accepts `__Host-artifact_login` (`tests/support/runtime-harness.ts:308`, it does).

- [ ] **Step 2: Write `runtime.ts` (interface now, selector in Task 4)**

```ts
import type {ReplicaClient} from "./application-client.js";

export type PrivateTeamTarget = "compact-compose" | "external-compose" | "helm";

export interface PrivateTeamRuntime {
  readonly bootstrapAdministrator: {readonly email: string; readonly password: string};
  readonly deployment: "single_server" | "kubernetes";
  readonly replicas: readonly ReplicaClient[];
  readonly serviceKey: string;
  readonly target: PrivateTeamTarget;
  expectStartupRefused(overrides: Readonly<Record<string, string | null>>): Promise<string>;
  externalIdentityCount(email: string): Promise<number>;
  start(): Promise<void>;
  startupLogs(): Promise<string>;
  stop(): Promise<void>;
  strayCredentials(): Promise<readonly {readonly name: string; readonly token: string}[]>;
}
```

Task 4 Step 3 appends this selector with only the `compact-compose` case; Task 5 Step 3 adds `external-compose` and Task 6 Step 1 adds `helm`, so every commit typechecks:

```ts
export async function selectPrivateTeamRuntime(
  identity: PrivateTeamIdentity,
): Promise<PrivateTeamRuntime> {
  const target = process.env["ARTIFACT_SERVER_PRIVATE_TEAM_TARGET"];
  switch (target) {
    case "compact-compose":
      return (await import("./compact-compose-runtime.js")).compactComposeRuntime(identity);
    case "external-compose":
      return (await import("./external-compose-runtime.js")).externalComposeRuntime(identity);
    case "helm":
      return (await import("./helm-runtime.js")).helmRuntime(identity);
    default:
      throw new Error(
        "Set ARTIFACT_SERVER_PRIVATE_TEAM_TARGET to compact-compose, external-compose, or helm.",
      );
  }
}
```

- [ ] **Step 3: Typecheck, lint, and commit**

```bash
pnpm exec tsc -p tsconfig.json --noEmit && pnpm lint
git add tests/support/private-team/application-client.ts tests/support/private-team/runtime.ts
git commit -m "Address a packaged replica as its HTTPS management origin in tests"
```

---

### Task 4: Shared suite and the compact Compose driver (AUTH-025 on single_server)

**Files:**
- Create: `tests/release/private-team-access.test.ts`
- Create: `tests/support/private-team/compact-compose-runtime.ts`
- Modify: `tests/conformance/installation-identity.test.ts:85` and `:677` (titles only)
- Modify: `tests/configs/vitest.compose.config.ts` (include), `scripts/run-compact-compose-integration.sh`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `compactComposeRuntime(identity: PrivateTeamIdentity): PrivateTeamRuntime`; the four owned test titles.

- [ ] **Step 1: Write the AUTH-025 tests (they fail: no driver yet)**

`tests/release/private-team-access.test.ts`:
```ts
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createKeycloakUser,
  keycloakRealm,
  provisionKeycloakRealm,
  requestPasswordToken,
} from "../support/keycloak-realm.js";
import {
  issuedSession,
  mutationHeaders,
  packagedApplicationOrigin,
  replicaClient,
  sessionCookies,
  signInThroughProvider,
} from "../support/private-team/application-client.js";
import {
  type PrivateTeamIdentity,
  readPrivateTeamIdentity,
} from "../support/private-team/identity-environment.js";
import {
  type PrivateTeamRuntime,
  selectPrivateTeamRuntime,
} from "../support/private-team/runtime.js";

const cacheBoundMilliseconds = 30_000;
// Decided at collection time, before any runtime exists: only compact Compose is single-replica.
const multiReplica = process.env["ARTIFACT_SERVER_PRIVATE_TEAM_TARGET"] !== "compact-compose";
const member = {
  displayName: "Team Member",
  email: "member@example.test",
  password: "member-keycloak-integration-only",
};
const outsider = {email: "outsider@example.test", password: "outsider-keycloak-integration-only"};
const sessionSchema = z.object({principal: z.object({id: z.string()}).loose()}).loose();
const admittedSchema = z.object({member: z.object({id: z.string()}).loose()}).loose();
const issuedKeySchema = z.object({
  apiKey: z.object({id: z.string(), principalId: z.string()}).loose(),
  token: z.string().startsWith("as_key_"),
}).loose();

let identity: PrivateTeamIdentity;
let runtime: PrivateTeamRuntime;

beforeAll(async () => {
  identity = await readPrivateTeamIdentity();
  runtime = await selectPrivateTeamRuntime(identity);
  await provisionKeycloakRealm(identity.keycloak, packagedApplicationOrigin, [
    {
      email: runtime.bootstrapAdministrator.email,
      firstName: "Ada",
      lastName: "Lovelace",
      password: runtime.bootstrapAdministrator.password,
      username: runtime.bootstrapAdministrator.email,
    },
    {email: member.email, firstName: "Team", lastName: "Member", password: member.password, username: member.email},
    {email: outsider.email, firstName: "Out", lastName: "Sider", password: outsider.password, username: outsider.email},
  ]);
  await runtime.start();
}, 600_000);

afterAll(async () => {
  await runtime?.stop();
}, 300_000);

describe.sequential(`private-team access on ${process.env["ARTIFACT_SERVER_PRIVATE_TEAM_TARGET"] ?? "unset"}`, () => {
  test("AUTH-025-B: the packaged runtime bootstraps its administrator through the provider and admits only managed or provider-bound automation", async () => {
    const [first] = runtime.replicas;
    if (first === undefined) throw new Error("The runtime exposes no replica.");
    expect(await runtime.startupLogs()).not.toContain("discovery_failed");

    await expect((await first.fetch("/auth/context")).json()).resolves.toEqual({
      accessMode: "private_team",
      login: {kind: "oidc"},
    });

    const administratorLogin = await signInThroughProvider(first, identity, {
      password: runtime.bootstrapAdministrator.password,
      username: runtime.bootstrapAdministrator.email,
    });
    expect(administratorLogin.status).toBe(303);
    const administrator = sessionCookies(administratorLogin.headers.getSetCookie());
    const session = await first.fetch("/api/v1/session", {headers: {Cookie: administrator.header}});
    expect(session.status).toBe(200);
    sessionSchema.parse(await session.json());
    expect(await runtime.externalIdentityCount(runtime.bootstrapAdministrator.email)).toBe(1);

    // The managed machine key is request authority; the browser session is not MCP authority.
    expect((await first.fetch("/api/v1/artifacts", {
      headers: {Authorization: `Bearer ${runtime.serviceKey}`},
    })).status).toBe(200);
    expect((await first.fetch("/mcp", {
      body: JSON.stringify({id: 1, jsonrpc: "2.0", method: "tools/list"}),
      headers: {Accept: "application/json, text/event-stream", "Content-Type": "application/json", Cookie: administrator.header},
      method: "POST",
    })).status).toBe(401);

    // A provider token bound to the exact /mcp resource is MCP authority and nothing else.
    const issuer = `${identity.keycloak.baseUrl}/realms/${keycloakRealm.name}`;
    const bound = await requestPasswordToken(identity.keycloak, issuer, keycloakRealm.mcpClientId,
      keycloakRealm.mcpClientSecret, {password: runtime.bootstrapAdministrator.password, username: runtime.bootstrapAdministrator.email});
    expect((await first.fetch("/mcp", {
      body: JSON.stringify({id: 1, jsonrpc: "2.0", method: "tools/list"}),
      headers: {Accept: "application/json, text/event-stream", Authorization: `Bearer ${bound}`, "Content-Type": "application/json"},
      method: "POST",
    })).status).toBe(200);
    expect((await first.fetch("/api/v1/artifacts", {headers: {Authorization: `Bearer ${bound}`}})).status).toBe(401);
    const unbound = await requestPasswordToken(identity.keycloak, issuer, keycloakRealm.unboundClientId,
      keycloakRealm.unboundClientSecret, {password: runtime.bootstrapAdministrator.password, username: runtime.bootstrapAdministrator.email});
    expect((await first.fetch("/mcp", {
      body: JSON.stringify({id: 1, jsonrpc: "2.0", method: "tools/list"}),
      headers: {Accept: "application/json, text/event-stream", Authorization: `Bearer ${unbound}`, "Content-Type": "application/json"},
      method: "POST",
    })).status).toBe(401);

    // Only the bootstrap email could create the first member; an outsider stays out.
    const outsiderLogin = await signInThroughProvider(first, identity, {password: outsider.password, username: outsider.email});
    expect(outsiderLogin.status).toBeGreaterThanOrEqual(400);
    expect(issuedSession(outsiderLogin)).toBe(false);
    expect(await runtime.externalIdentityCount(outsider.email)).toBe(0);
  });

  test("AUTH-025-F: misconfigured providers, local bootstrap credentials, the legacy bearer, and foreign hosts grant no authority", async () => {
    const [first] = runtime.replicas;
    if (first === undefined) throw new Error("The runtime exposes no replica.");
    const boundary = {Origin: packagedApplicationOrigin, "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin"};
    expect((await first.fetch("/auth/local-owner", {headers: boundary, method: "POST"})).status).toBe(404);
    for (const stray of await runtime.strayCredentials()) {
      expect({name: stray.name, status: (await first.fetch("/auth/local", {
        headers: {Authorization: `Bearer ${stray.token}`}, method: "POST",
      })).status}).toEqual({name: stray.name, status: 404});
      expect({name: stray.name, status: (await first.fetch("/api/v1/artifacts", {
        headers: {Authorization: `Bearer ${stray.token}`},
      })).status}).toEqual({name: stray.name, status: 401});
    }
    expect((await first.fetch("/api/v1/artifacts", {
      headers: {Authorization: "Bearer legacy-installation-bearer-with-sufficient-entropy"},
    })).status).toBe(401);

    const foreign = replicaClient(Number(first.endpoint.split(":")[1]), "evil.example");
    expect((await foreign.fetch("/api/v1/artifacts", {
      headers: {Authorization: `Bearer ${runtime.serviceKey}`},
    })).status).not.toBe(200);

    await runtime.stop();
    const refusals = {
      noProvider: await runtime.expectStartupRefused({ARTIFACT_SERVER_OIDC_CLIENT_ID: null, ARTIFACT_SERVER_OIDC_ISSUER: null}),
      twoProviders: await runtime.expectStartupRefused({ARTIFACT_SERVER_WORKOS_CLIENT_ID: "client_conflict", ARTIFACT_SERVER_WORKOS_ISSUER: "https://api.workos.com"}),
      localBootstrap: await runtime.expectStartupRefused({ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN: "x".repeat(43)}),
    };
    expect(refusals.noProvider).toContain("requires exactly one OIDC or WorkOS");
    expect(refusals.twoProviders).toMatch(/OIDC|WorkOS/u);
    expect(refusals.localBootstrap).toContain("ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN");
    await runtime.start();
  });
});
```

Oxlint denies unused bindings, so in Task 4 leave out `createKeycloakUser`, `cacheBoundMilliseconds`, `multiReplica`, `admittedSchema`, and `issuedKeySchema`; Task 5 adds them with the tests that use them.

Before Step 2, confirm the three refusal messages against the real startup code (`grep -rn "requires exactly one OIDC or WorkOS\|LOCAL_BOOTSTRAP_TOKEN" src`) and tighten the `toMatch` to the exact sentence for `twoProviders`. Confirm the `/mcp` request shape against `callMcp` in `tests/integration/oidc-keycloak.test.ts:336`.

- [ ] **Step 2: Move the IDs off the in-process tests**

In `tests/conformance/installation-identity.test.ts`:
- line 85: `"AUTH-027-B AUTH-027-F: bootstrap membership and managed keys fail closed"` → `"bootstrap membership and managed keys fail closed"`
- line 677: `"AUTH-025-B AUTH-025-F AUTH-026-F: private-team mode …"` → `"AUTH-026-F: private-team mode advertises its provider and has no local browser bootstrap route"`

Run: `ruby scripts/check-conformance-test-ids.rb`
Expected: PASS (each of the four IDs is now claimed only by `tests/release/private-team-access.test.ts`).

- [ ] **Step 3: Write the compact Compose driver**

`tests/support/private-team/compact-compose-runtime.ts` implements `PrivateTeamRuntime` with:
- one Compose project from `packaging/compose/compose.yaml` + `packaging/compose/compose.identity-ca.yaml` + a generated override that joins `identity.network` as an external network (same shape as `tests/fixtures/compose.external-storage.test.yaml`);
- environment: the fixed variables from `createProject` in `tests/release/compact-compose.test.ts:554` with `ARTIFACT_SERVER_OIDC_ISSUER=${identity.keycloak.baseUrl}/realms/artifact-server`, `ARTIFACT_SERVER_OIDC_CLIENT_ID=keycloakRealm.oidcClientId`, `ARTIFACT_SERVER_OIDC_CLIENT_SECRET=keycloakRealm.oidcClientSecret`, `ARTIFACT_SERVER_OIDC_SCOPES=keycloakRealm.scopes`, `ARTIFACT_SERVER_IDENTITY_CA_FILE=identity.caFile`;
- `start()`: `init --admin-email admin@example.test` (first start only), `up --detach --wait`, then `serviceKey` read from `/var/lib/artifact-server/data/secrets/api-token` as `readApiToken` does;
- `expectStartupRefused(overrides)`: writes an override environment, runs `up --detach`, polls the container until it has exited or 60 s pass, fails if `/ready` ever answered 200, returns `docker logs` text, then `down` without removing the volume;
- `strayCredentials()`: `[{name: "generated compact browser bootstrap", token: <contents of secrets/browser-bootstrap-token>}]` when that file exists;
- `externalIdentityCount(email)`: `docker compose run --rm --no-deps --entrypoint node artifact-server -e "<DatabaseSync query on data/artifact-server.sqlite>"` counting `external_identities` rows for the email (use the same table and columns as `externalIdentities` in `tests/integration/oidc-keycloak.test.ts:686`);
- `replicas`: `[replicaClient(port)]`; `deployment: "single_server"`; `bootstrapAdministrator: {email: "admin@example.test", password: "admin-keycloak-integration-only"}`.

Then append `selectPrivateTeamRuntime` to `runtime.ts` (Task 3 Step 2 shows it) with only the `compact-compose` case and the `default` error.

Extract the generic `compose()`/`command()`/`availablePort()`/`redact()` helpers from `tests/release/compact-compose.test.ts:789-886` into `tests/support/release-commands.ts` and import them from both files rather than copying.

- [ ] **Step 4: Wire the harness**

`tests/configs/vitest.compose.config.ts`: `include: ["tests/release/compact-compose.test.ts", "tests/release/private-team-access.test.ts"]`.
`scripts/run-compact-compose-integration.sh`: replace the final `pnpm exec vitest run …` with
```bash
ARTIFACT_SERVER_PRIVATE_TEAM_TARGET=compact-compose \
  "$artifactserver_repository/scripts/with-private-team-identity.sh" \
  pnpm exec vitest run \
    --config tests/configs/vitest.compose.config.ts \
    --reporter=default \
    --reporter=json \
    --outputFile.json=project/evidence/compact-compose.json
```

- [ ] **Step 5: Run and iterate until AUTH-025 passes on compact Compose**

Run: `pnpm test:compact-compose`
Expected: all existing compact Compose tests plus `AUTH-025-B` and `AUTH-025-F` pass; the two AUTH-027 tests are skipped (Task 5 adds them behind `multiReplica`). Fix the driver, not the assertions, unless a refusal message differs from the startup code — then use the exact message.

- [ ] **Step 6: Commit**

```bash
git add tests/release/private-team-access.test.ts tests/support/private-team tests/support/release-commands.ts tests/release/compact-compose.test.ts tests/conformance/installation-identity.test.ts tests/configs/vitest.compose.config.ts scripts/run-compact-compose-integration.sh project/evidence/compact-compose.json
git commit -m "Prove private-team startup and request authority on compact Compose"
```

---

### Task 5: AUTH-027 tests and the two-replica external-storage Compose driver

**Files:**
- Modify: `tests/release/private-team-access.test.ts` (add two tests)
- Create: `tests/support/private-team/external-compose-runtime.ts`
- Modify: `tests/configs/vitest.external-storage-compose.config.ts`, `scripts/run-external-storage-compose-integration.sh`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `externalComposeRuntime(identity): PrivateTeamRuntime` with `replicas.length === 2`, `deployment: "single_server"`.

- [ ] **Step 1: Write the AUTH-027 tests**

Extend the `application-client.js` import with `publishThroughReplica`, `type ReplicaClient`, and `type SessionCookies`, add `createKeycloakUser` use below, then append inside the `describe.sequential` block:
```ts
  test.runIf(multiReplica)("AUTH-027-B: deactivation stops provider login, sessions, and member keys on every replica within the cache bound", async () => {
    const [first, second] = runtime.replicas;
    if (first === undefined || second === undefined) throw new Error("Two replicas are required.");
    const administrator = sessionCookies((await signInThroughProvider(first, identity, {
      password: runtime.bootstrapAdministrator.password, username: runtime.bootstrapAdministrator.email,
    })).headers.getSetCookie());

    const admitted = admittedSchema.parse(await (await first.fetch("/api/v1/members", {
      body: JSON.stringify({displayName: member.displayName, email: member.email}),
      headers: mutationHeaders(administrator), method: "POST",
    })).json()).member;
    const memberLogin = await signInThroughProvider(first, identity, {password: member.password, username: member.email});
    expect(memberLogin.status).toBe(303);
    const memberSession = sessionCookies(memberLogin.headers.getSetCookie());
    const memberKey = issuedKeySchema.parse(await (await first.fetch("/api/v1/api-keys", {
      body: JSON.stringify({capabilities: ["artifact:read", "artifact:write", "comment:write"], expiresAt: "2099-01-01T00:00:00.000Z", memberId: admitted.id, name: "Member automation key"}),
      headers: mutationHeaders(administrator), method: "POST",
    })).json());

    // The member leaves durable, attributed work behind.
    const work = await publishAndComment(first, memberKey.token);

    // Warm both credentials on both replicas.
    for (const replica of [first, second]) {
      expect((await replica.fetch("/api/v1/session", {headers: {Cookie: memberSession.header}})).status).toBe(200);
      expect((await replica.fetch("/api/v1/artifacts", {headers: {Authorization: `Bearer ${memberKey.token}`}})).status).toBe(200);
    }

    expect((await first.fetch(`/api/v1/members/${admitted.id}/deactivate`, {
      headers: mutationHeaders(administrator), method: "POST",
    })).status).toBe(200);
    const deactivatedAt = Date.now();

    // Same process: immediate.
    expect((await first.fetch("/api/v1/session", {headers: {Cookie: memberSession.header}})).status).toBe(401);
    expect((await first.fetch("/api/v1/artifacts", {headers: {Authorization: `Bearer ${memberKey.token}`}})).status).toBe(401);

    // Other replica: refused within the documented bound.
    const refusedAt = await waitForRefusal(second, memberSession.header, memberKey.token, deactivatedAt + cacheBoundMilliseconds + 5_000);
    expect(refusedAt - deactivatedAt).toBeLessThanOrEqual(cacheBoundMilliseconds + 5_000);

    // Provider login is refused without a session or a second binding.
    const relogin = await signInThroughProvider(second, identity, {password: member.password, username: member.email});
    expect(relogin.status).toBeGreaterThanOrEqual(400);
    expect(issuedSession(relogin)).toBe(false);
    expect(await runtime.externalIdentityCount(member.email)).toBe(1);

    await expectWorkPreserved(first, administrator, work, admitted.id);
  });

  test.runIf(multiReplica)("AUTH-027-F: a deactivated member regains nothing through new bindings, old sessions, keys, or stale caches, and nothing attributed is removed", async () => {
    const [first, second] = runtime.replicas;
    if (first === undefined || second === undefined) throw new Error("Two replicas are required.");
    const administrator = sessionCookies((await signInThroughProvider(second, identity, {
      password: runtime.bootstrapAdministrator.password, username: runtime.bootstrapAdministrator.email,
    })).headers.getSetCookie());

    // A second provider identity with the deactivated member's email cannot bind.
    await createKeycloakUser(identity.keycloak, {
      email: member.email, firstName: "Team", lastName: "Impostor",
      password: "impostor-keycloak-integration-only", username: "member-second-account",
    });
    const secondAccount = await signInThroughProvider(first, identity, {password: "impostor-keycloak-integration-only", username: "member-second-account"});
    expect(issuedSession(secondAccount)).toBe(false);
    expect(await runtime.externalIdentityCount(member.email)).toBe(1);

    // Well past the bound, nothing the member held authenticates on either replica, and no request mints a replacement cookie.
    for (const replica of [first, second]) {
      const members = await (await replica.fetch("/api/v1/members", {headers: {Cookie: administrator.header}})).json();
      expect(JSON.stringify(members)).toContain('"status":"deactivated"');
      expect((await replica.fetch("/api/v1/artifacts", {headers: {Authorization: `Bearer ${runtime.serviceKey}`}})).status).toBe(200);
    }
    // The service principal survived; durable records survived (asserted again after the bound in expectWorkPreserved).
  });
```

Add the helpers at the bottom of the file. AUTH-027-F reads state AUTH-027-B left behind; that dependency is why the block is `describe.sequential`.
```ts
interface MemberWork {
  readonly artifactId: string;
  readonly versionId: string;
  readonly threadId: string;
}

async function publishAndComment(client: ReplicaClient, token: string): Promise<MemberWork> {
  // Use the staged upload flow of tests/support/publishing.ts (publishNew), passing a
  // fetch that routes through `client` and rewrites upload URLs to the same replica.
  const published = await publishThroughReplica(client, token, "member-owned proof");
  const thread = await client.fetch(
    `/api/v1/artifacts/${published.artifactId}/versions/${published.versionId}/comments`,
    {
      body: JSON.stringify({body: "member-authored comment"}),
      headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "auth-027-comment"},
      method: "POST",
    },
  );
  expect(thread.status).toBe(201);
  const threadId = z.object({thread: z.object({id: z.string()}).loose()}).loose().parse(await thread.json()).thread.id;
  return {...published, threadId};
}

async function waitForRefusal(client: ReplicaClient, sessionHeader: string, token: string, deadline: number): Promise<number> {
  for (;;) {
    // Polling is the behavior under test: refusal must arrive inside the bound.
    // oxlint-disable-next-line no-await-in-loop
    const [session, key] = await Promise.all([
      client.fetch("/api/v1/session", {headers: {Cookie: sessionHeader}}),
      client.fetch("/api/v1/artifacts", {headers: {Authorization: `Bearer ${token}`}}),
    ]);
    if (session.status === 401 && key.status === 401) return Date.now();
    if (Date.now() > deadline) throw new Error(`Replica ${client.endpoint} still accepted the deactivated member at the bound.`);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function expectWorkPreserved(client: ReplicaClient, administrator: SessionCookies, work: MemberWork, memberId: string): Promise<void> {
  const headers = {Cookie: administrator.header};
  expect((await client.fetch(`/api/v1/artifacts/${work.artifactId}`, {headers})).status).toBe(200);
  const comments = await (await client.fetch(`/api/v1/artifacts/${work.artifactId}/comments`, {headers})).json();
  expect(JSON.stringify(comments)).toContain(work.threadId);
  expect(JSON.stringify(comments)).toContain(memberId);
  const activity = await (await client.fetch("/api/v1/activity", {headers})).json();
  expect(JSON.stringify(activity)).toContain(memberId);
}
```

`publishThroughReplica` lives in `tests/support/private-team/application-client.ts`: create the upload with `POST /api/v1/uploads` (body shape from `createStagedUpload` in `tests/support/publishing.ts:151`), `PUT` each returned `uploadUrl` through `client.fetch` (its origin is `https://artifacts.example.com`, which `client` already routes), then `POST` the returned `commitUrl` with `{target: {accessSetting: "account_required", kind: "new_artifact", name: "Member proof"}}` and an `Idempotency-Key`. Return `{artifactId, versionId}` from the commit response. Confirm the bodies against `createStagedUpload`/`commitStagedUpload` before writing.

- [ ] **Step 2: Run on compact Compose to confirm the new tests skip there**

Run: `pnpm test:compact-compose`
Expected: AUTH-025 pass; AUTH-027 reported `skipped`.

- [ ] **Step 3: Write the external-storage Compose driver**

Same contract as Task 4 Step 3, built from `tests/release/external-storage-compose.test.ts:458-560` (`createProject`, `migrate`, `startReplicas`, `replicaPorts`): two replicas from `compose.yaml` + `compose.external-storage.yaml` + S3 secrets example + `tests/fixtures/compose.external-storage.test.yaml` + `packaging/compose/compose.identity-ca.yaml`, with `ARTIFACT_SERVER_TEST_DOCKER_NETWORK=identity.network` so the replicas share the identity network and the provider network. `replicas` = one `replicaClient` per `replicaPorts()` entry, after asserting the two container IDs differ. Add the `external-compose` case to `selectPrivateTeamRuntime`. `externalIdentityCount` queries Postgres (`SELECT count(*) FROM external_identities WHERE installation_id = $1 AND lower(email) = lower($2)`) through the test database URL the harness already exports. `strayCredentials()` returns `[]` (no generated browser credential exists here). `serviceKey` is the `as_key_` token the harness seeds today.

- [ ] **Step 4: Wire the harness**

`tests/configs/vitest.external-storage-compose.config.ts`: include the shared suite. `scripts/run-external-storage-compose-integration.sh`: run the existing `with-external-storage-test-providers.sh … vitest` command inside `scripts/with-private-team-identity.sh` with `ARTIFACT_SERVER_PRIVATE_TEAM_TARGET=external-compose`, and export `ARTIFACT_SERVER_TEST_IDENTITY_NETWORK` to the provider network name the providers script uses so Keycloak joins that network instead of creating its own.

- [ ] **Step 5: Run until all four tests pass on external-storage Compose**

Run: `pnpm test:external-storage-compose`
Expected: existing DEP-020 tests plus `AUTH-025-B`, `AUTH-025-F`, `AUTH-027-B`, `AUTH-027-F` pass. `AUTH-027-B` takes up to ~35 s.

- [ ] **Step 6: Commit**

```bash
git add tests/release/private-team-access.test.ts tests/support/private-team tests/configs/vitest.external-storage-compose.config.ts scripts/run-external-storage-compose-integration.sh project/evidence/external-storage-compose.json
git commit -m "Prove member deactivation across two external-storage Compose replicas"
```

---

### Task 6: Two-replica Helm driver (kubernetes)

**Files:**
- Create: `tests/support/private-team/helm-runtime.ts`
- Modify: `tests/configs/vitest.helm.config.ts`, `scripts/run-helm-integration.sh`

**Interfaces:**
- Consumes: Tasks 1–5 and the Task 2 Helm value.
- Produces: `helmRuntime(identity): PrivateTeamRuntime` with two pod-addressed replicas, `deployment: "kubernetes"`.

- [ ] **Step 1: Write the driver**

The driver reuses the kind cluster, Postgres, and MinIO that `tests/release/helm-chart.test.ts` creates (extract its `beforeAll` cluster/provider bring-up and `writeValues`/`createRuntimeSecret` into `tests/support/helm-cluster.ts` and import from both). On top of that it:
1. Connects the Keycloak container to the `kind` network: `docker network connect --alias identity.artifact-server.test kind <ARTIFACT_SERVER_TEST_IDENTITY_CONTAINER>` and reads its `kind` IP.
2. Makes pods resolve the identity host by adding a `hosts` block to CoreDNS:
   ```bash
   kubectl -n kube-system get configmap coredns -o json \
     | node -e '<insert "hosts { <ip> identity.artifact-server.test\n fallthrough }" before the "ready" line of data.Corefile>' \
     | kubectl apply -f - && kubectl -n kube-system rollout restart deployment/coredns && kubectl -n kube-system rollout status deployment/coredns
   ```
3. Creates ConfigMap `identity-ca` from `identity.caFile` (key `ca.crt`) and installs the chart with `identity.oidcIssuer`, `identity.oidcClientId`, `secret.keys.oidcClientSecret` (add the secret literal to the runtime Secret), `identity.trustedCertificateAuthorities.configMapName=identity-ca`, `replicaCount: 2`.
4. `replicas`: `kubectl get pods -l app.kubernetes.io/name=artifact-server -o json`, require two Ready pods on different nodes, and open one `kubectl port-forward pod/<name> :8787` per pod (reuse `withPortForward`'s spawn/parse logic, keeping both forwards open until `stop()`); wrap each port with `replicaClient`.
5. `expectStartupRefused(overrides)`: `helm upgrade` to a scratch namespace with the overridden identity values and `--wait --timeout 90s`; resolve with the pod logs when the upgrade fails and no pod ever became Ready; uninstall the scratch release.
6. `externalIdentityCount`: same Postgres query as Task 5, through `docker exec <postgres container> psql`.
7. Add the `helm` case to `selectPrivateTeamRuntime`.

- [ ] **Step 2: Wire the harness**

`tests/configs/vitest.helm.config.ts`: include the shared suite. `scripts/run-helm-integration.sh`: wrap the `vitest` command with `scripts/with-private-team-identity.sh` and `ARTIFACT_SERVER_PRIVATE_TEAM_TARGET=helm`.

- [ ] **Step 3: Run until all four tests pass on Helm**

Run: `pnpm test:helm`
Expected: existing DEP-006/DEP-017 tests plus the four owned tests pass; `project/evidence/helm-kubernetes.json` has `success: true`.

- [ ] **Step 4: Run the home-runner variant once**

The home runner already runs `test:helm` in the full gate; dispatch `gh workflow run ci.yml --ref <branch> -f tier=full -f runner=home` after pushing the branch and confirm the Helm stage passes there (kind-in-Kubernetes networking differs from Docker Desktop).

- [ ] **Step 5: Commit**

```bash
git add tests/support/private-team/helm-runtime.ts tests/support/helm-cluster.ts tests/release/helm-chart.test.ts tests/configs/vitest.helm.config.ts scripts/run-helm-integration.sh project/evidence/helm-kubernetes.json
git commit -m "Prove private-team access and deactivation on two Helm replicas"
```

---

### Task 7: Ledger evidence and handoff

**Files:**
- Modify: `project/spec/conformance.yml` (AUTH-025, AUTH-027 rows; `updated:`)

- [ ] **Step 1: Attach evidence**

For each of AUTH-025 and AUTH-027, replace `evidence: []` with passing records, using the `recorded_at` from each report's `startTime` and a `run` path:
```yaml
    evidence:
      - {deployment: single_server, tests: [AUTH-025-B, AUTH-025-F], result: pass, run: project/evidence/compact-compose.json, recorded_at: "<ISO>"}
      - {deployment: single_server, tests: [AUTH-025-B, AUTH-025-F], result: pass, run: project/evidence/external-storage-compose.json, recorded_at: "<ISO>"}
      - {deployment: kubernetes, tests: [AUTH-025-B, AUTH-025-F], result: pass, run: project/evidence/helm-kubernetes.json, recorded_at: "<ISO>"}
```
AUTH-027 gets the external-storage Compose and Helm records only. Set both statuses to `verified` only if `ruby scripts/validate-conformance.rb` accepts it (every listed deployment has passing B and F); otherwise `behavior_verified`. Rewrite each `proof_gap` to state exactly what remains (for example the WorkOS-configured packaged startup, which this plan does not prove) or delete it when nothing does.

- [ ] **Step 2: Validate**

Run: `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ruby scripts/validate-conformance.rb --report && ruby scripts/check-conformance-test-ids.rb`
Expected: valid ledger; `single_server` and `kubernetes` coverage counts each rise.

- [ ] **Step 3: Full gate**

Run (Node 24.15 first on PATH): `pnpm verify:iteration`
Expected: exit 0. If only `tests/cli/lifecycle-cli.test.ts` times out, rerun from the failed stage (known load flake) and restore `project/evidence/local-foundation.json` from git first.

- [ ] **Step 4: Commit**

```bash
git add project/spec/conformance.yml project/evidence
git commit -m "Record packaged private-team evidence for AUTH-025 and AUTH-027"
```
