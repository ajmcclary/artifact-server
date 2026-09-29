import {Option, type Command} from "commander";

import {addPublicationDestinationOptions, type PublishOptions} from "./publication-options.js";
import {publishGroupCommand, writeCliOutput} from "./publication-group-command.js";
import {publishRemembered} from "./remembered-publication.js";

/** User-local configuration shared by auth and publishing commands. */
export interface PublishCommandOptions {
  readonly defaultProfileDirectory: string;
}

/** Publish a source and remember its successful destination outside the source. */
export function configurePublishCommand(program: Command, options: PublishCommandOptions): void {
  addPublicationDestinationOptions(program.command("publish")
    .description("Publish a file or directory, remembering its artifact for later versions.")
    .argument("[path]", "file or finished directory to publish"), options.defaultProfileDirectory)
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
    .option("--group <name>", "publish a named repository group")
    .option("--config <file>", "publication group configuration file")
    .option("--dry-run", "inspect a group without uploading or writing publication state", false)
    .option("--allow-create", "allow unregistered group members to create private artifacts", false)
    .option("--fail-fast", "stop after the first runtime group failure", false)
    .option("--json", "print a structured group result (single-path output is already JSON)", false)
    .action(async (inputPath: string | undefined, publishOptions: PublishInvocationOptions) => {
      if ((inputPath === undefined) === (publishOptions.group === undefined)) {
        throw new Error("Select exactly one publication path or --group <name>.");
      }
      if (publishOptions.group !== undefined) {
        if (publishOptions.artifact !== undefined || publishOptions.expectedVersion !== undefined ||
          publishOptions.newArtifact || publishOptions.name !== undefined || publishOptions.public || publishOptions.tag.length > 0 ||
          publishOptions.entry !== undefined || publishOptions.routing !== undefined) {
          throw new Error("Group publication inherits each target's choices. Per-artifact flags cannot be combined with --group.");
        }
        await publishGroupCommand({...publishOptions, group: publishOptions.group}, publishOptions.json);
        return;
      }
      if (inputPath === undefined) throw new Error("A publication path is required.");
      if (publishOptions.config !== undefined || publishOptions.dryRun || publishOptions.allowCreate || publishOptions.failFast) {
        throw new Error("--config, --dry-run, --allow-create, and --fail-fast require --group.");
      }
      await publishRemembered(inputPath, publishOptions, (result) => writeCliOutput(JSON.stringify(result, null, 2)));
    });
}


interface PublishInvocationOptions extends PublishOptions {
  readonly group?: string;
  readonly config?: string;
  readonly dryRun: boolean;
  readonly allowCreate: boolean;
  readonly failFast: boolean;
  readonly json: boolean;
}
