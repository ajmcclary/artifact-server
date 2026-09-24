/**
 * An isolated Claude Code installation for one live test: a temporary HOME
 * (so the developer's own ~/.claude is never touched) and an empty project
 * directory whose `.mcp.json` registers the Artifact Server channel for the
 * `--dangerously-load-development-channels` flag.
 */

import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

/** One temporary Claude Code installation. */
export interface ClaudeEnvironment {
  readonly homeDirectory: string;
  readonly projectDirectory: string;
  remove(): Promise<void>;
}

/** Everything the project's `.mcp.json` needs to wire the channel. */
export interface ClaudeEnvironmentOptions {
  /** Bearer credential carrying `agent:connect`, passed to the channel. */
  readonly apiToken: string;
  /** Artifact Server origin the channel registers against. */
  readonly origin: string;
}

/** Create the temporary home and project directory. */
export async function createClaudeEnvironment(
  options: ClaudeEnvironmentOptions,
): Promise<ClaudeEnvironment> {
  const homeDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-claude-live-home-"),
  );
  const projectDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-claude-live-project-"),
  );
  // Claude Code gates channels behind the server-driven "tengu_harbor" feature
  // flag. An isolated HOME has no authenticated bootstrap to fetch it from, so
  // seed the on-disk feature cache the same way a real signed-in install does.
  await writeFile(
    path.join(homeDirectory, ".claude.json"),
    `${JSON.stringify({
      cachedGrowthBookFeatures: {tengu_harbor: true},
    }, null, 2)}\n`,
    "utf8",
  );
  const channelEntry = new URL(
    "../../../integrations/claude-channel/bin/claude-channel.js",
    import.meta.url,
  ).pathname;
  await writeFile(
    path.join(projectDirectory, ".mcp.json"),
    `${JSON.stringify({
      mcpServers: {
        "artifact-server": {
          args: [channelEntry],
          command: process.execPath,
          env: {
            ARTIFACT_SERVER_AGENT_NAME: "claude-live-suite",
            ARTIFACT_SERVER_AGENT_TOKEN: options.apiToken,
            ARTIFACT_SERVER_ORIGIN: options.origin,
          },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  // Claude Code prompts for approval on every MCP tool call; nobody is at the
  // keyboard in a PTY suite, so pre-approve the channel's tool.
  await mkdir(path.join(projectDirectory, ".claude"), {recursive: true});
  await writeFile(
    path.join(projectDirectory, ".claude", "settings.json"),
    `${JSON.stringify({
      permissions: {
        allow: ["mcp__artifact-server__artifact_comments"],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(projectDirectory, "notes.md"),
    "# Live suite project\n\nA placeholder file so the directory is not empty.\n",
    "utf8",
  );
  return {
    homeDirectory,
    projectDirectory,
    remove: async () => {
      await rm(homeDirectory, {force: true, recursive: true});
      await rm(projectDirectory, {force: true, recursive: true});
    },
  };
}
