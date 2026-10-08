# Home-Cluster CI Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Artifact Server's full `pnpm verify:iteration` gate on an ephemeral, owner-dispatched GitHub Actions runner on the home Kubernetes node instead of the owner's laptop.

**Architecture:** GitHub's Actions Runner Controller (ARC, Helm charts 0.15.0) runs on the home node. It is deployed through the existing Workspace GitOps flow: Workspace `master` → Argo CD app-of-apps. One runner scale set, `artifact-server-home`, is registered to `ajmcclary/artifact-server` only. It keeps zero runners idle and starts at most one. Each runner is an ephemeral pod with a privileged Docker-in-Docker sidecar, because the gate needs Docker for MinIO, Postgres, Compose, Keycloak, kind and BuildKit. `ci.yml` gains a `runner` input, so a manual full-tier dispatch can choose `github` (the default) or `home`.

**Tech Stack:** ARC `gha-runner-scale-set-controller` / `gha-runner-scale-set` 0.15.0 (OCI charts at `ghcr.io/actions/actions-runner-controller-charts`), runner image `ghcr.io/actions/actions-runner:2.338.0`, `docker:29.8.2-dind`, Argo CD 3.4.4, Vault + Vault Secrets Operator, kustomize, conftest/OPA, GitHub Actions.

**Spec:** The owner chose option 2 on 2026-10-08. Its requirements are listed below, and this plan is the reviewed design. Related open work: ROADMAP T01 ("no controlled CI runner").

### Requirements (agreed 2026-10-08)

- R1. The gate runs on the home node (`ubuntu-node`, 32 cores, about 94 GiB RAM, about 3.2 TiB free, amd64 Ubuntu 24.04, kubeadm 1.35.6, containerd, flannel).
- R2. Everything is installed through Workspace GitOps, never with `kubectl apply` or `helm install` by hand, except the documented one-time bootstrap secrets.
- R3. Runners live in their own namespace and are single-use. No runner is idle (`minRunners: 0`), and at most one runs at a time (`maxRunners: 1`), so performance baselines own the node.
- R4. The GitHub credential is a GitHub App. Its values live in Vault and are synced into the cluster by the Vault Secrets Operator. Nothing secret is committed.
- R5. Only manually dispatched full-tier runs from `main` use the home runner. Pull requests, including pull requests from forks, never run on it.
- R6. Runner pods get CPU and memory requests and a memory limit. The runner pod mounts no service-account token, and only the Docker sidecar is privileged.
- R7. Logs and evidence stay in GitHub, as the existing full-gate artifact upload already provides.

## Global Constraints

- Charts: `gha-runner-scale-set-controller` and `gha-runner-scale-set` at exactly `0.15.0`, both from the OCI repository `ghcr.io/actions/actions-runner-controller-charts`.
- Images are pinned by digest. Runner: `ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807`. Docker: `docker:29.8.2-dind@sha256:1e08cdb63405ca788aea94ef35b792d1e299607c667d33d7bcbcae1fd2611ced`. Confirm both digests with `docker buildx imagetools inspect <tag>` before use, and replace them if a tag's digest differs.
- Scale set name and `runs-on` label: `artifact-server-home`. Namespaces: `arc-systems` for the controller and listener, `arc-runners` for the runner pods.
- `githubConfigUrl` is exactly `https://github.com/ajmcclary/artifact-server`.
- Vault: mount `kv`, path `ci/arc/github-app`, keys `github_app_id`, `github_app_installation_id` and `github_app_private_key`. Vault role and policy are named `arc-runners`. The Kubernetes Secret is named `arc-github-app`.
- Workspace conventions are binding (`deployments/CLAUDE.md`): git push is the deploy, every container sets requests plus a memory limit, there's no `:latest`, Secrets are never rendered from git, and `tools/validate.sh` must pass before any push.
- The repo's fork-PR approval policy must be `all_external_contributors` before the runner scale set exists. A public repo's fork pull request can target a self-hosted label, and the workflow file cannot prevent that.
- Never probe `security` or the Keychain on the owner's Mac. This plan needs neither.

## Review Focus

