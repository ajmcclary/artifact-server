# Running the full gate on the home runner

The full `pnpm verify:iteration` gate can run on the owner's home Kubernetes node
instead of a laptop or a GitHub-hosted runner:

```sh
gh workflow run ci.yml -f tier=full -f runner=home --ref main
```

The home runner is GitHub's Actions Runner Controller (ARC 0.15.0), deployed from
the Workspace repository: the recipe `deployments/clusters/home-ci`, the Argo apps
`ci-home`, `arc-controller` and `arc-runners` (project `ci-runners`), and the
descriptor `deployments/environments/home-ci.yaml`. Its runner scale set,
`artifact-server-home`, keeps no idle runner and starts at most one, so a second
dispatch waits in GitHub's queue. Each run gets a fresh pod with its own Docker
daemon, and logs and the `full-gate-evidence-*` artifact appear in GitHub as usual.
`.github/workflows/home-runner-smoke.yml` proves the runner's Docker, kind and
toolchain without running the whole gate.

## Limits and residual risk

- Only a manual dispatch from `main` with `runner=home` uses it. Pull requests never
  do. Because the repository is public, a fork pull request controls its own
  workflow file and could name the runner's label, so the repository requires
  approval for every outside contributor's workflow run
  (`all_external_contributors`). Keep that setting:
  `gh api repos/ajmcclary/artifact-server/actions/permissions/fork-pr-contributor-approval`.
- The Docker sidecar is privileged, which is equivalent to root on the node. The
  runner mounts no service-account token, but flannel does not enforce
  NetworkPolicy, so a job can reach in-cluster services by address.
- Performance stages are comparable only between runs on this node made while
  Music Intelligence training is idle. Check `kubectl top node` before and after.

## Credential

The GitHub App `ajmcclary-home-ci-runner` (Administration read and write, Metadata
read, installed on this repository only) authenticates the runner scale set. Its
ID and private key were saved by the app-manifest flow to
`~/.config/artifact-server/github-app/` on the owner's Mac (`0600`). The cluster
holds them in the Secret `arc-runners/arc-github-app`, created once by hand,
because Vault on the home cluster runs in dev mode and loses everything on restart.
To re-create it, with no value printed:

```sh
dir=~/.config/artifact-server/github-app
kubectl --context kubernetes-admin@kubernetes -n arc-runners create secret generic arc-github-app \
  --from-literal=github_app_id="$(python3 -c "import json;print(json.load(open('$dir/app.json'))['id'])")" \
  --from-literal=github_app_installation_id='<installation id>' \
  --from-file=github_app_private_key="$dir/ajmcclary-home-ci-runner.private-key.pem"
```

Move it to Vault once Vault is persistent.
