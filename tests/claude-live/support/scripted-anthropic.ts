/**
 * A scripted, offline Anthropic Messages endpoint for the live-Claude suite.
 *
 * The suite drives a REAL `claude` process, which needs a model to run.
 * Instead of a paid provider, this module serves the Anthropic Messages
 * streaming shape from loopback (ANTHROPIC_BASE_URL redirection) and answers
 * every turn from a planner the test owns. That makes the model deterministic
 * and — more useful — makes it the suite's observation window: every request
 * carries Claude's whole conversation, so a test can prove exactly when the
 * bridge's channel bundle entered Claude's context, without any metered
 * provider usage.
 */

import {createServer, type Server} from "node:http";

import {z} from "zod";

/** One text-ish message as Claude sent it to the model. */
export interface ModelMessage {
  readonly role: string;
  readonly text: string;
}

/** One Messages request: Claude's whole conversation at that moment. */
export interface ModelTurn {
  /** 1-based position in the request sequence. */
  readonly index: number;
  readonly messages: readonly ModelMessage[];
  /** Tool names the request advertised (for prefix-agnostic tool lookup). */
  readonly toolNames: readonly string[];
}

/** One tool use the scripted model asks Claude to run. */
export interface ScriptedToolUse {
  readonly input: Readonly<Record<string, string | readonly string[]>>;
  readonly name: string;
}

/** What the scripted model answers for one turn. */
export type ScriptedReply =
  | {readonly kind: "text"; readonly text: string}
  | {readonly kind: "toolUse"; readonly toolUses: readonly ScriptedToolUse[]};

/**
 * The planner answers turn by turn. Awaiting it before responding holds the
 * response stream open, which is how a test holds Claude inside a single unit
 * of work while it sends a bundle.
 */
export type ModelPlanner = (turn: ModelTurn) => Promise<ScriptedReply>;

/** A running scripted model. */
export interface ScriptedModel {
  /** Base URL for the ANTHROPIC_BASE_URL redirect. */
  readonly baseUrl: string;
  /** Every Messages request the live Claude process has made, in order. */
  turns(): readonly ModelTurn[];
  stop(): Promise<void>;
  waitForTurns(count: number, timeoutMilliseconds?: number): Promise<void>;
}

const textBlockSchema = z.object({
  text: z.string(),
  type: z.literal("text"),
}).transform((block) => ({kind: "text" as const, text: block.text}));
const toolResultContentSchema = z.union([
  z.string(),
  z.unknown().transform((value) => JSON.stringify(value) ?? ""),
]);
const toolResultBlockSchema = z.object({
  content: toolResultContentSchema.optional(),
  type: z.literal("tool_result"),
}).transform((block) => ({
  kind: "toolResult" as const,
  text: block.content ?? "",
}));
const toolUseBlockSchema = z.object({
  input: z.unknown().optional(),
  name: z.string(),
  type: z.literal("tool_use"),
}).transform((block) => ({
  kind: "toolUse" as const,
  text: `tool_use ${block.name} ${JSON.stringify(block.input ?? {})}`,
}));
const skippedBlockSchema = z.object({
  type: z.string(),
}).transform(() => ({kind: "skip" as const, text: ""}));
const contentBlockSchema = z.union([
  textBlockSchema,
  toolResultBlockSchema,
  toolUseBlockSchema,
  skippedBlockSchema,
]);
type ContentBlock = z.infer<typeof contentBlockSchema>;
const messageSchema = z.object({
  content: z.union([z.string(), z.array(contentBlockSchema)]),
  role: z.string(),
}).loose();
const requestSchema = z.object({
  messages: z.array(messageSchema),
  stream: z.boolean().nullish(),
  tools: z.array(z.object({name: z.string()}).loose()).nullish(),
}).loose();

function flattenContent(content: string | ContentBlock[]): string {
  if (Array.isArray(content)) {
    return content.map((block) => block.text).join("\n");
  }
  return content;
}

type SseValue =
  | string
  | number
  | boolean
  | null
  | SseData
  | readonly SseValue[];
interface SseData {
  readonly [key: string]: SseValue;
}

