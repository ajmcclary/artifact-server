/**
 * Spawns a REAL `claude` process in a real PTY and drives it like a terminal
 * user, with the model redirected to the suite's scripted endpoint
 * (ANTHROPIC_BASE_URL + a dummy ANTHROPIC_AUTH_TOKEN) inside an isolated HOME
 * — no real credentials and no metered provider usage.
 *
 * First-run onboarding in the isolated HOME is answered through the PTY:
 * theme chooser, security notes, workspace trust, and the development-channel
 * and MCP-server prompts that `--dangerously-load-development-channels` adds.
 * Screen text is matched whitespace-normalized, because the TUI positions
 * words with cursor moves rather than printing spaces.
 */

import {constants} from "node:fs";
import {access, chmod, realpath, stat} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";

import {spawn} from "node-pty";

/** Everything one live Claude session needs to start. */
export interface LiveClaudeOptions {
  /** Value for ANTHROPIC_BASE_URL: the scripted model's base URL. */
  readonly anthropicBaseUrl: string;
  /** Value for HOME: an isolated home directory. */
  readonly homeDirectory: string;
  /** Working directory of the Claude session (holds `.mcp.json`). */
  readonly projectDirectory: string;
}

/** A running Claude process under test. */
export interface LiveClaude {
  /** Everything the terminal has emitted so far. */
  output(): string;
  /** Whitespace-normalized recent screen content. */
  screen(): string;
  /** Type one line into Claude's editor and submit it. */
  submit(text: string): void;
  stop(): Promise<void>;
  waitForOutput(pattern: RegExp, timeoutMilliseconds?: number): Promise<void>;
}

const defaultWaitMilliseconds = 60_000;
const pollMilliseconds = 100;
const dialogPollMilliseconds = 1_000;
const onboardingWaitMilliseconds = 90_000;
const exitWaitMilliseconds = 5_000;

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

/** Find a claude CLI: an explicit override or the installed `claude` on PATH. */
export async function resolveClaudeCli(): Promise<string | null> {
  const override = process.env["ARTIFACT_SERVER_CLAUDE_LIVE_CLI"]?.trim() ?? "";
  if (override !== "" && await isFile(override)) return override;
  const searchPath = process.env["PATH"] ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, "claude");
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

const arrowDownEnter = `${String.fromCharCode(27)}[B\r`;
const arrowUpUpEnter = `${String.fromCharCode(27)}[A${String.fromCharCode(27)}[A\r`;
const enter = "\r";

/**
 * The known first-run dialogs, latest-in-flow first so stale scrollback of an
 * earlier dialog never wins over the current one. Each is answered once.
 * Observed flow order: theme → security-notes → workspace-trust →
 * mcp-server → development-channel.
 */
const lastOnboardingDialog = "development-channel";
const onboardingDialogs: readonly {
  readonly keys: string;
  readonly name: string;
  readonly pattern: RegExp;
}[] = [
  {
    keys: enter,
    name: "development-channel",
    pattern: /localdevelopment/u,
  },
  {
    // The .mcp.json approval dialog defaults its cursor to "Continue without
    // using this MCP server"; two up-arrows reach "Use this MCP server".
    keys: arrowUpUpEnter,
    name: "mcp-server",
    pattern: /UsethisMCPserver|trustanduse/u,
  },
  {
    keys: arrowDownEnter,
    name: "workspace-trust",
    pattern: /Isthisaprojectyoucreatedoroneyoutrust/u,
  },
  {
    keys: enter,
    name: "security-notes",
    pattern: /PressEntertocontinue/u,
  },
  {
    keys: enter,
    name: "theme",
    pattern: /Choosethetextstyle/u,
  },
];

/** Start Claude and drive onboarding until the editor is ready. */
export async function startLiveClaude(
  options: LiveClaudeOptions,
): Promise<LiveClaude> {
  await ensurePtyHelperExecutable();
  const cliPath = await resolveClaudeCli();
  if (cliPath === null) throw new Error("No claude CLI was found.");

  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Never let real Anthropic credentials or endpoints leak into the child.
    if (key.startsWith("ANTHROPIC_")) continue;
    environment[key] = value;
  }
  Object.assign(environment, {
    ANTHROPIC_AUTH_TOKEN: "artifact-server-claude-live-suite",
    ANTHROPIC_BASE_URL: options.anthropicBaseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Telemetry is off; without this Claude ignores the seeded on-disk
    // GrowthBook feature cache that unlocks the channels capability.
    CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    HOME: options.homeDirectory,
  });

  const terminal = spawn(cliPath, [
    "--dangerously-load-development-channels",
    "server:artifact-server",
    "--model",
    "claude-haiku-4-5",
  ], {
    cols: 120,
    cwd: options.projectDirectory,
    env: environment,
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

  const screen = (): string =>
    output
      .replaceAll(/\[[0-9;?]*[a-zA-Z]|[><][0-9;]*[a-zA-Z]?|\][^]*/gu, "")
      .replaceAll(/\s+/gu, "")
      .slice(-2_500);

  const live: LiveClaude = {
    output: () => output,
    screen,
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
          throw new Error(`claude exited before matching ${pattern.source}.`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `claude never printed ${pattern.source}; last screen: ${
              screen().slice(-400)
            }`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(pollMilliseconds);
      }
    },
  };

  // Answer each first-run dialog once, in flow order, until the final
  // onboarding gate — the development-channel confirmation the channel flag
  // adds — has been handled and the editor has had a moment to initialize.
  const answered = new Set<string>();
  const deadline = Date.now() + onboardingWaitMilliseconds;
  while (Date.now() < deadline) {
    if (exited) throw new Error("claude exited during onboarding.");
    const current = screen();
    let handled = false;
    for (const dialog of onboardingDialogs) {
      if (answered.has(dialog.name) || !dialog.pattern.test(current)) continue;
      answered.add(dialog.name);
      terminal.write(dialog.keys);
      handled = true;
      break;
    }
    if (answered.has(lastOnboardingDialog)) break;
    if (!handled) {
      // no-op: keep watching for the next dialog
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(dialogPollMilliseconds);
  }
  await sleep(3_000);
  return live;
}
