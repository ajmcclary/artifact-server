#!/usr/bin/env node

/**
 * Artifact Server bridge as a Claude Code channel.
 *
 * Claude Code spawns this process over stdio when the channel is registered
 * and opted in. It runs the same claim loop as the Pi bridge (the long poll
 * is the heartbeat, so presence is real), and each claimed bundle is pushed
 * into the session as a `notifications/claude/channel` event. Claude replies
 * to and resolves each thread through the `artifact_comments` tool this
 * server exposes.
 *
 * Evidence tier: `channel` — the bridge reports `delivered` once the
 * notification is written to the transport, which proves admission to the
 * session, not model processing (spec section 4.3).
 *
 * Lifetime: the channel lives exactly as long as its Claude Code session.
 * The stdio transport never watches stdin for end-of-file, so this entry
 * does: when stdin ends or closes, stdout breaks, or the MCP connection
 * closes, the session is gone. The bridge stops claiming, an in-flight
 * delivery is left unreported for lease expiry rather than reported
 * delivered into a dead pipe, and the process disconnects and exits.
 */

import {homedir, hostname} from "node:os";
import process from "node:process";

import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";

import {
  ActivityBeacon,
  type BridgeHandle,
  chooseDisplayName,
  type CommentOperations,
  createCommentOperations,
  type EnvironmentConfiguration,
  resolveBridgeCredentials,
  sanitizeBundleText,
  startBridge,
  ThreadLocationCache,
} from "@plannotator/agent-bridge";

const channelName = "artifact-server";
const channelVersion = "0.1.4";

function environmentConfiguration(): EnvironmentConfiguration {
  return {
    agentDisplayName: process.env["ARTIFACT_SERVER_AGENT_NAME"],
    agentToken: process.env["ARTIFACT_SERVER_AGENT_TOKEN"],
    origin: process.env["ARTIFACT_SERVER_ORIGIN"],
  };
}

const artifactCommentsInputSchema = {
  properties: {
    body: {
      description: "Reply text (reply operation only).",
      type: "string",
    },
    operation: {
      description:
        "get_bundle reads threads with their replies; reply posts one " +
        "reply; resolve closes one thread.",
      enum: ["get_bundle", "reply", "resolve"],
      type: "string",
    },
    threadId: {
      description: "Target thread id (reply and resolve operations).",
      type: "string",
    },
    threadIds: {
      description: "Thread ids to read (get_bundle operation).",
      items: {type: "string"},
      type: "array",
    },
  },
  required: ["operation"],
  type: "object",
} as const;

const artifactCommentsArgumentsSchema = z.object({
  body: z.string().optional(),
  operation: z.enum(["get_bundle", "reply", "resolve"]),
  threadId: z.string().optional(),
  threadIds: z.array(z.string()).optional(),
});

type ArtifactCommentsArguments = z.infer<typeof artifactCommentsArgumentsSchema>;

function textContent(text: string) {
  // Second sanitization layer: thread bodies, paths, and reply authors are
  // untrusted human text, even when an older bridge package returned them raw.
  return {content: [{text: sanitizeBundleText(text), type: "text" as const}]};
}

/** A stop that outlives this bound is abandoned and the process exits. */
const forcedExitMilliseconds = 10_000;

async function runArtifactComments(
  operations: CommentOperations | null,
  parameters: ArtifactCommentsArguments,
) {
  if (operations === null) {
    throw new Error("Artifact Server is not configured; the bridge is dormant.");
  }
  if (parameters.operation === "get_bundle") {
    const threadIds = parameters.threadIds ?? [];
    if (threadIds.length === 0) throw new Error("get_bundle requires threadIds.");
    const details = [];
    for (const threadId of threadIds) {
      // eslint-disable-next-line no-await-in-loop
      details.push(await operations.getThread(threadId));
    }
    return textContent(JSON.stringify(details, null, 2));
  }
  const threadId = parameters.threadId ?? "";
  if (threadId === "") throw new Error(`${parameters.operation} requires threadId.`);
  if (parameters.operation === "reply") {
    const body = parameters.body ?? "";
    if (body.trim() === "") throw new Error("reply requires a non-empty body.");
    await operations.reply(threadId, body);
    return textContent(`Replied to ${threadId}.`);
  }
  await operations.resolve(threadId);
  return textContent(`Resolved ${threadId}.`);
}