1. **A fork pull request whose workflow says `runs-on: artifact-server-home`.** It must wait for the owner's approval and never start a pod. Task 1 sets the policy and verifies it through the API, and Task 6 re-verifies it before the first job.
2. **Two dispatches at once.** The second waits in GitHub's queue rather than starting a second runner (`maxRunners: 1`). Task 3's policy pins `maxRunners <= 1`.
3. **A gate run while Music Intelligence training saturates the node.** Correctness results stay valid, but performance numbers don't. Task 7 records the node's load before and after, and the doc tells operators not to compare performance runs made during training.
4. **The Docker sidecar running out of memory, or overlay-on-overlay storage failures.** `/var/lib/docker` must be an `emptyDir`, not the container's own filesystem. Task 3's policy requires that mount, and Task 6's smoke job runs kind, which fails fast if nested storage is wrong.
5. **Runner pods reaching in-cluster services.** Flannel doesn't enforce NetworkPolicy, so this plan claims only "no service-account token" (enforced by Task 3's policy) and records the unfenced network as residual risk in the docs.

---

## File Structure

**Workspace** (`~/Workspace`, branch `master`):
- `deployments/policy/arc.rego` (new): conftest rules for the rendered runner scale set.
- `tools/charts/gha-runner-scale-set-0.15.0.tgz` (new, vendored): an offline chart, so `validate.sh` stays offline.
- `tools/validate.sh` (modify): adds the `arc` check, which renders the vendored chart with the committed values and runs `arc.rego`.
- `deployments/clusters/home-ci/kustomization.yaml`, `namespaces.yaml`, `dind-daemon-config.yaml`, `vault.yaml` (new): the in-cluster substrate for the runners.
- `deployments/clusters/home-ci/arc-runners-values.yaml` (new): Helm values for the scale set. It isn't a kustomize resource.
- `deployments/argocd/project-ci-runners.yaml`, `application-ci-home.yaml`, `application-arc-controller.yaml`, `application-arc-runners.yaml` (new): the Argo objects.
- `deployments/argocd/bootstrap.sh` (modify): applies the non-credential OCI chart repository entry once.
- `deployments/environments/home.yaml` (modify): adds the namespaces, substrate and drift entries.

**Artifact Server** (`~/artifact-server`, branch `main`):
- `.github/workflows/ci.yml` (modify): adds the `runner` input, the home `runs-on`, and steps guarded by runner.
- `.github/workflows/home-runner-smoke.yml` (new): a dispatch-only proof of the runner's Docker, kind and toolchain.
- `docs/ci-home-runner.md` (new): how to dispatch, the limits, and the residual risk.
- `ROADMAP.md` (modify): T01 and the gate note.

---

### Task 1: Owner prerequisites and repository hardening

**Files:** none. These are owner actions plus one API change, which the agent makes only after the owner confirms.

**Interfaces:**
- Produces: the Vault secret at `kv/ci/arc/github-app` with the three keys, the Vault role `arc-runners`, and the fork-PR approval policy `all_external_contributors`.

- [ ] **Step 1: Verify the current fork-PR approval policy**

Run: `gh api repos/ajmcclary/artifact-server/actions/permissions/fork-pr-contributor-approval`
Expected today: `{"approval_policy":"first_time_contributors"}`

- [ ] **Step 2: With the owner's confirmation, require approval for all outside contributors**

```bash
gh api -X PUT repos/ajmcclary/artifact-server/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors
gh api repos/ajmcclary/artifact-server/actions/permissions/fork-pr-contributor-approval
```
Expected: `{"approval_policy":"all_external_contributors"}`

- [ ] **Step 3: Owner creates the GitHub App (in a browser, owner only)**

Under GitHub → Settings → Developer settings → GitHub Apps → New:
- Name: `artifact-server-home-runner`. Turn the webhook off.
- Repository permissions: **Administration: Read and write** (needed to register runners on a repository) and **Metadata: Read-only**. No other permissions.
- Install it on `ajmcclary/artifact-server` only.
- Note the App ID and the Installation ID (from the installation URL), and generate a private key `.pem`.

- [ ] **Step 4: Owner writes the credential to Vault and creates the role (one-time, imperative)**

The values never pass through the agent:
```bash
vault policy write arc-runners - <<'EOF'
path "kv/data/ci/arc/*" { capabilities = ["read"] }
EOF
vault write auth/kubernetes/role/arc-runners \
  bound_service_account_names=default \
  bound_service_account_namespaces=arc-runners \
  policies=arc-runners ttl=10m
vault kv put kv/ci/arc/github-app \
  github_app_id='<APP_ID>' \
  github_app_installation_id='<INSTALLATION_ID>' \
  github_app_private_key=@/path/to/artifact-server-home-runner.private-key.pem
```
Verify without printing values: `vault kv metadata get kv/ci/arc/github-app` shows version 1.

