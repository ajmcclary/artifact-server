import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  bundleAnchorSchema as packageAnchorSchema,
  bundleLocationLine as packageLine,
  type BridgeHandle,
  startBridge,
} from "@plannotator/agent-bridge";
import {expect} from "@playwright/test";
import {z} from "zod";

import {
  bundleAnchorSchema as serverAnchorSchema,
  bundleLocationLine as serverLine,
} from "../../src/mcp/dispatch-bundle-message.js";
import type {ApiTarget} from "../support/publishing.js";
import {apiHeaders} from "../support/runtime-harness.js";
import {callHostedTool, getHostedJson} from "./hosted-fixture.js";

/**
 * Hosted DSN-011-B: one comment thread dispatched to two agents of a
 * dedicated agent principal, an MCP mailbox and a native bridge, and the
 * location line each render carries. The operator sends; only the agent
 * principal registers, claims and reports, so the operator's own mailbox is
 * never touched.
 */

const sessionSchema = z.object({
  principal: z.object({
    authorizedByPrincipalId: z.string().nullable(),
    capabilities: z.array(z.string()),
    id: z.string(),
    kind: z.enum(["human", "service"]),
  }).loose(),
}).loose();
const threadSchema = z.object({thread: z.object({anchor: z.unknown()}).loose()}).loose();
const mailboxSchema = z.object({agent: z.object({id: z.string()}).loose()}).loose();
const claimSchema = z.object({
  claimed: z.object({dispatchId: z.string(), message: z.string()}).loose().nullable(),
}).loose();
const reportSchema = z.object({report: z.object({state: z.string()}).loose().nullable()}).loose();
const dispatchSchema = z.object({dispatch: z.object({id: z.string(), state: z.string()}).loose()}).loose();

type SessionPrincipal = z.infer<typeof sessionSchema>["principal"];

/** The capabilities the owner grants the agent principal, and nothing more. */
const agentCapabilities = ["agent:connect", "artifact:read"];

/** The comment to deliver and where it lives. */
export interface DeliveredThread {
  readonly artifactId: string;
  readonly projectId: string;
  readonly runTag: string;
  readonly threadId: string;
}

/** Both renders of one thread, with the location line its stored anchor names. */
export interface BundleDeliveryProof {
  /** The line both renderers derive from the stored anchor's view block. */
  readonly location: string;
  /** The server's render, claimed over MCP. */
  readonly mailbox: string;
  /** The patched bridge package's render, claimed through the bridge core. */
  readonly native: string;
}

async function sessionPrincipal(target: ApiTarget): Promise<SessionPrincipal> {
  return (await getHostedJson(target, "/api/v1/session", sessionSchema)).principal;
}

/**
 * `requireDispatchSend` admits a direct human principal (a browser or OAuth
 * sign-in, never a managed API key) or a principal holding
 * `artifact:manage:any`. Refuse to go on with any other operator.
 */
function requireDispatchSender(operator: SessionPrincipal): void {
  const directHuman = operator.kind === "human" && operator.authorizedByPrincipalId === null;
  if (directHuman || operator.capabilities.includes("artifact:manage:any")) return;
  throw new Error(
    `The operator credential cannot send dispatches: requireDispatchSend admits a direct human sign-in or artifact:manage:any, ` +
      `and this is a ${operator.kind} API-key principal with [${operator.capabilities.join(", ")}]. ` +
      "Sign the operator profile in through the browser (artifactserver auth login <origin>) or use a key that holds artifact:manage:any.",
  );
}

/** The agent side must be its own service principal with exactly the agreed capabilities. */
function requireAgentPrincipal(agent: SessionPrincipal, operator: SessionPrincipal): void {
  if (agent.id === operator.id) {
    throw new Error("The agent profile resolved to the operator's own principal; it needs the dedicated service key.");
  }
  const granted = agent.capabilities.toSorted();
  if (agent.kind !== "service" || granted.join(",") !== agentCapabilities.join(",")) {
    throw new Error(
      `The agent principal must be a service key not bound to a member, holding only ${agentCapabilities.join(" and ")}; ` +
        `it is a ${agent.kind} principal with [${granted.join(", ")}].`,
    );
  }
}