function sse(event: string, data: SseData): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textEvents(text: string, index: number): string {
  return sse("content_block_start", {
    content_block: {text: "", type: "text"},
    index,
    type: "content_block_start",
  }) +
    sse("content_block_delta", {
      delta: {text, type: "text_delta"},
      index,
      type: "content_block_delta",
    }) +
    sse("content_block_stop", {index, type: "content_block_stop"});
}

function toolUseEvents(
  toolUse: ScriptedToolUse,
  index: number,
  turnIndex: number,
): string {
  return sse("content_block_start", {
    content_block: {
      // Must be unique across the whole conversation: Claude Code dedupes
      // tool_use blocks by id, and a repeated id makes it replay the earlier
      // tool result instead of executing the new call (an infinite loop).
      id: `toolu_live_${turnIndex}_${index}`,
      input: {},
      name: toolUse.name,
      type: "tool_use",
    },
    index,
    type: "content_block_start",
  }) +
    sse("content_block_delta", {
      delta: {
        partial_json: JSON.stringify(toolUse.input),
        type: "input_json_delta",
      },
      index,
      type: "content_block_delta",
    }) +
    sse("content_block_stop", {index, type: "content_block_stop"});
}

/** Start the scripted model on a loopback port. */
export async function startScriptedAnthropic(
  planner: ModelPlanner,
): Promise<ScriptedModel> {
  const turns: ModelTurn[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const url = request.url ?? "";
        const body = Buffer.concat(chunks).toString("utf8");
        if (request.method === "HEAD") {
          response.writeHead(200);
          response.end();
          return;
        }
        if (url.includes("count_tokens")) {
          response.writeHead(200, {"content-type": "application/json"});
          response.end(JSON.stringify({input_tokens: 42}));
          return;
        }
        if (!url.includes("/v1/messages")) {
          response.writeHead(404, {"content-type": "application/json"});
          response.end(
            JSON.stringify({
              error: {message: "not found", type: "not_found_error"},
              type: "error",
            }),
          );
          return;
        }
        const parsed = requestSchema.parse(JSON.parse(body));
        const turn: ModelTurn = {
          index: turns.length + 1,
          messages: parsed.messages.map((message) => ({
            role: message.role,
            text: flattenContent(message.content),
          })),
          toolNames: (parsed.tools ?? []).map((tool) => tool.name),
        };
        turns.push(turn);
        const reply = await planner(turn);

        const blocks: string[] = [];
        if (reply.kind === "text") {
          blocks.push(textEvents(reply.text, 0));
        } else {
          for (const [index, toolUse] of reply.toolUses.entries()) {
            blocks.push(toolUseEvents(toolUse, index, turn.index));
          }
        }
        const stopReason = reply.kind === "text" ? "end_turn" : "tool_use";
        response.writeHead(200, {"content-type": "text/event-stream"});
        response.write(
          sse("message_start", {
            message: {
              content: [],
              id: "msg_live_suite",
              model: "claude-live-suite",
              role: "assistant",
              stop_reason: null,
              type: "message",
              usage: {input_tokens: 1, output_tokens: 1},
            },
            type: "message_start",
          }) +
            blocks.join("") +
            sse("message_delta", {
              delta: {stop_reason: stopReason},
              type: "message_delta",
              usage: {output_tokens: 3},
            }) +
            sse("message_stop", {type: "message_stop"}),
        );
        response.end();
      })().catch((error) => {
        if (!response.headersSent) {
          response.writeHead(500, {"content-type": "application/json"});
        }
        response.end(JSON.stringify({error: String(error)}));
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z.object({port: z.number()}).parse(server.address());

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    turns: () => [...turns],
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    waitForTurns: async (count: number, timeoutMilliseconds = 30_000) => {
      const deadline = Date.now() + timeoutMilliseconds;
      while (turns.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `The scripted model saw ${turns.length} turn(s); ${count} were expected.`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    },
  };
}

/** User messages that carry an Artifact Server channel bundle. */
export function bundleMessages(turn: ModelTurn): readonly string[] {
  return turn.messages
    .filter((message) =>
      message.role === "user" && message.text.includes("<channel")
    )
    .map((message) => message.text);
}

/** The last user message of a turn ("" when the turn has none). */
export function latestUserMessage(turn: ModelTurn): string {
  const users = turn.messages.filter((message) => message.role === "user");
  return users.at(-1)?.text ?? "";
}