---

### Task 2: Policy for the runner scale set (written to fail first)

**Files:**
- Create: `~/Workspace/deployments/policy/arc.rego`
- Create: `~/Workspace/tools/charts/gha-runner-scale-set-0.15.0.tgz`
- Modify: `~/Workspace/tools/validate.sh`

**Interfaces:**
- Produces: `tools/validate.sh arc`, which renders `tools/charts/gha-runner-scale-set-0.15.0.tgz` with `deployments/clusters/home-ci/arc-runners-values.yaml` and runs conftest with `--namespace arc`.

- [ ] **Step 1: Vendor the chart**

```bash
cd ~/Workspace && mkdir -p tools/charts
helm pull oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set --version 0.15.0 -d tools/charts
ls tools/charts   # gha-runner-scale-set-0.15.0.tgz
```

- [ ] **Step 2: Write the policy**

```rego
# Invariants for the ARC runner scale set (rendered by tools/validate.sh arc).
package arc

import rego.v1

runner_set := input if input.kind == "AutoscalingRunnerSet"

pod := runner_set.spec.template.spec

containers contains c if some c in pod.containers

containers contains c if some c in object.get(pod, "initContainers", [])

deny contains msg if {
	runner_set
	runner_set.spec.githubConfigUrl != "https://github.com/ajmcclary/artifact-server"
	msg := sprintf("runner set must register to ajmcclary/artifact-server only, not %q", [runner_set.spec.githubConfigUrl])
}

deny contains msg if {
	runner_set
	object.get(runner_set.spec, "maxRunners", 1000) > 1
	msg := "runner set must run at most one runner (maxRunners <= 1)"
}

deny contains msg if {
	runner_set
	object.get(runner_set.spec, "minRunners", 0) != 0
	msg := "runner set must keep no idle runners (minRunners: 0)"
}

deny contains msg if {
	runner_set
	object.get(pod, "automountServiceAccountToken", true) != false
	msg := "runner pods must not mount a service-account token"
}

deny contains msg if {
	some c in containers
	not contains(c.image, "@sha256:")
	msg := sprintf("container %q image must be pinned by digest (%s)", [c.name, c.image])
}

deny contains msg if {
	some c in containers
	not c.resources.requests.cpu
	msg := sprintf("container %q must request cpu", [c.name])
}

deny contains msg if {
	some c in containers
	not c.resources.requests.memory
	msg := sprintf("container %q must request memory", [c.name])
}

deny contains msg if {
	some c in containers
	not c.resources.limits.memory
	msg := sprintf("container %q must limit memory", [c.name])
}

deny contains msg if {
	some c in containers
	c.name != "dind"
	object.get(object.get(c, "securityContext", {}), "privileged", false)
	msg := sprintf("only the dind container may be privileged, not %q", [c.name])
}

deny contains msg if {
	some c in containers
	c.name == "dind"
	not docker_root_is_empty_dir(c)
	msg := "dind must keep /var/lib/docker on an emptyDir volume"
}

docker_root_is_empty_dir(c) if {
	some m in c.volumeMounts
	m.mountPath == "/var/lib/docker"
	some v in pod.volumes
	v.name == m.name
	v.emptyDir
}
```

- [ ] **Step 3: Add the `arc` check to `tools/validate.sh`**

Add the function after `check_policy`, add an `arc)` case, include it in the default "run every check" list next to `check_policy`, and add `arc` to the usage line:
```bash
check_arc() {
    echo "== conftest (ARC runner scale set)"
    local ct; ct="$(tool conftest)"
    local values="deployments/clusters/home-ci/arc-runners-values.yaml"
    run "arc runner scale set" bash -c \
        "helm template artifact-server-home tools/charts/gha-runner-scale-set-0.15.0.tgz \
           --namespace arc-runners -f '$values' \
         | $ct test --policy deployments/policy/arc.rego --namespace arc -"
}
```

- [ ] **Step 4: Prove the policy rejects the chart's defaults**

```bash
cd ~/Workspace && mkdir -p deployments/clusters/home-ci
cat > deployments/clusters/home-ci/arc-runners-values.yaml <<'EOF'
githubConfigUrl: https://github.com/ajmcclary/artifact-server
githubConfigSecret: arc-github-app
containerMode:
  type: dind
EOF
tools/validate.sh arc
```
Expected: FAIL, with denials for the digest pin (`actions-runner:latest`, `docker:dind`), the missing cpu/memory requests and memory limits, `automountServiceAccountToken`, the `/var/lib/docker` emptyDir, and `maxRunners`. Do not commit yet; Task 3 replaces this file.

