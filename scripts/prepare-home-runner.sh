#!/usr/bin/env bash
# Install what the full gate takes from a GitHub-hosted runner but the minimal
# actions-runner image on the home Kubernetes runner lacks (docs/ci-home-runner.md).
# Every download is pinned and checksum-verified.
set -euo pipefail

readonly artifactserver_compose_version="v5.6.0"
readonly artifactserver_compose_sha256="40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a"

# Libraries GitHub-hosted runners carry and the image lacks: pnpm's standalone
# installer links libatomic, and setup-ruby's prebuilt Ruby links libyaml.
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends libatomic1 libyaml-0-2 libnss-myhostname

# Resolve *.localhost to loopback the way GitHub's Ubuntu runners do. Browsers
# do this themselves; Node's resolver (Playwright's request client, the CLI)
# relies on nss-myhostname.
if ! grep -qE '^hosts:.*\bmyhostname\b' /etc/nsswitch.conf; then
  sudo sed -i -E 's/^(hosts:.*)$/\1 myhostname/' /etc/nsswitch.conf
fi
getent hosts home-runner-check.localhost

# setup-ruby's prebuilt Rubies only run from the hosted runners' tool cache path.
sudo install -d -o "$(id -u)" -g "$(id -g)" /opt/hostedtoolcache

if ! docker compose version >/dev/null 2>&1; then
  artifactserver_plugins="${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins"
  mkdir -p "$artifactserver_plugins"
  artifactserver_download=$(mktemp)
  trap 'rm -f "$artifactserver_download"' EXIT
  curl -fsSL --retry 3 -o "$artifactserver_download" \
    "https://github.com/docker/compose/releases/download/${artifactserver_compose_version}/docker-compose-linux-x86_64"
  echo "${artifactserver_compose_sha256}  ${artifactserver_download}" | sha256sum --check --quiet
  install -m 0755 "$artifactserver_download" "$artifactserver_plugins/docker-compose"
fi
docker compose version
