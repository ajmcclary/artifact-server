/**
 * Artifact Server bridge — the thin Oh My Pi (omp) facing entry.
 *
 * Registers this omp session with an Artifact Server installation, receives
 * annotation bundles as follow-up work through the claim loop in
 * `@plannotator/agent-bridge`, and registers the `artifact_comments` tool the
 * agent uses to reply to and resolve each thread. All logic lives in the
 * shared core; this file only wires it to the live extension API.
 *
 * omp is a fork of the Pi coding agent. Its extension API is structurally
 * compatible with the Pi surface this bridge needs, with one difference the
 * shutdown handling below accounts for: the `session_shutdown` event omp
 * emits does not carry a `reason` field (upstream Pi emits
 * `reason: "quit" | "reload" | "new" | ...`). The bridge therefore sends the
 * courtesy disconnect on every shutdown rather than only on a confirmed
 * quit. That is safe because registration identity is a stable upsert keyed
 * on (hostname, workingDirectory): a successor session after an internal
 * lifecycle action (`/reload`, `/new`, `/resume`, `/fork`) reclaims the same
 * agent row on its own `session_start`.
 */

import {homedir, hostname} from "node:os";

import {Type} from "typebox";

import {
  ActivityBeacon,
  type BridgeHandle,
  type BridgeNoticeKind,
  chooseDisplayName,
  type CommentOperations,
  createCommentOperations,
  type EnvironmentConfiguration,
  type FollowUpDelivery,
  type HostPort,
  resolveBridgeCredentials,
  startBridge,
  ThreadLocationCache,
} from "@plannotator/agent-bridge";

/**
 * A compaction flag older than this is treated as expired: a cancelled
 * compaction never emits `session_compact`, so the hold must not stick.
 */
const compactionFlagLifetimeMilliseconds = 5 * 60 * 1_000;

// ---------------------------------------------------------------------------
// The narrow, structurally-typed slice of omp's extension API this entry
// uses. Typing it locally keeps the package free of a hard dependency on
// omp's own type package while the real API remains structurally compatible.
// ---------------------------------------------------------------------------

interface OmNotifier {
  notify(message: string, kind?: BridgeNoticeKind): void;
}

interface OmSessionManagerLike {
  getSessionId(): string;
}

export interface OmExtensionContextLike {
  cwd: string;
  sessionManager: OmSessionManagerLike;
  ui: OmNotifier;
}

interface OmToolTextContent {
  text: string;
  type: "text";
}

interface ArtifactCommentsDetails {
  operation: string;
  threadIds: readonly string[];
}

interface OmToolResultLike {
  content: OmToolTextContent[];
  details: ArtifactCommentsDetails;
}

interface ArtifactCommentsParams {
  body?: string;
  operation: "get_bundle" | "reply" | "resolve";
  threadId?: string;
  threadIds?: string[];
}

interface OmToolDefinitionLike {
  description: string;
  execute(
    toolCallId: string,
    params: ArtifactCommentsParams,
    signal: AbortSignal | undefined,
  ): Promise<OmToolResultLike>;
  label: string;
  name: string;
  parameters: ReturnType<typeof artifactCommentsParameters>;
}

export interface OmEventHandlers {
  readonly session_start: (
    event: Record<string, never>,
    ctx: OmExtensionContextLike,
  ) => Promise<void>;
  readonly session_before_compact: () => void;
  readonly session_compact: () => void;
  readonly session_shutdown: () => Promise<void>;
}

export interface OmExtensionApi {
  on<Event extends keyof OmEventHandlers>(
    event: Event,
    handler: OmEventHandlers[Event],
  ): void;
  registerTool(tool: OmToolDefinitionLike): void;
  sendUserMessage(text: string, delivery: FollowUpDelivery): void;
}

function artifactCommentsParameters() {
  return Type.Object({
    body: Type.Optional(Type.String({
      description: "Reply text (reply operation only).",
    })),
    operation: Type.Union([
      Type.Literal("get_bundle"),
      Type.Literal("reply"),
      Type.Literal("resolve"),
    ], {
      description:
        "get_bundle reads threads with their replies; reply posts one reply; " +
        "resolve closes one thread.",
    }),
    threadId: Type.Optional(Type.String({
      description: "Target thread id (reply and resolve operations).",
    })),
    threadIds: Type.Optional(Type.Array(Type.String(), {
      description: "Thread ids to read (get_bundle operation).",
    })),
  });
}

function environmentConfiguration(): EnvironmentConfiguration {
  return {
    agentDisplayName: process.env["ARTIFACT_SERVER_AGENT_NAME"],
    agentToken: process.env["ARTIFACT_SERVER_AGENT_TOKEN"],
    origin: process.env["ARTIFACT_SERVER_ORIGIN"],
  };
}