---

### Task 3: Runner scale-set values that satisfy the policy

**Files:**
- Modify: `~/Workspace/deployments/clusters/home-ci/arc-runners-values.yaml`

**Interfaces:**
- Consumes: `tools/validate.sh arc` and `deployments/policy/arc.rego` from Task 2.
- Produces: the scale set `artifact-server-home` in `arc-runners`. It mounts the ConfigMap `dind-daemon-config` (key `daemon.json`) from Task 4, and expects the controller's service account `arc-gha-rs-controller` in `arc-systems` (Task 5).

- [ ] **Step 1: Write the values**

`containerMode` is left out on purpose, so the template below is the whole pod (the chart says to customize dind this way):
```yaml
# ARC runner scale set for Artifact Server's full gate on the home node.
# Rendered by Argo (application-arc-runners.yaml) and by tools/validate.sh arc.
githubConfigUrl: https://github.com/ajmcclary/artifact-server
githubConfigSecret: arc-github-app
runnerScaleSetName: artifact-server-home
minRunners: 0
maxRunners: 1
controllerServiceAccount:
  namespace: arc-systems
  name: arc-gha-rs-controller
template:
  spec:
    restartPolicy: Never
    automountServiceAccountToken: false
    initContainers:
      - name: init-dind-externals
        image: ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807
        command: ["cp"]
        args: ["-r", "/home/runner/externals/.", "/home/runner/tmpDir/"]
        resources:
          requests: {cpu: 100m, memory: 128Mi}
          limits: {memory: 256Mi}
        volumeMounts:
          - {name: dind-externals, mountPath: /home/runner/tmpDir}
      - name: dind
        image: docker:29.8.2-dind@sha256:1e08cdb63405ca788aea94ef35b792d1e299607c667d33d7bcbcae1fd2611ced
        args: ["dockerd", "--host=unix:///var/run/docker.sock", "--group=$(DOCKER_GROUP_GID)"]
        env:
          - {name: DOCKER_GROUP_GID, value: "123"}
        securityContext:
          privileged: true
        restartPolicy: Always
        startupProbe:
          exec: {command: ["docker", "info"]}
          failureThreshold: 24
          periodSeconds: 5
        resources:
          requests: {cpu: "8", memory: 16Gi}
          limits: {memory: 32Gi}
        volumeMounts:
          - {name: work, mountPath: /home/runner/_work}
          - {name: dind-sock, mountPath: /var/run}
          - {name: dind-externals, mountPath: /home/runner/externals}
          - {name: docker-root, mountPath: /var/lib/docker}
          - {name: dind-daemon-config, mountPath: /etc/docker/daemon.json, subPath: daemon.json, readOnly: true}
    containers:
      - name: runner
        image: ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807
        command: ["/home/runner/run.sh"]
        env:
          - {name: DOCKER_HOST, value: unix:///var/run/docker.sock}
          - {name: RUNNER_WAIT_FOR_DOCKER_IN_SECONDS, value: "120"}
        resources:
          requests: {cpu: "8", memory: 16Gi}
          limits: {memory: 32Gi}
        volumeMounts:
          - {name: work, mountPath: /home/runner/_work}
          - {name: dind-sock, mountPath: /var/run}
    volumes:
      - {name: dind-sock, emptyDir: {}}
      - {name: dind-externals, emptyDir: {}}
      - {name: work, emptyDir: {}}
      - {name: docker-root, emptyDir: {}}
      - name: dind-daemon-config
        configMap: {name: dind-daemon-config}
```

- [ ] **Step 2: Confirm the digests before relying on them**

```bash
docker buildx imagetools inspect ghcr.io/actions/actions-runner:2.338.0 | awk '/^Digest:/{print $2}'
docker buildx imagetools inspect docker:29.8.2-dind | awk '/^Digest:/{print $2}'
```
Expected: the two digests in Global Constraints. If one differs, use the printed digest everywhere it appears.

- [ ] **Step 3: Run the policy**

Run: `cd ~/Workspace && tools/validate.sh arc`
Expected: `[OK] arc runner scale set`

- [ ] **Step 4: Commit (no push yet)**

