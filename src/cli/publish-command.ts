import {Option, type Command} from "commander";

import {addPublicationDestinationOptions, type PublishOptions} from "./publication-options.js";
import {publishRemembered} from "./remembered-publication.js";

/** User-local configuration shared by auth and publishing commands. */
export interface PublishCommandOptions {
  readonly defaultProfileDirectory: string;
}

/** Publish a source and remember its successful destination outside the source. */
export function configurePublishCommand(program: Command, options: PublishCommandOptions): void {
  addPublicationDestinationOptions(program.command("publish")
    .description("Publish a file or directory, remembering its artifact for later versions.")
    .argument("<path>", "file or finished directory to publish"), options.defaultProfileDirectory)
    .addOption(new Option("--entry <path>", "directory file that opens first"))
    .addOption(new Option("--routing <mode>", "path routing; defaults to remembered choice or static")
      .choices(["static", "spa"]))
    .addOption(new Option("--name <name>", "name for a new artifact"))
    .addOption(new Option("--public", "allow the new artifact to open without sign-in").default(false))
    .addOption(new Option("--tag <tag>", "tag for a new artifact; repeat for more tags")
      .argParser((value: string, previous: readonly string[]) => [...previous, value]).default([]))
    .addOption(new Option("--artifact <id>", "explicit artifact to publish a new version to"))
    .addOption(new Option("--expected-version <id>", "expected current version for an explicit artifact"))
    .addOption(new Option("--new-artifact", "create another artifact and remember it after success").default(false))
    .action(async (inputPath: string, publishOptions: PublishOptions) => {
      await publishRemembered(inputPath, publishOptions, (result) => new Promise<void>((resolve, reject) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, (error) => {
          if (error !== null && error !== undefined) reject(error);
          else resolve();
        });
      }));
    });
}
