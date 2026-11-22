#!/usr/bin/env bash
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly artifactserver_repository
readonly artifactserver_chart="$artifactserver_repository/packaging/helm/artifact-server"
readonly artifactserver_digest="sha256:0000000000000000000000000000000000000000000000000000000000000000"

artifactserver_values=(
  --set "image.digest=$artifactserver_digest"
  --set "configuration.installationId=static-verification"
  --set "configuration.bootstrapAdministratorEmail=admin@example.test"
  --set "configuration.applicationOrigin=https://artifacts.example.test"
  --set "configuration.contentDomain=content.example.net"
  --set "configuration.s3.bucket=artifact-server-static-verification"
  --set "configuration.s3.region=us-east-1"
  --set "identity.oidcClientId=artifact-server"
  --set "identity.oidcIssuer=https://idp.example.test"
  --set "secret.name=artifact-server-runtime"
)

helm lint "$artifactserver_chart" --strict "${artifactserver_values[@]}"

for artifactserver_kubernetes_version in 1.34.0 1.35.0 1.36.0; do
  helm template artifact-server "$artifactserver_chart" \
    --kube-version "$artifactserver_kubernetes_version" \
    "${artifactserver_values[@]}" >/dev/null
done

helm template artifact-server "$artifactserver_chart" \
  --kube-version 1.36.0 \
  "${artifactserver_values[@]}" \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.applicationTlsSecretName=artifact-server-application-tls \
  --set ingress.contentTlsSecretName=artifact-server-content-tls >/dev/null

expect_render_failure() {
  local artifactserver_expected=$1
  shift
  local artifactserver_output
  if artifactserver_output=$(helm template artifact-server "$artifactserver_chart" \
    --kube-version 1.36.0 "$@" 2>&1); then
    echo "Expected Helm rendering to fail with: $artifactserver_expected" >&2
    exit 1
  fi
  if [[ "$artifactserver_output" != *"$artifactserver_expected"* ]]; then
    echo "Helm failed for an unexpected reason: $artifactserver_output" >&2
    exit 1
  fi
}

expect_render_failure "image.digest is required" \
  --set configuration.installationId=static-verification \
  --set configuration.bootstrapAdministratorEmail=admin@example.test \
  --set configuration.applicationOrigin=https://artifacts.example.test \
  --set configuration.contentDomain=content.example.net \
  --set configuration.s3.bucket=artifact-server-static-verification \
  --set configuration.s3.region=us-east-1 \
  --set identity.oidcClientId=artifact-server \
  --set identity.oidcIssuer=https://idp.example.test \
  --set secret.name=artifact-server-runtime

expect_render_failure "must be configured together" \
  "${artifactserver_values[@]}" \
  --set secret.keys.s3AccessKeyId=s3-access-key-id

expect_render_failure "identity.oidcClientId and identity.oidcIssuer must be configured together" \
  "${artifactserver_values[@]}" \
  --set identity.oidcIssuer=

expect_render_failure "identity.oidcScopes and secret.keys.oidcClientSecret require" \
  "${artifactserver_values[@]}" \
  --set identity.oidcClientId= \
  --set identity.oidcIssuer= \
  --set identity.oidcScopes="openid email profile"

expect_render_failure "one installation has one browser-login provider" \
  "${artifactserver_values[@]}" \
  --set identity.workosClientId=client_workos \
  --set identity.workosIssuer=https://auth.example.test \
  --set secret.keys.workosApiKey=workos-api-key

expect_render_failure "private-team deployments require exactly one browser-login provider" \
  "${artifactserver_values[@]}" \
  --set identity.oidcClientId= \
  --set identity.oidcIssuer=

expect_render_failure "terminationGracePeriodSeconds must be longer" \
  "${artifactserver_values[@]}" \
  --set terminationGracePeriodSeconds=5

expect_render_failure "postgresConnectionBudget must be at least 32" \
  "${artifactserver_values[@]}" \
  --set replicaCount=3

expect_render_failure "ingress.applicationTlsSecretName is required" \
  "${artifactserver_values[@]}" \
  --set ingress.enabled=true

expect_render_failure "application origin with no path or explicit port" \
  "${artifactserver_values[@]}" \
  --set configuration.applicationOrigin=https://artifacts.example.test:8443 \
  --set ingress.enabled=true \
  --set ingress.applicationTlsSecretName=artifact-server-application-tls \
  --set ingress.contentTlsSecretName=artifact-server-content-tls

expect_render_failure "podLabels cannot replace the chart-owned label" \
  "${artifactserver_values[@]}" \
  --set-string podLabels.app\\.kubernetes\\.io/component=other

# A private-CA identity provider is trusted only when the operator names a ConfigMap.
artifactserver_rendered=$(helm template artifact-server "$artifactserver_chart" \
  --kube-version 1.36.0 "${artifactserver_values[@]}")
if [[ "$artifactserver_rendered" == *NODE_EXTRA_CA_CERTS* ]]; then
  echo "The chart trusts an identity CA nobody configured." >&2
  exit 1
fi
artifactserver_rendered=$(helm template artifact-server "$artifactserver_chart" \
  --kube-version 1.36.0 "${artifactserver_values[@]}" \
  --set identity.trustedCertificateAuthorities.configMapName=identity-ca)
for artifactserver_expected_line in \
  'name: NODE_EXTRA_CA_CERTS' \
  'value: "/etc/artifact-server/identity-ca/ca.crt"' \
  'mountPath: /etc/artifact-server/identity-ca' \
  'name: "identity-ca"'; do
  if [[ "$artifactserver_rendered" != *"$artifactserver_expected_line"* ]]; then
    echo "The trusted identity CA rendering lacks: $artifactserver_expected_line" >&2
    exit 1
  fi
done

expect_render_failure "trustedCertificateAuthorities" \
  "${artifactserver_values[@]}" \
  --set identity.trustedCertificateAuthorities.configMapName=identity-ca \
  --set identity.trustedCertificateAuthorities.key=../escape

# Placement and the memory limit reach every pod the release runs: the
# serving Deployment, the pre-install migration Job, and the cleanup CronJob.
artifactserver_rendered=$(helm template artifact-server "$artifactserver_chart" \
  --kube-version 1.36.0 "${artifactserver_values[@]}" \
  --set nodeSelector.artifact-server/pool=dedicated \
  --set tolerations[0].key=artifact-server/dedicated \
  --set tolerations[0].operator=Exists \
  --set tolerations[0].effect=NoSchedule \
  --set affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=artifact-server/zone \
  --set affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=Exists)
for artifactserver_expected_count in \
  'artifact-server/pool: dedicated' \
  'key: artifact-server/dedicated' \
  'key: artifact-server/zone' \
  'memory: 1Gi'; do
  artifactserver_count=$(grep -cF -- "$artifactserver_expected_count" <<<"$artifactserver_rendered" || true)
  if [[ "$artifactserver_count" -ne 3 ]]; then
    echo "Expected '$artifactserver_expected_count' on the Deployment, migration Job, and cleanup CronJob; found $artifactserver_count." >&2
    exit 1
  fi
done

mkdir -p -- "$artifactserver_repository/release"
helm package "$artifactserver_chart" \
  --destination "$artifactserver_repository/release" >/dev/null
