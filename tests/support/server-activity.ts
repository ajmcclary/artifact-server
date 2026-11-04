import {execFile} from "node:child_process";
import {readdir} from "node:fs/promises";
import {connect} from "node:net";
import path from "node:path";
import {promisify} from "node:util";

import {z} from "zod";

const run = promisify(execFile);
const pgrepNoMatchSchema = z.object({code: z.literal(1)});

/**
 * The process IDs of every live child of this test process. The test server
 * runs in this process, so any program it started would appear here.
 */
export async function childProcessIds(): Promise<readonly number[]> {
  try {
    const {stdout} = await run("pgrep", ["-P", String(process.pid)]);
    return stdout.split("\n").filter((line) => line.trim() !== "").map(Number).toSorted((left, right) => left - right);
  } catch (error) {
    // pgrep exits 1 when no process matches.
    if (pgrepNoMatchSchema.safeParse(error).success) return [];
    throw error;
  }
}

/** Every path below `directory`, relative to it, in sorted order. */
export async function listTree(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, {recursive: true});
  return entries.map((entry) => entry.split(path.sep).join("/")).toSorted();
}

/** Whether a TCP connection to `host:port` is accepted. */
export function acceptsConnections(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({host, port, timeout: 1_000});
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}