```bash
cd ~/Workspace && git add deployments/policy/arc.rego tools/charts tools/validate.sh deployments/clusters/home-ci/arc-runners-values.yaml
git commit -m "Add ARC runner scale-set values and their policy for the home CI runner"
```

---

### Task 4: In-cluster substrate (namespaces, dind config, Vault sync)

**Files:**
- Create: `~/Workspace/deployments/clusters/home-ci/kustomization.yaml`, `namespaces.yaml`, `dind-daemon-config.yaml`, `vault.yaml`
- Modify: `~/Workspace/deployments/environments/home.yaml`

**Interfaces:**
- Consumes: the Vault role `arc-runners` and the secret `kv/ci/arc/github-app` (Task 1).
- Produces: the namespaces `arc-systems` and `arc-runners`, the ConfigMap `arc-runners/dind-daemon-config`, and the Secret `arc-runners/arc-github-app` (written by VSO).

- [ ] **Step 1: Write the recipe**

`kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
# Substrate for Artifact Server's home CI runner (ARC). The controller and the
# runner scale set are Helm charts deployed by their own Argo Applications.
# arc-runners-values.yaml beside this file is their values, not a resource.
resources:
  - namespaces.yaml
  - dind-daemon-config.yaml
  - vault.yaml
```
`namespaces.yaml`:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: arc-systems
---
apiVersion: v1
kind: Namespace
metadata:
  name: arc-runners
```
`dind-daemon-config.yaml` (the CI's containerd image store, set at daemon start instead of with `systemctl restart`):
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dind-daemon-config
  namespace: arc-runners
data:
  daemon.json: |
    {"features": {"containerd-snapshotter": true}}
```
`vault.yaml`:
```yaml
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultConnection
metadata:
  name: vault-conn
  namespace: arc-runners
spec:
  address: http://vault.vault.svc:8200
  skipTLSVerify: false
---
# Role arc-runners is bound to the default ServiceAccount in arc-runners only,
# read-only on kv/ci/arc/* (created imperatively; see the home-ci runbook in
# docs/ci-home-runner.md of artifact-server).
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultAuth
metadata:
  name: vault-auth
  namespace: arc-runners
spec:
  vaultConnectionRef: vault-conn
  method: kubernetes
  mount: kubernetes
  kubernetes:
    role: arc-runners
    serviceAccount: default
    tokenExpirationSeconds: 600
---
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultStaticSecret
metadata:
  name: arc-github-app
  namespace: arc-runners
spec:
  vaultAuthRef: vault-auth
  mount: kv
  type: kv-v2
  path: ci/arc/github-app
  refreshAfter: 60s
  destination:
    name: arc-github-app
    create: true
    overwrite: true
    transformation:
      excludeRaw: true
```

- [ ] **Step 2: Update the home descriptor**

In `deployments/environments/home.yaml`:
- Add `arc-systems` and `arc-runners` under `namespaces:`.
- Add a `substrate:` entry: `what: Vault role arc-runners + kv/ci/arc/github-app`, `owner: owner, imperative (docs/ci-home-runner.md in artifact-server)`.
- Add a `drift:` entry: `what: Argo OCI chart repository entry for ghcr.io/actions/actions-runner-controller-charts`, `why: the bootstrap project may only manage Argo objects`, `remedy: applied once by deployments/argocd/bootstrap.sh`.

- [ ] **Step 3: Validate everything**

Run: `cd ~/Workspace && tools/validate.sh`
Expected: every check `[OK]`, including `kubeconform home-ci`, `conftest home-ci`, `check-descriptors` and `arc runner scale set`. If `check-descriptors` reports a format the edit didn't match, follow its message and rerun.

- [ ] **Step 4: Commit (no push yet)**

```bash
git add deployments/clusters/home-ci deployments/environments/home.yaml
git commit -m "Add the home CI runner substrate: namespaces, dind config and Vault sync"
```

---

### Task 5: Argo project, chart repository and applications

**Files:**
- Create: `~/Workspace/deployments/argocd/project-ci-runners.yaml`, `application-ci-home.yaml`, `application-arc-controller.yaml`, `application-arc-runners.yaml`
- Modify: `~/Workspace/deployments/argocd/bootstrap.sh`

