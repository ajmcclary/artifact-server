import {execFile} from "node:child_process";
import {createServer} from "node:net";

import {z} from "zod";

// A missing executable reports a string code such as ENOENT instead of an exit status.
const commandFailureSchema = z.object({code: z.union([z.number().int(), z.string()]).optional()});
const addressSchema = z.object({port: z.number().int().positive()});

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CommandOptions {
  readonly allowFailure?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  /** Values that must never appear in an error message or returned output. */
  readonly sensitive?: readonly string[];
}

/** Run one executable and return its redacted output. */
export function command(
  executable: string,
  arguments_: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const redact = (value: string): string =>
    (options.sensitive ?? []).reduce(
      (text, secret) => secret === "" ? text : text.replaceAll(secret, "[REDACTED]"),
      value,
    );
  return new Promise((resolve, reject) => {
    execFile(executable, arguments_, {
      encoding: "utf8",
      env: options.environment ?? process.env,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = commandFailureSchema.safeParse(error).data?.code;
      const exitStatus = z.number().int().safeParse(code);
      const exitCode = error === null ? 0 : exitStatus.success ? exitStatus.data : 1;
      const result = {exitCode, stderr: redact(stderr), stdout: redact(stdout)};
      if (error !== null && options.allowFailure !== true) {
        reject(new Error(
          `${executable} ${arguments_.join(" ")} failed (${code ?? exitCode}): ${result.stderr}`,
        ));
        return;
      }
      resolve(result);
    });
  });
}

/** Reserve a free loopback port number. */
export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = addressSchema.parse(server.address());
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

/** Poll an HTTP readiness endpoint until it answers 200 or the deadline passes. */
export async function waitForHttpReady(url: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      // Polling is the point: the process is still starting.
      // eslint-disable-next-line no-await-in-loop
      if ((await fetch(url)).status === 200) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`${url} did not become ready.`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