async function sendDispatch(operator: ApiTarget, thread: DeliveredThread, agentId: string, kind: string): Promise<string> {
  const response = await fetch(`${operator.server.baseUrl}/api/v1/agent-dispatches?projectId=${thread.projectId}`, {
    body: JSON.stringify({agentId, threadIds: [thread.threadId]}),
    headers: apiHeaders(operator.installation, `hosted-dsn-011-${kind}-${thread.runTag}`),
    method: "POST",
  });
  expect(response.status, `Sending the ${kind} dispatch: ${(await response.clone().text()).slice(0, 300)}`).toBe(201);
  return dispatchSchema.parse(await response.json()).dispatch.id;
}

async function dispatchState(operator: ApiTarget, projectId: string, dispatchId: string): Promise<string> {
  const answer = await getHostedJson(operator, `/api/v1/agent-dispatches/${dispatchId}?projectId=${projectId}`, dispatchSchema);
  return answer.dispatch.state;
}

/** Reopen the thread as a reviewer does, which releases a delivered dispatch's marker. */
async function reopenThread(operator: ApiTarget, thread: DeliveredThread): Promise<void> {
  const response = await fetch(
    `${operator.server.baseUrl}/api/v1/artifacts/${thread.artifactId}/comments/${thread.threadId}?projectId=${thread.projectId}`,
    {
      body: JSON.stringify({state: "open"}),
      headers: {Authorization: `Bearer ${operator.installation.apiToken}`, "Content-Type": "application/json"},
      method: "PATCH",
    },
  );
  expect(response.status, `Reopening the thread: ${(await response.clone().text()).slice(0, 300)}`).toBe(200);
}

/** Leave nothing queued or claimed behind a failed run; a settled dispatch refuses the cancel. */
async function cancelUnsettled(operator: ApiTarget, projectId: string, dispatchId: string): Promise<void> {
  if (await dispatchState(operator, projectId, dispatchId) === "delivered") return;
  await fetch(`${operator.server.baseUrl}/api/v1/agent-dispatches/${dispatchId}/cancel?projectId=${projectId}`, {
    headers: {Authorization: `Bearer ${operator.installation.apiToken}`},
    method: "POST",
  });
}

async function disconnectAgent(agent: ApiTarget, agentId: string): Promise<void> {
  const response = await fetch(`${agent.server.baseUrl}/api/v1/agents/${agentId}/disconnect`, {
    headers: {Authorization: `Bearer ${agent.installation.apiToken}`},
    method: "POST",
  });
  expect(response.status, "Disconnecting the mailbox agent").toBe(204);
}

/** The line that follows an item's header, where each render puts the location. */
function lineAfterFirstItem(message: string): string | undefined {
  const lines = message.split("\n");
  return lines[lines.findIndex((line) => line.startsWith("1. [")) + 1];
}

/**
 * Deliver one thread to a mailbox and a native bridge of the agent principal,
 * and prove both renders carry the anchor's location line byte for byte. Both
 * dispatches end `delivered` and both agents are disconnected afterwards, even
 * when an assertion fails.
 */
