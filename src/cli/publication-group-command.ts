import type {Command} from "commander";

import {readPublicationGroups} from "./publication-groups-config.js";
import {runPublicationGroup, type PublicationGroupOptions} from "./publication-groups.js";
import type {GroupRunResult} from "./publication-group-model.js";

export async function publishGroupCommand(options: PublicationGroupOptions, json: boolean): Promise<void> {
  const result = await runPublicationGroup(options, async (event) => {
    process.stderr.write(`${event.target}: ${event.message}\n`);
  });
  await writeCliOutput(json ? JSON.stringify(result, null, 2) : renderGroupResult(result));
  if (result.status !== "ready" && result.status !== "completed") process.exitCode = 1;
}

export function configurePublicationGroupList(publications: Command): void {
  publications.command("groups")
    .description("List repository-defined publication groups without contacting a server.")
    .option("--config <file>", "publication group configuration file")
    .option("--json", "print structured group definitions")
    .action(async (options: {readonly config?: string; readonly json?: boolean}) => {
      const config = await readPublicationGroups(options.config);
      const groups = Object.entries(config.definition.groups).map(([name, group]) => ({
        name, targets: group.targets,
        profile: group.profile ?? config.definition.defaults.profile ?? null,
        project: group.project ?? config.definition.defaults.project ?? null,
      }));
      const output = options.json
        ? JSON.stringify({config: config.file, groups}, null, 2)
        : [`Configuration: ${config.file}`, ...groups.map((group) => `${group.name}: ${group.targets.join(", ")}`)].join("\n");
      await writeCliOutput(output);
    });
}

export function writeCliOutput(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => {
      if (error !== null && error !== undefined) reject(error);
      else resolve();
    });
  });
}

function renderGroupResult(result: GroupRunResult): string {
  const lines = [`Group: ${result.group}`];
  if (result.destination !== null) lines.push(`Destination: ${result.destination.origin} (${result.destination.projectId})`);
  if (result.status === "blocked" || result.mode === "dry-run") {
    for (const row of result.preflight) {
      lines.push(`${row.target.padEnd(24)} ${row.status}${row.status === "unregistered" && row.allowed ? " (creation allowed)" : ""}`);
      if (!row.allowed) lines.push(`  ${row.message}`);
    }
    lines.push(result.status === "ready" ? "Preflight ready. No uploads started." : "Preflight blocked. No uploads started.");
  } else {
    for (const row of result.results) {
      lines.push(`${row.target.padEnd(24)} ${row.status}${row.receipt === null ? "" : ` v${row.receipt.version.number}`}`);
      if (row.error !== null) lines.push(`  ${row.error}`);
    }
    const totals = result.summary;
    lines.push(`${totals.published} published · ${totals.unchanged} unchanged · ${totals.recovered} recovered · ${totals.failed} failed · ${totals.skipped} skipped`);
    if (result.reportPath !== null) lines.push(`Run report: ${result.reportPath}`);
  }
  if (result.error !== null) lines.push(result.error);
  return lines.join("\n");
}