**Interfaces:**
- Consumes: the recipe `deployments/clusters/home-ci` and `arc-runners-values.yaml` (Tasks 3 and 4).
- Produces: the Applications `ci-home` (sync wave 0), `arc-controller` (wave 1) and `arc-runners` (wave 2) in project `ci-runners`. The controller's service account must be `arc-gha-rs-controller` in `arc-systems`.

- [ ] **Step 1: Check the controller chart's value keys before writing**

```bash
helm show values oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller --version 0.15.0 \
  | grep -nE "^flags:|watchSingleNamespace|^resources:|^serviceAccount:|^  name:"
```
Expected: `flags.watchSingleNamespace`, `resources` and `serviceAccount.name` exist. If a key's name differs, use the printed name in Step 3.

- [ ] **Step 2: Write the project**

```yaml
# Scope for Artifact Server's home CI runner: ARC's controller (cluster-scoped
# CRDs and RBAC) and its runner namespaces on the home cluster only.
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: ci-runners
  namespace: argocd
spec:
  description: Artifact Server home CI runner (ARC)
  sourceRepos:
    - git@github.com:ajmcclary/Workspace.git
    - ghcr.io/actions/actions-runner-controller-charts
  destinations:
    - server: https://kubernetes.default.svc
      namespace: arc-systems
    - server: https://kubernetes.default.svc
      namespace: arc-runners
  clusterResourceWhitelist:
    - {group: "", kind: Namespace}
    - {group: apiextensions.k8s.io, kind: CustomResourceDefinition}
    - {group: rbac.authorization.k8s.io, kind: ClusterRole}
    - {group: rbac.authorization.k8s.io, kind: ClusterRoleBinding}
```

- [ ] **Step 3: Write the three applications**

`application-ci-home.yaml`:
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ci-home
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  project: ci-runners
  source:
    repoURL: git@github.com:ajmcclary/Workspace.git
    targetRevision: master
    path: deployments/clusters/home-ci
  destination:
    server: https://kubernetes.default.svc
    namespace: arc-runners
  syncPolicy:
    automated: {prune: true, selfHeal: true}
```
`application-arc-controller.yaml`:
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: arc-controller
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  project: ci-runners
  source:
    repoURL: ghcr.io/actions/actions-runner-controller-charts
    chart: gha-runner-scale-set-controller
    targetRevision: 0.15.0
    helm:
      releaseName: arc
      valuesObject:
        serviceAccount:
          name: arc-gha-rs-controller
        flags:
          watchSingleNamespace: arc-runners
        resources:
          requests: {cpu: 100m, memory: 128Mi}
          limits: {memory: 512Mi}
  destination:
    server: https://kubernetes.default.svc
    namespace: arc-systems
  syncPolicy:
    automated: {prune: true, selfHeal: true}
    syncOptions:
      - ServerSideApply=true
```
`application-arc-runners.yaml` (the chart, plus values from Workspace git):
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: arc-runners
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  project: ci-runners
  sources:
    - repoURL: ghcr.io/actions/actions-runner-controller-charts
      chart: gha-runner-scale-set
      targetRevision: 0.15.0
      helm:
        releaseName: artifact-server-home
        valueFiles:
          - $values/deployments/clusters/home-ci/arc-runners-values.yaml
    - repoURL: git@github.com:ajmcclary/Workspace.git
      targetRevision: master
      ref: values
  destination:
    server: https://kubernetes.default.svc
    namespace: arc-runners
  syncPolicy:
    automated: {prune: true, selfHeal: true}
    syncOptions:
      - ServerSideApply=true
```

- [ ] **Step 4: Register the OCI chart repository once (it holds no credentials)**

The root app's project may manage only Argo objects, so `bootstrap.sh` applies this entry, the same way it applies the existing repo secret. Append to `bootstrap.sh`:
```bash
# ARC charts (public OCI Helm repository; no credentials) for the home CI runner.
kubectl --context kubernetes-admin@kubernetes -n argocd apply -f - <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: repo-arc-charts
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  name: arc-charts
  type: helm
  url: ghcr.io/actions/actions-runner-controller-charts
  enableOCI: "true"
EOF
```
Then run only that block, with the owner's go-ahead, and verify: `kubectl --context kubernetes-admin@kubernetes -n argocd get secret repo-arc-charts`.

- [ ] **Step 5: Validate, commit and push (push is the deploy; do it only after Task 1 is complete)**

```bash
cd ~/Workspace && tools/validate.sh
git add deployments/argocd/project-ci-runners.yaml deployments/argocd/application-ci-home.yaml \
        deployments/argocd/application-arc-controller.yaml deployments/argocd/application-arc-runners.yaml \
        deployments/argocd/bootstrap.sh