export async function proveBundleLocationParity(
  operator: ApiTarget,
  agent: ApiTarget,
  thread: DeliveredThread,
): Promise<BundleDeliveryProof> {
  const [operatorPrincipal, agentPrincipal] = await Promise.all([sessionPrincipal(operator), sessionPrincipal(agent)]);
  requireDispatchSender(operatorPrincipal);
  requireAgentPrincipal(agentPrincipal, operatorPrincipal);

  const stored = await getHostedJson(
    operator,
    `/api/v1/artifacts/${thread.artifactId}/comments/${thread.threadId}?projectId=${thread.projectId}`,
    threadSchema,
  );
  const fromServer = serverAnchorSchema.safeParse(stored.thread.anchor);
  const fromPackage = packageAnchorSchema.safeParse(stored.thread.anchor);
  const location = fromServer.success ? serverLine(fromServer.data.view) : null;
  if (location === null) throw new Error("The comment's anchor has no view block the renderers can read, so no location line to compare.");
  expect(fromPackage.success ? packageLine(fromPackage.data.view) : null, "The bridge package reads the anchor's location differently")
    .toBe(location);

  const mailboxName = `Hosted qualification mailbox ${thread.runTag}`;
  const nativeMessages: string[] = [];
  const bridgeLog: string[] = [];
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "hosted-qualification-bridge-"));
  const dispatchIds: string[] = [];
  let mailboxAgentId: string | null = null;
  let bridge: BridgeHandle | null = null;
  try {
    mailboxAgentId = (await callHostedTool(agent, "dispatch_inbox", {agentName: mailboxName, operation: "list"}, mailboxSchema)).agent.id;
    const native = startBridge({
      agentSessionId: null,
      credentials: {origin: agent.server.baseUrl, token: agent.installation.apiToken},
      displayName: `Hosted qualification bridge ${thread.runTag}`,
      fetchImplementation: fetch,
      host: {
        isCompacting: () => false,
        notify: () => undefined,
        sendUserMessage: (text) => {
          nativeMessages.push(text);
        },
      },
      hostname: os.hostname(),
      kind: "hosted-qualification",
      log: (message) => bridgeLog.push(message),
      waitSeconds: 5,
      // A scratch directory gives the bridge its own connection key, so it never reclaims another row.
      workingDirectory,
    });
    bridge = native;
    await expect.poll(() => native.agentId(), {message: "The bridge never registered", timeout: 30_000})
      .not.toBeNull();
    const nativeAgentId = native.agentId() ?? "";

    // A thread sits in one dispatch at a time, and a delivered dispatch keeps
    // its marker until the thread is reopened. So the mailbox goes first, the
    // reviewer's reopen releases the spent marker, and the bridge goes second.
    const mailboxDispatch = await sendDispatch(operator, thread, mailboxAgentId, "mailbox");
    dispatchIds.push(mailboxDispatch);
    const claim = await callHostedTool(agent, "dispatch_inbox", {agentName: mailboxName, operation: "claim"}, claimSchema);
    expect(claim.claimed?.dispatchId, "The mailbox claimed another dispatch first").toBe(mailboxDispatch);
    const mailbox = claim.claimed?.message ?? "";
    const reported = await callHostedTool(agent, "dispatch_inbox", {dispatchId: mailboxDispatch, operation: "delivered"}, reportSchema);
    expect(reported.report?.state).toBe("delivered");

    await reopenThread(operator, thread);
    const nativeDispatch = await sendDispatch(operator, thread, nativeAgentId, "native");
    dispatchIds.push(nativeDispatch);
    await expect.poll(() => nativeMessages.length, {message: "The bridge delivered nothing", timeout: 60_000})
      .toBe(1);
    const nativeRender = nativeMessages[0] ?? "";
    await expect.poll(() => dispatchState(operator, thread.projectId, nativeDispatch), {timeout: 30_000}).toBe("delivered");
    expect(await dispatchState(operator, thread.projectId, mailboxDispatch)).toBe("delivered");

    // Byte for byte: the same line in the same place, and the bundles agree
    // everywhere except the two lines naming each surface's comment tools.
    expect(lineAfterFirstItem(mailbox)).toBe(`   ${location}`);
    expect(lineAfterFirstItem(nativeRender)).toBe(`   ${location}`);
    expect(mailbox.split("\n").slice(0, -2)).toEqual(nativeRender.split("\n").slice(0, -2));
    return {location, mailbox, native: nativeRender};
  } catch (error) {
    // The bridge contains its own failures; its log is the only record of them.
    if (bridgeLog.length === 0) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nBridge log:\n${bridgeLog.join("\n")}`, {cause: error});
  } finally {
    // Each step is independent, so one failure never strands the others.
    await Promise.allSettled([
      bridge?.stop({disconnect: true}),
      mailboxAgentId === null ? undefined : disconnectAgent(agent, mailboxAgentId),
      ...dispatchIds.map((dispatchId) => cancelUnsettled(operator, thread.projectId, dispatchId)),
    ]);
    await rm(workingDirectory, {force: true, recursive: true});
  }
}
