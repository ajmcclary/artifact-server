/**
 * Spawns a REAL `omp` process in a real PTY and drives it like a terminal
 * user. omp is a fork of the Pi coding agent distributed as a compiled
 * binary, so unlike the Pi suite this spawns the binary itself rather than
 * `node dist/cli.js`.
 *
 * omp 18.2.11 opens a first-run setup wizard over the welcome screen a few
 * seconds after the footer paints. Input typed while the wizard holds the
 * screen is lost to it, so startup waits for the wizard's hint line in the
 * output tail and exits the wizard with ctrl+c (Escape only advances to the
 * next wizard step), then lets the editor finish its slow post-setup
 * initialization before the session is used.
 */

import {constants} from "node:fs";
import {access, chmod, realpath, stat} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";

import {spawn} from "node-pty";

/** Everything one live omp session needs to start. */
export interface LiveOmpOptions {
  /** Value for PI_CODING_AGENT_DIR: an isolated agent home. */
  readonly agentDirectory: string;
  /** Absolute path of the omp binary. */
  readonly cliPath: string;
  /** The bridge extension loaded with `--extension`. */
  readonly extensionPath: string;
  /** Model pattern, `provider/id`, resolved from the temporary models.json. */
  readonly model: string;
  /** Display name of the scripted model, painted in the footer. */
  readonly modelName: string;
  /** Artifact Server origin the bridge registers against. */
  readonly origin: string;
  /** Working directory of the omp session. */
  readonly projectDirectory: string;
  /** Bearer credential carrying `agent:connect`. */
  readonly token: string;
}

/** A running omp process under test. */
export interface LiveOmp {
  /** Everything the terminal has emitted so far. */
  output(): string;
  /** Type one line into omp's editor and submit it. */
  submit(text: string): void;
  stop(): Promise<void>;
  waitForOutput(pattern: RegExp, timeoutMilliseconds?: number): Promise<void>;
}

const defaultWaitMilliseconds = 60_000;
const pollMilliseconds = 200;
const settleMilliseconds = 6_000;
const exitWaitMilliseconds = 5_000;
const wizardWaitMilliseconds = 15_000;
const wizardClearMilliseconds = 6_000;
const exitSetupKey = String.fromCharCode(3);

/** omp's footer paints the active model's display name once the TUI is up. */
function modelReadyPattern(modelName: string): RegExp {
  return new RegExp(modelName.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}

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

/** Find an omp CLI: an explicit override or the installed `omp` on PATH. */
export async function resolveOmpCli(): Promise<string | null> {
  const override = process.env["ARTIFACT_SERVER_OMP_LIVE_CLI"]?.trim() ?? "";
  if (override !== "" && await isFile(override)) return override;
  const searchPath = process.env["PATH"] ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, "omp");
    // eslint-disable-next-line no-await-in-loop
    if (await isFile(candidate)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await realpath(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * node-pty ships a prebuilt `spawn-helper` whose executable bit does not
 * survive npm/pnpm tarball extraction; without it every spawn fails with
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

/** Start omp with the bridge extension loaded and wait until it is interactive. */
export async function startLiveOmp(options: LiveOmpOptions): Promise<LiveOmp> {
  await ensurePtyHelperExecutable();
  const terminal = spawn(options.cliPath, [
    "--no-extensions",
    "--extension",
    options.extensionPath,
    "--model",
    options.model,
    "--no-lsp",
    "--no-title",
    "--cwd",
    options.projectDirectory,
  ], {
    cols: 120,
    cwd: options.projectDirectory,
    env: {
      ...process.env,
      ARTIFACT_SERVER_AGENT_NAME: "omp-live-suite",
      ARTIFACT_SERVER_AGENT_TOKEN: options.token,
      ARTIFACT_SERVER_ORIGIN: options.origin,
      PI_CODING_AGENT_DIR: options.agentDirectory,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
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

  const live: LiveOmp = {
    output: () => output,
    stop: async () => {
      if (!exited) terminal.kill();
      await Promise.race([exit, sleep(exitWaitMilliseconds)]);
    },
    submit: (text) => {
      terminal.write(`${text}\r`);
    },
    waitForOutput: async (pattern, timeoutMilliseconds = defaultWaitMilliseconds) => {
      const deadline = Date.now() + timeoutMilliseconds;
      while (!pattern.test(output)) {
        if (exited) {
          throw new Error(`omp exited before matching ${pattern.source}.`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `omp never printed ${pattern.source}; last output: ${
              output.slice(-400)
            }`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(pollMilliseconds);
      }
    },
  };

  // The footer carries the active model once the TUI is up. omp 18.2.11
  // then opens its first-run setup wizard a few seconds later, and input
  // typed while the wizard holds the screen goes to the wizard, not the
  // prompt. The wizard hint ("ctrl+c exit setup") only appears in the
  // newest frames while the wizard is up, so wait for it in the output
  // TAIL, exit it with ctrl+c (Escape only advances to the next step),
  // wait for the tail to go wizard-free, and give the editor its slow
  // post-setup initialization before the session is used.
  await live.waitForOutput(modelReadyPattern(options.modelName));
  const wizardPattern = /exit setup|Setup step/u;
  const wizardWaitStart = Date.now();
  while (!wizardPattern.test(output.slice(-3_000))) {
    if (Date.now() - wizardWaitStart > wizardWaitMilliseconds) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMilliseconds);
  }
  if (wizardPattern.test(output.slice(-3_000))) {
    terminal.write(exitSetupKey);
    const clearWaitStart = Date.now();
    while (wizardPattern.test(output.slice(-3_000))) {
      if (Date.now() - clearWaitStart > wizardClearMilliseconds) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollMilliseconds);
    }
  }
  await sleep(settleMilliseconds);
  return live;
}