git commit -m "Deploy ARC for Artifact Server's home CI runner"
git push origin master
```

- [ ] **Step 6: Verify the deploy**

```bash
K="kubectl --context kubernetes-admin@kubernetes"
$K -n argocd annotate application music-intelligence-root argocd.argoproj.io/refresh=normal --overwrite
for app in ci-home arc-controller arc-runners; do
  $K -n argocd get application $app -o jsonpath='{.metadata.name} {.status.sync.status} {.status.health.status}{"\n"}'
done
$K -n arc-runners get secret arc-github-app -o jsonpath='{.data}' | python3 -c "import json,sys;print(sorted(json.load(sys.stdin)))"
$K -n arc-systems get pods
```
Expected: all three applications `Synced Healthy`. The secret's keys are exactly `['github_app_id', 'github_app_installation_id', 'github_app_private_key']`, and no values are printed. A controller pod and an `artifact-server-home-…-listener` pod are `Running`. The listener log shows it is listening for jobs: `$K -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener --tail=20`.

---

### Task 6: Smoke workflow on the home runner

**Files:**
- Create: `~/artifact-server/.github/workflows/home-runner-smoke.yml`

**Interfaces:**
- Consumes: the runner label `artifact-server-home` (Task 5).
- Produces: proof that the runner's Docker uses the containerd image store, that kind can create a cluster inside Docker-in-Docker, and that Playwright's system dependencies install. Task 7 relies on all three.

- [ ] **Step 1: Re-verify the fork-PR guard**

Run: `gh api repos/ajmcclary/artifact-server/actions/permissions/fork-pr-contributor-approval`
Expected: `{"approval_policy":"all_external_contributors"}`. If it isn't, stop.

- [ ] **Step 2: Write the smoke workflow**

```yaml
name: Home runner smoke

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  smoke:
    if: github.ref == 'refs/heads/main'
    runs-on: artifact-server-home
    timeout-minutes: 20
    steps:
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Docker uses the containerd image store
        run: docker info --format '{{json .DriverStatus}}' | grep -F 'io.containerd.snapshotter.v1'
      - name: No service-account token is mounted
        run: test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token
      - name: kind creates and deletes a cluster inside Docker-in-Docker
        run: |
          curl -fsSLo kind https://kind.sigs.k8s.io/dl/v0.31.0/kind-linux-amd64
          chmod +x kind
          ./kind create cluster --name smoke --wait 120s
          ./kind delete cluster --name smoke
      - name: Install pnpm
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
        with:
          version: 10.34.3
      - name: Install Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24.15.0
      - name: Playwright system dependencies install
        run: |
          pnpm install --frozen-lockfile
          pnpm exec playwright install --with-deps chromium
```
Before relying on it, check the kind version: `curl -s https://api.github.com/repos/kubernetes-sigs/kind/releases/latest | python3 -c "import json,sys;print(json.load(sys.stdin)['tag_name'])"`, and use that tag in the URL.

- [ ] **Step 3: Commit, push and dispatch**

```bash
cd ~/artifact-server && git add .github/workflows/home-runner-smoke.yml
git commit -m "Add a smoke workflow for the home CI runner"
git push origin main
gh workflow run home-runner-smoke.yml --ref main
gh run watch "$(gh run list --workflow home-runner-smoke.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```
Expected: every step passes. While it runs, `kubectl --context kubernetes-admin@kubernetes -n arc-runners get pods` shows exactly one runner pod, which disappears after the job. If the containerd step fails, check that `/etc/docker/daemon.json` is mounted in the `dind` container. If kind fails, its log names the nested-storage or cgroup error. Fix it in the values (Task 3) and rerun `tools/validate.sh arc` before pushing.

---

### Task 7: Let `ci.yml`'s full gate choose the home runner

**Files:**
- Modify: `~/artifact-server/.github/workflows/ci.yml`
- Create: `~/artifact-server/docs/ci-home-runner.md`
- Modify: `~/artifact-server/ROADMAP.md`

**Interfaces:**
- Consumes: the runner label `artifact-server-home` and the behaviour Task 6 proved.
- Produces: `gh workflow run ci.yml -f tier=full -f runner=home --ref main`.

- [ ] **Step 1: Add the input to both triggers**

