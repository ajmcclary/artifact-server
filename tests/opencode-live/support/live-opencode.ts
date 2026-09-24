/**
 * Spawns a REAL `opencode` server in a real PTY and drives it through attach
 * clients.
 *
 * OpenCode 1.18's `serve` command starts a headless server that loads plugins
 * and keeps sessions alive. The suite attaches with `opencode run --attach` to
 * create a top-level session and send the initial prompt. The server persists
 * after the attach client exits, so queued follow-up prompts injected by the
 * bridge are processed one per work boundary.
 */

import {constants} from "node:fs";
import {access, chmod, realpath, stat} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";

import {spawn} from "node-pty";

/** Everything one live OpenCode session needs to start. */
export interface LiveOpencodeOptions {
  /** Value for `XDG_CACHE_HOME/opencode`. */
  readonly cacheDirectory: string;
  /** Value for `XDG_CONFIG_HOME/opencode`. */
  readonly configDirectory: string;
  /** Value for `XDG_DATA_HOME/opencode`. */
  readonly dataDirectory: string;
  /** Working directory of the OpenCode session. */
  readonly projectDirectory: string;
  /** Value for `XDG_STATE_HOME/opencode`. */
  readonly stateDirectory: string;
  /** Artifact Server origin the bridge registers against. */
  readonly origin: string;
  /** Bearer credential carrying `agent:connect`. */
  readonly token: string;
  /** Optional display-name override for the registered agent. */
  readonly agentName?: string;
}

/** A running OpenCode process under test. */
export interface LiveOpencode {
  /** Everything the terminal has emitted so far. */
  output(): string;
  /** Base URL of the `opencode serve` HTTP API under test. */
  serverUrl(): string;
  /** Type one line into an attach client and submit it. */
  submit(text: string): Promise<void>;
  stop(): Promise<void>;
  waitForOutput(pattern: RegExp, timeoutMilliseconds?: number): Promise<void>;
}

const defaultWaitMilliseconds = 60_000;
const pollMilliseconds = 25;
const exitWaitMilliseconds = 5_000;
const attachExitWaitMilliseconds = 10_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Find OpenCode's CLI entry: an explicit override, the installed `opencode` on
 * PATH, or a local checkout build. The checkout is read-only here — nothing is
 * built.
 */
export async function resolveOpencodeCli(): Promise<string | null> {
  const override = process.env["ARTIFACT_SERVER_OPENCODE_LIVE_CLI"]?.trim() ?? "";
  if (override !== "" && await isFile(override)) return override;
  const searchPath = process.env["PATH"] ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, "opencode");
    // eslint-disable-next-line no-await-in-loop
    if (await isFile(candidate)) {
      // eslint-disable-next-line no-await-in-loop
      return await realCliPath(candidate);
    }
  }
  return null;
}

async function realCliPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}

/**
 * node-pty ships a prebuilt `spawn-helper` whose executable bit does not
 * survive npm/pnpm tarball extraction; without it every PTY spawn fails with
 * "posix_spawnp failed". Restore it before the first spawn.
 */
export async function ensurePtyHelperExecutable(): Promise<void> {
  const resolveFromHere = createRequire(import.meta.url);
  const helper = path.join(
    path.dirname(resolveFromHere.resolve("node-pty/package.json")),
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  try {
    await access(helper, constants.X_OK);
  } catch {
    await chmod(helper, 0o755);
  }
}

interface SpawnedProcess {
  output(): string;
  stop(): Promise<void>;
  waitForOutput(pattern: RegExp, timeoutMilliseconds?: number): Promise<void>;
}

function spawnOpencode(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): SpawnedProcess {
  const terminal = spawn("opencode", args, {
    cols: 120,
    cwd,
    env,
    name: "xterm-256color",
    rows: 40,
  });

  let output = "";
  let exited = false;
  let markExited: (() => void) | null = null;
  const exit = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  terminal.onData((data) => {
    output += data;
  });
  terminal.onExit(() => {
    exited = true;
    markExited?.();
  });

  return {
    output: () => output,
    stop: async () => {
      if (!exited) terminal.kill();
      await Promise.race([exit, sleep(exitWaitMilliseconds)]);
    },
    waitForOutput: async (
      pattern,
      timeoutMilliseconds = defaultWaitMilliseconds,
    ) => {
      const deadline = Date.now() + timeoutMilliseconds;
      while (!pattern.test(output)) {
        if (exited) {
          throw new Error(`OpenCode exited before matching ${pattern.source}.`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `OpenCode never printed ${pattern.source}; last output: ${
              output.slice(-400)
            }`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(pollMilliseconds);
      }
    },
  };
}

/** Start OpenCode with the bridge plugin loaded and wait until it is interactive. */
export async function startLiveOpencode(
  options: LiveOpencodeOptions,
  initialMessage: string,
): Promise<LiveOpencode> {
  await ensurePtyHelperExecutable();

  const env = {
    ...process.env,
    ARTIFACT_SERVER_AGENT_NAME: options.agentName ?? "opencode-live-suite",
    ARTIFACT_SERVER_AGENT_TOKEN: options.token,
    ARTIFACT_SERVER_ORIGIN: options.origin,
    XDG_CACHE_HOME: options.cacheDirectory,
    XDG_CONFIG_HOME: options.configDirectory,
    XDG_DATA_HOME: options.dataDirectory,
    XDG_STATE_HOME: options.stateDirectory,
  } satisfies Record<string, string>;

  // The server is the long-lived process that owns sessions and plugins.
  const server = spawnOpencode(
    ["serve", "--port", "0", "--hostname", "127.0.0.1"],
    options.projectDirectory,
    env,
  );

  await server.waitForOutput(
    /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/u,
  );
  const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/u
    .exec(server.output());
  if (match === null) {
    await server.stop();
    throw new Error("Could not parse the OpenCode server URL.");
  }
  const serverUrl = match[1];
  if (serverUrl === undefined) {
    await server.stop();
    throw new Error("Could not parse the OpenCode server URL.");
  }

  // Create the first top-level session by attaching a run client.
  const attach = spawnOpencode(
    ["run", "--attach", serverUrl, initialMessage],
    options.projectDirectory,
    env,
  );

  // Wait until the attach client has rendered the active model footer; the
  // settle pause covers the last frame so typed input reaches the editor.
  await attach.waitForOutput(/> .* · .*live-suite-model/u);
  await sleep(1_000);

  let currentAttach = attach;

  return {
    output: () => currentAttach.output(),
    serverUrl: () => serverUrl,
    submit: async (text) => {
      const next = spawnOpencode(
        ["run", "--attach", serverUrl, text],
        options.projectDirectory,
        env,
      );
      currentAttach = next;
      await next.waitForOutput(/> .* · .*live-suite-model/u);
      await sleep(1_000);
      // The attach client exits once its response finishes; give it a moment
      // but do not wait forever.
      await Promise.race([
        new Promise<void>((resolve) => {
          let settled = false;
          const check = () => {
            if (settled) return;
            // node-pty's onExit has already fired when the process ends.
            if (next.output().includes("Error:") ||
              next.output().includes("Goodbye") ||
              /(EXIT|exited)/u.test(next.output())) {
              settled = true;
              resolve();
              return;
            }
            setTimeout(check, 100);
          };
          check();
        }),
        sleep(attachExitWaitMilliseconds),
      ]);
    },
    stop: async () => {
      await currentAttach.stop();
      await server.stop();
    },
    waitForOutput: (pattern, timeoutMilliseconds) =>
      currentAttach.waitForOutput(pattern, timeoutMilliseconds),
  };
}
