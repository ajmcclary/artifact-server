import os from "node:os";
import path from "node:path";

import {Redacted} from "effect";

import {resolveCliServerConnection} from "../../src/cli/cli-server-connection.js";

/** One hosted Artifact Server and the operator credential the CLI already holds for it. */
export interface HostedConnection {
  readonly apiToken: string;
  readonly baseUrl: string;
}

/** The variable naming the agent principal's CLI profile directory; preferred when set. */
export const hostedAgentProfileVariable = "ARTIFACT_SERVER_HOSTED_AGENT_PROFILE_DATA";

/** The variable holding the agent principal's key itself, normally from the repository's ignored `.env`. */
export const hostedAgentKeyVariable = "BACKEND_AGENT_KEY";

/** What the owner does once before hosted bundle delivery can run. */
export const hostedAgentSetup =
  `Set ${hostedAgentProfileVariable} to a CLI profile directory holding the hosted agent principal, ` +
  `or put its key in ${hostedAgentKeyVariable} in the repository's ignored .env (mode 0600). ` +
  "One-time owner setup: a human administrator creates, in the admin console, a service API key " +
  "that is not bound to a member, with capabilities agent:connect and artifact:read only and an expiry.";

function hostedOrigin(): string {
  return process.env["ARTIFACT_SERVER_HOSTED_URL"] ?? "https://artifacts.backend.app";
}

function operatorProfileData(): string {
  return process.env["ARTIFACT_SERVER_PROFILE_DATA"] ?? path.join(os.homedir(), ".artifact-server");
}

/** Read one profile directory's credential for the hosted origin, never printing it. */
async function profileConnection(profileData: string): Promise<HostedConnection> {
  const connection = await resolveCliServerConnection({
    data: profileData,
    profileData,
    server: hostedOrigin(),
  }, "publish");
  return {apiToken: Redacted.value(connection.apiToken), baseUrl: connection.origin};
}

/**
 * Resolve the hosted origin's credential from the operator's CLI profile, so
 * the suite never reads or stores a token of its own.
 */
export function hostedConnection(): Promise<HostedConnection> {
  return profileConnection(operatorProfileData());
}

function configured(variable: string): string | null {
  const value = process.env[variable]?.trim() ?? "";
  return value === "" ? null : value;
}

/** True when the owner has given the suite an agent principal through either source. */
export function hostedAgentConfigured(): boolean {
  return configured(hostedAgentProfileVariable) !== null || configured(hostedAgentKeyVariable) !== null;
}

/**
 * Resolve the dedicated agent principal's credential: its own CLI profile
 * directory when one is named, otherwise the key in `BACKEND_AGENT_KEY`. It
 * never falls back to the operator's key, and refuses anything that could
 * hand that key back instead: the operator's own profile directory, or an
 * explicit `ARTIFACT_SERVER_API_TOKEN`, which the CLI prefers over any profile.
 * The key goes to the caller only, never to a log or a file.
 */
export function hostedAgentConnection(): Promise<HostedConnection> {
  const profileData = configured(hostedAgentProfileVariable);
  if (profileData === null) {
    const key = configured(hostedAgentKeyVariable);
    if (key === null) return Promise.reject(new Error(hostedAgentSetup));
    return Promise.resolve({apiToken: key, baseUrl: new URL(hostedOrigin()).origin});
  }
  if (path.resolve(profileData) === path.resolve(operatorProfileData())) {
    return Promise.reject(new Error(
      `${hostedAgentProfileVariable} names the operator's own profile directory; the agent principal needs a directory of its own.`,
    ));
  }
  if (process.env["ARTIFACT_SERVER_API_TOKEN"] !== undefined) {
    return Promise.reject(new Error(
      `Unset ARTIFACT_SERVER_API_TOKEN: the CLI would use it in place of the profile in ${hostedAgentProfileVariable}.`,
    ));
  }
  return profileConnection(profileData);
}