Under `workflow_call.inputs`:
```yaml
      runner:
        description: Where the full gate runs (github or home)
        required: false
        default: github
        type: string
```
Under `workflow_dispatch.inputs`:
```yaml
      runner:
        description: Where the full gate runs
        required: true
        default: github
        type: choice
        options:
          - github
          - home
```

- [ ] **Step 2: Route only the owner-dispatched full gate**

In the `full` job, replace `runs-on: ubuntu-latest` with:
```yaml
    runs-on: ${{ (github.event_name == 'workflow_dispatch' && inputs.runner == 'home' && github.ref == 'refs/heads/main') && 'artifact-server-home' || 'ubuntu-latest' }}
```
Add `if: inputs.runner != 'home'` to the **Reclaim unused runner disk** step and to the **Enable the containerd image store** step; the home runner's daemon already starts with that store. Add this step right after the containerd step:
```yaml
      - name: Confirm the containerd image store on the home runner
        if: inputs.runner == 'home'
        run: docker info --format '{{json .DriverStatus}}' | grep -F 'io.containerd.snapshotter.v1'
```
Leave every other job's `runs-on` unchanged. Pull-request jobs stay on GitHub-hosted runners.

- [ ] **Step 3: Check the gate definition is intact**

Run: `cd ~/artifact-server && pnpm check:ci && pnpm lint`
Expected: `Verified 14 ordered full-gate commands against pnpm verify:iteration.` and no lint errors.

- [ ] **Step 4: Write `docs/ci-home-runner.md`**

```markdown
# Running the full gate on the home runner

The full `pnpm verify:iteration` gate can run on the home Kubernetes node
instead of a laptop or a GitHub-hosted runner:

    gh workflow run ci.yml -f tier=full -f runner=home --ref main

The home runner is GitHub's Actions Runner Controller, deployed from the
Workspace repository (`deployments/clusters/home-ci`, `deployments/argocd/*ci*`
and `*arc*`). It keeps no idle runner and starts at most one, so a second
dispatch waits in GitHub's queue. Each run gets a fresh pod and a fresh Docker
daemon; logs and the `full-gate-evidence-*` artifact appear in GitHub as usual.

Limits and residual risk:

- Only a manual dispatch of `ci.yml` from `main` with `runner=home` uses it.
  Pull requests never do. The repository requires approval for every outside
  contributor's workflow run (`all_external_contributors`), because a fork
  pull request controls its own workflow file and could otherwise target the
  runner's label. Keep that setting.
- The Docker sidecar is privileged, which is equivalent to root on the node.
  The runner mounts no service-account token, but flannel does not enforce
  NetworkPolicy, so a job can reach in-cluster services by address.
- Performance stages are comparable only between runs on this node made while
  Music Intelligence training is idle. Check `kubectl top node` first.

One-time setup (owner): the GitHub App `artifact-server-home-runner`
(Administration read/write, Metadata read, installed on this repository
only); `vault kv put kv/ci/arc/github-app github_app_id=… github_app_installation_id=… github_app_private_key=@key.pem`;
the Vault policy and role `arc-runners` bound to `arc-runners/default`; and the
Argo chart-repository entry applied by Workspace's `deployments/argocd/bootstrap.sh`.
```

- [ ] **Step 5: Commit and push, then run the first full gate at home**

```bash
cd ~/artifact-server && git add .github/workflows/ci.yml docs/ci-home-runner.md
git commit -m "Let the full CI gate run on the home runner"
git push origin main
kubectl --context kubernetes-admin@kubernetes top node
gh workflow run ci.yml -f tier=full -f runner=home --ref main
gh run watch "$(gh run list --workflow ci.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
kubectl --context kubernetes-admin@kubernetes top node
```
Expected: the `Full / Linux iteration gate` job passes on `artifact-server-home` within its 47-minute limit, and the `full-gate-evidence-*` artifact is uploaded. If a stage fails, read its log in GitHub. A failure that also happens on the GitHub-hosted run of the same commit is a product failure, not a runner failure.

- [ ] **Step 6: Record it on the roadmap**

In `ROADMAP.md`:
- Replace the "full gate was not rerun" paragraph with one line naming the home-runner run ID and its result.
- Under T01's gap, add: "The full gate now runs on the owner's home node (docs/ci-home-runner.md). Performance results from it are comparable across runs made while training is idle."

Then:
```bash
git add ROADMAP.md && git commit -m "Record the first full gate on the home runner" && git push origin main
```