async function main(): Promise<void> {
  const mcp = new Server(
    {name: channelName, version: channelVersion},
    {
      capabilities: {
        experimental: {"claude/channel": {}},
        tools: {},
      },
      instructions:
        "Artifact Server review bundles arrive as " +
        '<channel source="artifact-server"> events listing comment threads ' +
        "with their ids. Do the work each thread asks for, then use the " +
        "artifact_comments tool: reply on each thread with what you did, " +
        "then resolve it. get_bundle rereads threads when you need the " +
        "full context.",
    },
  );

  const locations = new ThreadLocationCache();
  const beacon = new ActivityBeacon();
  const environment = environmentConfiguration();
  const credentials = await resolveBridgeCredentials(environment, homedir());
  const comments = credentials === null
    ? null
    : createCommentOperations(credentials, fetch, locations, beacon);

  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{
      description:
        "Read, reply to, and resolve Artifact Server comment threads that " +
        "were sent to this session. Use get_bundle to read threads, reply " +
        "to record what you did on a thread, and resolve to close it when " +
        "done.",
      inputSchema: artifactCommentsInputSchema,
      name: "artifact_comments",
    }],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "artifact_comments") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    try {
      return await runArtifactComments(
        comments,
        artifactCommentsArgumentsSchema.parse(request.params.arguments ?? {}),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(sanitizeBundleText(message), {cause: error});
    }
  });

  // False once the Claude Code side of the pipe is gone. Nothing is written
  // into the transport after that, and nothing is reported delivered.
  let sessionAlive = true;
  let bridge: BridgeHandle | null = null;
  let stopping = false;

  const shutdown = (): void => {
    if (stopping) {
      // A second signal while the stop is still pending: leave now.
      process.exit(1);
    }
    stopping = true;
    setTimeout(() => {
      process.stderr.write("Channel stop timed out; exiting.\n");
      process.exit(1);
    }, forcedExitMilliseconds).unref();
    const active = bridge;
    bridge = null;
    void (active === null ? Promise.resolve() : active.stop({disconnect: true}))
      .catch(() => undefined)
      .finally(() => {
        process.exit(0);
      });
  };

  const sessionEnded = (): void => {
    sessionAlive = false;
    if (!stopping) shutdown();
  };

  // Registered before the transport starts, so an early end is never missed.
  process.stdin.once("end", sessionEnded);
  process.stdin.once("close", sessionEnded);
  // A broken stdout (EPIPE) is a dead session, not a crash.
  process.stdout.on("error", sessionEnded);
  // The Protocol's own close hook: the SDK calls it from the transport close
  // handler it installs at connect, where assigning transport.onclose after
  // connect would replace that handler. It is a single property, not an event
  // target, and nothing else in this process sets it.
  // eslint-disable-next-line unicorn/prefer-add-event-listener
  mcp.onclose = sessionEnded;

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  // The session ended while the transport was starting: claim nothing.
  if (stopping) return;

  bridge = startBridge({
    agentSessionId: null,
    beacon,
    capabilities: {beacon: true, evidence: "channel"},
    credentials,
    displayName: chooseDisplayName(environment, process.cwd()),
    fetchImplementation: fetch,
    host: {
      // No compaction signal exists on this side of the stdio boundary;
      // Claude Code itself queues channel events while the session is busy.
      isCompacting: () => false,
      notify: (message) => {
        // A channel has no user-facing notice surface; stderr reaches the
        // channel log without entering the protocol stream on stdout.
        process.stderr.write(`${sanitizeBundleText(message)}\n`);
      },
      sendUserMessage: (text) => {
        // A synchronous throw is the protocol's lost-handle signal: with the
        // session gone the loop ends and leaves this claim for lease expiry.
        if (!sessionAlive) throw new Error("The Claude Code session is gone.");
        return pushNotification(text);
      },
    },
    hostname: hostname(),
    kind: "claude",
    locations,
    log: (message) => {
      process.stderr.write(`${message}\n`);
    },
    workingDirectory: process.cwd(),
  });

  // Resolution proves transport admission, not model processing, which is
  // this tier's evidence bound. A rejection fails this dispatch while leaving
  // the channel available for later work.
  async function pushNotification(text: string): Promise<void> {
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: sanitizeBundleText(text),
          meta: {channel_kind: "artifact_server_dispatch"},
        },
      });
    } catch (error) {
      if (!sessionAlive) return untilStopped();
      process.stderr.write("Channel notification failed.\n");
      throw error;
    }
    // A write into a dead pipe still "succeeds"; give a broken pipe or a
    // closed stdin one event-loop turn to surface before admission counts.
    await new Promise((settle) => {
      setImmediate(settle);
    });
    if (!sessionAlive) return untilStopped();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Never settles: an admission that raced the session's end is uncertain, so
 * it is neither delivered nor failed. The bridge's stop abandons it and the
 * lease returns the dispatch to the queue.
 */
function untilStopped(): Promise<void> {
  return new Promise(() => undefined);
}

void (async () => {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`Channel failed to start: ${String(error)}\n`);
    process.exit(1);
  }
})();
