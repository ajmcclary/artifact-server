/**
 * An isolated omp installation for one live test: a temporary agent home whose
 * `models.json` points at the suite's scripted model, and an empty project
 * directory to run in. omp honors PI_CODING_AGENT_DIR from its Pi lineage, so
 * nothing here touches the developer's own `~/.omp`.
 */

import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

/** Provider and model identifiers the temporary installation exposes. */
export const scriptedModelProvider = "livetest";
export const scriptedModelId = "live-suite-model";
export const scriptedModelName = "Live Suite Model";
export const scriptedModel = `${scriptedModelProvider}/${scriptedModelId}`;

/** One temporary omp installation. */
export interface OmpEnvironment {
  readonly agentDirectory: string;
  readonly projectDirectory: string;
  remove(): Promise<void>;
}

/** Create the temporary agent home and project directory. */
export async function createOmpEnvironment(
  modelBaseUrl: string,
): Promise<OmpEnvironment> {
  // omp reports the working directory exactly as handed to it (unlike Pi, it
  // does not resolve the macOS /var -> /private/var symlink), so the suite
  // keeps the raw mkdtemp paths for the registration assertions.
  const agentDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-omp-live-agent-"),
  );
  const projectDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-omp-live-project-"),
  );
  await writeFile(
    path.join(agentDirectory, "models.json"),
    `${JSON.stringify({
      providers: {
        [scriptedModelProvider]: {
          api: "openai-completions",
          apiKey: "artifact-server-omp-live-suite",
          authHeader: true,
          baseUrl: modelBaseUrl,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [{
            contextWindow: 128_000,
            cost: {cacheRead: 0, cacheWrite: 0, input: 0, output: 0},
            id: scriptedModelId,
            input: ["text"],
            maxTokens: 4_096,
            name: scriptedModelName,
            reasoning: false,
          }],
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(agentDirectory, "settings.json"),
    `${JSON.stringify({defaultProjectTrust: "never"}, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(projectDirectory, "notes.md"),
    "# Live suite project\n\nA placeholder file so the directory is not empty.\n",
    "utf8",
  );
  return {
    agentDirectory,
    projectDirectory,
    remove: async () => {
      await rm(agentDirectory, {force: true, recursive: true});
      await rm(projectDirectory, {force: true, recursive: true});
    },
  };
}
