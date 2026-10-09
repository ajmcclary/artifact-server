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
created_network=false

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
  if [[ "${created_network}" == true ]]; then
    docker network rm "${network}" >/dev/null 2>&1 || true
  fi
  rm -rf "${work_directory}"
}
trap cleanup EXIT INT TERM

if ! docker image inspect "${keycloak_image}" >/dev/null 2>&1; then
  pulled=false
  for _ in 1 2 3; do
    if docker pull "${keycloak_image}" >/dev/null 2>&1; then
      pulled=true
      break
    fi
    sleep 5
  done
  if [[ "${pulled}" != true ]]; then
    echo "The pinned Keycloak image could not be pulled." >&2
    exit 1
  fi
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=Artifact Server test identity CA ${run_id}" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "${work_directory}/ca.key" -out "${work_directory}/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -subj "/CN=${identity_host}" \
  -keyout "${work_directory}/tls.key" -out "${work_directory}/tls.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' \
  "${identity_host}" > "${work_directory}/leaf.ext"
openssl x509 -req -days 1 -in "${work_directory}/tls.csr" \
  -CA "${work_directory}/ca.pem" -CAkey "${work_directory}/ca.key" -CAcreateserial \
  -extfile "${work_directory}/leaf.ext" -out "${work_directory}/tls.pem" >/dev/null 2>&1
# The CA key never leaves this directory. Keycloak runs as a different UID
# inside its container and reads only the leaf through a read-only bind mount.
rm -f "${work_directory}/ca.key" "${work_directory}/tls.csr" "${work_directory}/leaf.ext"
mkdir "${work_directory}/tls"
mv "${work_directory}/tls.pem" "${work_directory}/tls.key" "${work_directory}/tls/"
chmod 0755 "${work_directory}" "${work_directory}/tls"
chmod 0644 "${work_directory}/ca.pem" "${work_directory}/tls/tls.pem" "${work_directory}/tls/tls.key"

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
  --volume "${work_directory}/tls:/opt/identity-tls:ro" \
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

status=0
ARTIFACT_SERVER_TEST_IDENTITY_HOST="${identity_host}" \
ARTIFACT_SERVER_TEST_IDENTITY_PORT="${port}" \
ARTIFACT_SERVER_TEST_IDENTITY_URL="${identity_url}" \
ARTIFACT_SERVER_TEST_IDENTITY_CA_FILE="${work_directory}/ca.pem" \
ARTIFACT_SERVER_TEST_IDENTITY_NETWORK="${network}" \
ARTIFACT_SERVER_TEST_IDENTITY_CONTAINER="${container_name}" \
ARTIFACT_SERVER_TEST_IDENTITY_CONTAINER_IP="${container_ip}" \
ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_USER="${admin_user}" \
ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_PASSWORD="${admin_password}" \
  "$@" || status=$?
exit "${status}"
