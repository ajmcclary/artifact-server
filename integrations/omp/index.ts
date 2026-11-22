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
 * `reason: "quit" | "reload" | "new" | ...`), so a process quit cannot be
 * told apart from an internal lifecycle action. The courtesy disconnect
 * deletes the server's registration row, and a later registration creates a
 * new agent id that the dispatches queued for the old one can never reach.
 * The bridge therefore keeps the row on every stop, and disconnects only on
 * a shutdown that explicitly says `reason: "quit"` (no omp build observed so
 * far sends one). A row left behind after a real quit goes stale and is
 * reaped; a successor session reclaims it with its queue intact.
 */

import {homedir, hostname} from "node:os";

import {Type} from "typebox";
import {z} from "zod";

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
  sanitizeBundleText,
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
  /** Optional: a build without it registers with no host session id. */
  sessionManager?: OmSessionManagerLike;
  ui: OmNotifier;
}

/** omp sends no reason today; a future explicit quit is honored. */
export interface OmSessionShutdownEventLike {
  readonly reason?: string;
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
  readonly session_shutdown: (
    event?: OmSessionShutdownEventLike,
  ) => Promise<void>;
}

export interface OmExtensionApi {
  on<Event extends keyof OmEventHandlers>(
    event: Event,
    handler: OmEventHandlers[Event],
  ): void;
  registerTool(tool: OmToolDefinitionLike): void;
  sendUserMessage(text: string, delivery: FollowUpDelivery): void;
}

// ---------------------------------------------------------------------------
// Runtime guards
// ---------------------------------------------------------------------------

/**
 * The extension API surface the bridge needs, checked before anything is
 * registered so an omp build that lacks it leaves the bridge dormant instead
 * of throwing into the host. Only presence is checked; calls keep going
 * through the original object so method bindings stay intact.
 */
const extensionSurfaceSchema = z.object({
  on: z.function(),
  registerTool: z.function(),
  sendUserMessage: z.function(),
}).loose();

const eventSurfaceSchema = z.object({on: z.function()}).loose();

/** The session context surface `session_start` needs. */
const sessionContextSchema = z.object({
  cwd: z.string().min(1),
  ui: z.object({notify: z.function()}).loose(),
}).loose();

const sessionManagerSchema = z.object({
  sessionManager: z.object({getSessionId: z.function()}).loose(),
}).loose();

const sessionIdSchema = z.string().min(1);

function isCompleteExtensionApi(
  om: Partial<OmExtensionApi>,
): om is OmExtensionApi {
  return extensionSurfaceSchema.safeParse(om).success;
}

/** The host session id, or null when this build cannot report one. */
function hostSessionId(ctx: OmExtensionContextLike): string | null {
  if (!sessionManagerSchema.safeParse(ctx).success) return null;
  try {
    const parsed = sessionIdSchema.safeParse(ctx.sessionManager?.getSessionId());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Shown once when this omp build lacks the extension API the bridge needs. */
export const unsupportedHostNotice =
  "Artifact Server bridge: this omp build lacks the extension API the " +
  "bridge needs; staying dormant.";

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
  // Second sanitization layer: thread bodies, paths, and reply authors are
  // untrusted human text, even when an older bridge package returned them raw.
  return {
    content: [{text: sanitizeBundleText(text), type: "text"}],
    details: {operation, threadIds},
  };
}

/**
 * Artifact Server bridge extension factory. Never throws into omp: a host
 * without the expected API surface leaves the bridge dormant after one
 * notice, and every event handler contains its own failures.
 */
export default function artifactServerBridge(
  om: Partial<OmExtensionApi>,
): void {
  try {
    if (isCompleteExtensionApi(om)) {
      installBridge(om);
    } else {
      installDormantNotice(om);
    }
  } catch {
    // Registration itself failed; the session continues without the bridge.
  }
}

/** One notice at the first session start, and nothing else. */
function installDormantNotice(om: Partial<OmExtensionApi>): void {
  if (!eventSurfaceSchema.safeParse(om).success) return;
  let noticed = false;
  om.on?.("session_start", (_event, ctx) => {
    if (noticed) return Promise.resolve();
    noticed = true;
    try {
      if (sessionContextSchema.safeParse(ctx).success) {
        ctx.ui.notify(unsupportedHostNotice, "warning");
      }
    } catch {
      // A notice may be lost; the host must never see the failure.
    }
    return Promise.resolve();
  });
}

function installBridge(om: OmExtensionApi): void {
  let bridge: BridgeHandle | null = null;
  let comments: CommentOperations | null = null;
  let compactionStartedAt: number | null = null;
  // Bumped by every session boundary so a start still resolving credentials
  // never installs a bridge after a later start or shutdown superseded it.
  let generation = 0;
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
    generation += 1;
    const current = generation;
    try {
      // A rebind keeps the registration row: the disconnect would delete it,
      // and the next registration would mint a new agent id that the
      // dispatches already queued for this one can never reach. Registration
      // is an upsert on (hostname, workingDirectory), so this start reclaims
      // the same agent id and its queue.
      await stopBridge(false);
      if (!sessionContextSchema.safeParse(ctx).success) {
        comments = null;
        return;
      }
      const environment = environmentConfiguration();
      const credentials = await resolveBridgeCredentials(environment, homedir());
      if (current !== generation) return;
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
          ctx.ui.notify(sanitizeBundleText(message), kind);
        },
        sendUserMessage: (text, delivery) => {
          // Always named follow-up delivery: safe while idle (delivery mode is
          // ignored and a run starts) and queued to the work boundary while
          // streaming. Never "steer", and never omitted.
          om.sendUserMessage(sanitizeBundleText(text), delivery);
        },
      };

      bridge = startBridge({
        agentSessionId: hostSessionId(ctx),
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
    } catch {
      // Fail open: the session continues without the bridge.
    }
  });

  om.on("session_shutdown", async (event) => {
    generation += 1;
    try {
      // omp's session_shutdown carries no reason, so a process quit cannot be
      // told from /reload, /resume, or /fork. Keeping the row is the safe
      // choice: a successor reclaims it with its queue, and a row left by a
      // real quit goes stale and is reaped. Only an explicit quit disconnects.
      await stopBridge(event?.reason === "quit");
    } catch {
      // A failed teardown is unremarkable; the row goes stale and is reaped.
    }
  });

  om.registerTool({
    description:
      "Read, reply to, and resolve Artifact Server comment threads that were " +
      "sent to this agent. Use get_bundle to read threads, reply to record " +
      "what you did on a thread, and resolve to close it when done.",
    async execute(_toolCallId, params) {
      try {
        return await runArtifactComments(comments, params);
      } catch (error) {
        // The tool's own error channel, never a host crash; the text is
        // sanitized like every other string this tool returns.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(sanitizeBundleText(message), {cause: error});
      }
    },
    label: "Artifact comments",
    name: "artifact_comments",
    parameters: artifactCommentsParameters(),
  });
}

async function runArtifactComments(
  operations: CommentOperations | null,
  params: ArtifactCommentsParams,
): Promise<OmToolResultLike> {
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
}
