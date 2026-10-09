import {lookup as dnsLookup, type LookupAddress} from "node:dns";
import {readFile} from "node:fs/promises";

import {Agent, fetch as undiciFetch} from "undici";

import type {KeycloakEnvironment, KeycloakFetch} from "../keycloak-realm.js";

/** The TLS Keycloak that scripts/with-private-team-identity.sh started. */
export interface PrivateTeamIdentity {
  readonly caFile: string;
  readonly caPem: string;
  readonly container: string;
  readonly containerIp: string;
  readonly host: string;
  readonly keycloak: KeycloakEnvironment;
  readonly network: string;
  readonly port: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Run this suite through scripts/with-private-team-identity.sh (${name} is unset).`,
    );
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
      lookup: (hostname, options, callback) => {
        if (hostname !== host) {
          dnsLookup(hostname, options, callback);
          return;
        }
        const loopback: LookupAddress = {address: "127.0.0.1", family: 4};
        if (options.all === true) {
          callback(null, [loopback]);
        } else {
          callback(null, loopback.address, loopback.family);
        }
      },
    },
  });
  const identityFetch: KeycloakFetch = (input, init) =>
    undiciFetch(input, {...init, dispatcher: agent});
  return {
    caFile,
    caPem,
    container: required("ARTIFACT_SERVER_TEST_IDENTITY_CONTAINER"),
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
