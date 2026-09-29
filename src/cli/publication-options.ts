import {Option, type Command} from "commander";

import type {CliServerConnectionOptions} from "./cli-server-connection.js";

export interface PublicationDestinationOptions extends CliServerConnectionOptions {
  readonly project?: string;
}
export interface PublishOptions extends PublicationDestinationOptions {
  readonly artifact?: string;
  readonly expectedVersion?: string;
  readonly entry?: string;
  readonly routing?: "spa" | "static";
  readonly name?: string;
  readonly public: boolean;
  readonly tag: readonly string[];
  readonly newArtifact: boolean;
}

export function addPublicationDestinationOptions(command: Command, defaultProfileDirectory: string): Command {
  return command
    .addOption(new Option("--server <origin>", "Artifact Server origin").env("ARTIFACT_SERVER_URL"))
    .addOption(new Option("--data <directory>", "local Artifact Server data directory").default(".artifact-server"))
    .addOption(new Option("--token-file <path>", "file containing an Artifact Server API token"))
    .addOption(new Option("--profile <name>", "saved Artifact Server profile"))
    .addOption(new Option("--profile-data <directory>", "user-local CLI profile directory")
      .default(defaultProfileDirectory).env("ARTIFACT_SERVER_HOME"))
    .addOption(new Option("--project <id>", "project ID; optional for one matching binding or active project"));
}
