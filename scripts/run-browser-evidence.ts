import {spawn} from "node:child_process";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const finalizerScript = path.join(repositoryRoot, "scripts", "write-browser-evidence.ts");

interface RunOptions {
  readonly args: readonly string[];
  readonly command: string;
  readonly env?: NodeJS.ProcessEnv;
}

function includesPrebuiltFlag(): boolean {
  return process.argv.slice(2).includes("--prebuilt");
}

function runCommand(options: RunOptions): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: repositoryRoot,
      env: {...process.env, ...options.env},
      stdio: "inherit",
    });

    child.on("error", () => {
      resolve(1);
    });

    child.on("close", (exitCode) => {
      resolve(exitCode ?? 1);
    });
  });
}

async function runFinalizer(playwrightExitCode: number): Promise<number> {
  return runCommand({
    command: "node",
    args: ["--import", "tsx", finalizerScript],
    env: {
      PLAYWRIGHT_EXIT_CODE: String(playwrightExitCode),
    },
  });
}

async function main(): Promise<void> {
  const prebuilt = includesPrebuiltFlag();

  if (!prebuilt) {
    const buildExitCode = await runCommand({command: "pnpm", args: ["build"]});
    if (buildExitCode !== 0) {
      await runFinalizer(buildExitCode);
      process.exit(buildExitCode);
      return;
    }
  }

  const playwrightExitCode = await runCommand({
    command: "pnpm",
    args: ["exec", "playwright", "test"],
  });

  const finalizerExitCode = await runFinalizer(playwrightExitCode);

  if (playwrightExitCode !== 0) {
    process.exit(playwrightExitCode);
    return;
  }

  if (finalizerExitCode !== 0) {
    process.exit(1);
    return;
  }

  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`Browser evidence runner failed: ${String(error)}\n`);
  process.exit(1);
});