function textResult(
  operation: string,
  threadIds: readonly string[],
  text: string,
): OmToolResultLike {
  return {
    content: [{text, type: "text"}],
    details: {operation, threadIds},
  };
}

/** Artifact Server bridge extension factory. */
export default function artifactServerBridge(om: OmExtensionApi): void {
  let bridge: BridgeHandle | null = null;
  let comments: CommentOperations | null = null;
  let compactionStartedAt: number | null = null;
  const locations = new ThreadLocationCache();

  const stopBridge = async (disconnect: boolean): Promise<void> => {
    const active = bridge;
    bridge = null;
    if (active !== null) await active.stop({disconnect});
  };

  // Compaction is tracked from events because the extension context exposes
  // no probe; the timestamp bounds the flag so a cancelled compaction (which
  // never emits session_compact) cannot hold deliveries forever.
  om.on("session_before_compact", () => {
    compactionStartedAt = Date.now();
  });
  om.on("session_compact", () => {
    compactionStartedAt = null;
  });

  om.on("session_start", async (_event, ctx) => {
    // Rebind after a shutdown (internal lifecycle action): stop any previous
    // bridge — a single-shot stop is a no-op if it already ran — then start
    // fresh. Registration is an upsert on (hostname, workingDirectory), so
    // the successor reclaims the same agent row and its queued dispatches.
    await stopBridge(true);
    const environment = environmentConfiguration();
    const credentials = await resolveBridgeCredentials(environment, homedir());
    // One beacon per session: replies and resolves through the tool count
    // against the bundles this session's bridge delivered.
    const beacon = new ActivityBeacon();
    comments = credentials === null
      ? null
      : createCommentOperations(credentials, fetch, locations, beacon);

    const port: HostPort = {
      isCompacting: () =>
        compactionStartedAt !== null &&
        Date.now() - compactionStartedAt < compactionFlagLifetimeMilliseconds,
      notify: (message, kind) => {
        ctx.ui.notify(message, kind);
      },
      sendUserMessage: (text, delivery) => {
        // Always named follow-up delivery: safe while idle (delivery mode is
        // ignored and a run starts) and queued to the work boundary while
        // streaming. Never "steer", and never omitted.
        om.sendUserMessage(text, delivery);
      },
    };

    bridge = startBridge({
      agentSessionId: ctx.sessionManager.getSessionId(),
      beacon,
      credentials,
      displayName: chooseDisplayName(environment, ctx.cwd),
      fetchImplementation: fetch,
      host: port,
      hostname: hostname(),
      kind: "omp",
      locations,
      workingDirectory: ctx.cwd,
    });
  });

  om.on("session_shutdown", async () => {
    // omp's session_shutdown carries no reason, so this adapter cannot tell a
    // process quit from an internal lifecycle action on the event alone. It
    // does not need to: the courtesy disconnect just deletes the server-side
    // registration row, and a successor session re-upserts the same row (the
    // registration key is hostname + workingDirectory, not the session). Send
    // the disconnect exactly once per stop; a later stop() on the same handle
    // would be a no-op.
    await stopBridge(true);
  });

  om.registerTool({
    description:
      "Read, reply to, and resolve Artifact Server comment threads that were " +
      "sent to this agent. Use get_bundle to read threads, reply to record " +
      "what you did on a thread, and resolve to close it when done.",
    async execute(_toolCallId, params) {
      const operations = comments;
      if (operations === null) {
        throw new Error(
          "Artifact Server is not configured; the bridge is dormant.",
        );
      }
      if (params.operation === "get_bundle") {
        const threadIds = params.threadIds ?? [];
        if (threadIds.length === 0) {
          throw new Error("get_bundle requires threadIds.");
        }
        const details = [];
        for (const threadId of threadIds) {
          // eslint-disable-next-line no-await-in-loop
          details.push(await operations.getThread(threadId));
        }
        return textResult(
          "get_bundle",
          threadIds,
          JSON.stringify(details, null, 2),
        );
      }
      const threadId = params.threadId ?? "";
      if (threadId === "") {
        throw new Error(`${params.operation} requires threadId.`);
      }
      if (params.operation === "reply") {
        const body = params.body ?? "";
        if (body.trim() === "") {
          throw new Error("reply requires a non-empty body.");
        }
        await operations.reply(threadId, body);
        return textResult("reply", [threadId], `Replied to ${threadId}.`);
      }
      await operations.resolve(threadId);
      return textResult("resolve", [threadId], `Resolved ${threadId}.`);
    },
    label: "Artifact comments",
    name: "artifact_comments",
    parameters: artifactCommentsParameters(),
  });
}
