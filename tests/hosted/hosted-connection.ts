import os from "node:os";
import path from "node:path";

import {Redacted} from "effect";

import {resolveCliServerConnection} from "../../src/cli/cli-server-connection.js";

/** One hosted Artifact Server and the operator credential the CLI already holds for it. */
export interface HostedConnection {
  readonly apiToken: string;
  readonly baseUrl: string;
}

/**
 * Resolve the hosted origin's credential from the operator's CLI profile, so
 * the suite never reads or stores a token of its own.
 */
export async function hostedConnection(): Promise<HostedConnection> {
  const origin = process.env["ARTIFACT_SERVER_HOSTED_URL"] ?? "https://artifacts.backend.app";
  const profileData = process.env["ARTIFACT_SERVER_PROFILE_DATA"] ?? path.join(os.homedir(), ".artifact-server");
  const connection = await resolveCliServerConnection({
    data: profileData,
    profileData,
    server: origin,
  }, "publish");
  return {apiToken: Redacted.value(connection.apiToken), baseUrl: connection.origin};
}
