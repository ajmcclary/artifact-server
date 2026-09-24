/**
 * An isolated OpenCode installation for one live test: a temporary config home
 * whose `opencode.json` points at the suite's scripted model and loads the
 * Artifact Server bridge plugin, plus an empty project directory to run in.
 * Nothing here touches the developer's own `~/.config/opencode`.
 */

import {mkdir, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

/** Provider and model identifiers the temporary installation exposes. */
export const scriptedModelProvider = "livetest";
export const scriptedModelId = "live-suite-model";
export const scriptedModel = `${scriptedModelProvider}/${scriptedModelId}`;

/** One temporary OpenCode installation. */
export interface OpencodeEnvironment {
  readonly cacheDirectory: string;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly projectDirectory: string;
  readonly stateDirectory: string;
  remove(): Promise<void>;
}

/** Create the temporary config home and project directory. */
export async function createOpencodeEnvironment(
  modelBaseUrl: string,
  bridgeExtensionPath: string,
): Promise<OpencodeEnvironment> {
  // OpenCode reports its resolved working directory, so the suite holds the
  // resolved paths too (macOS temp directories reach the process through a
  // symlink).
  const baseDirectory = await realpath(
    await mkdtemp(path.join(tmpdir(), "artifact-server-opencode-live-")),
  );
  const configDirectory = path.join(baseDirectory, "config");
  const dataDirectory = path.join(baseDirectory, "data");
  const stateDirectory = path.join(baseDirectory, "state");
  const cacheDirectory = path.join(baseDirectory, "cache");
  const projectDirectory = await realpath(
    await mkdtemp(path.join(baseDirectory, "project-")),
  );

  await mkdir(path.join(configDirectory, "opencode"), {recursive: true});
  await mkdir(dataDirectory, {recursive: true});
  await mkdir(stateDirectory, {recursive: true});
  await mkdir(cacheDirectory, {recursive: true});

  await writeFile(
    path.join(configDirectory, "opencode", "opencode.json"),
    `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: scriptedModel,
      provider: {
        [scriptedModelProvider]: {
          name: "Live Suite",
          npm: "@ai-sdk/openai-compatible",
          options: {
            apiKey: "artifact-server-opencode-live-suite",
            baseURL: modelBaseUrl,
          },
          models: {
            [scriptedModelId]: {
              limit: {context: 128_000, output: 4_096},
              modalities: {input: ["text"], output: ["text"]},
              name: "Live Suite Model",
            },
          },
        },
      },
      plugin: [new URL(bridgeExtensionPath, "file://").href],
    }, null, 2)}\n`,
    "utf8",
  );

  await writeFile(
    path.join(projectDirectory, "notes.md"),
    "# Live suite project\n\nA placeholder file so the directory is not empty.\n",
    "utf8",
  );

  return {
    cacheDirectory,
    configDirectory,
    dataDirectory,
    projectDirectory,
    stateDirectory,
    remove: async () => {
      await rm(baseDirectory, {force: true, recursive: true});
    },
  };
}
