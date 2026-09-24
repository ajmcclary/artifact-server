import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  type BridgeHandle,
  type BridgeTimers,
  type FollowUpDelivery,
  type HostPort,
  startBridge,
} from "@plannotator/agent-bridge";

import {
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  dispatchPageSchema,
  failureSchema,
  MutableClock,
  type RegisteredAgent,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const leaseMilliseconds = 5 * 60 * 1_000;

/** A fake host port that records every notice and injected message. */
class RecordingHostPort implements HostPort {
  readonly messages: {text: string; delivery: FollowUpDelivery}[] = [];
  readonly notices: string[] = [];

  isCompacting(): boolean {
    return false;
  }

  notify(message: string): void {
    this.notices.push(message);
  }

  sendUserMessage(text: string, delivery: FollowUpDelivery): void {
    this.messages.push({delivery, text});
  }
}

async function eventually<Value>(
  probe: () => Promise<Value | null>,
  timeoutMilliseconds = 10_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error("The awaited condition was not reached in time.");
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const instantTimers: BridgeTimers = {
  random: () => 0.5,
  sleep: () => Promise.resolve(),
};

/** Wraps fetch so the first POST to a `/delivered` endpoint is lost. */
function fetchThatLosesFirstDeliveredReport() {
  let lost = 0;
  const wrapped: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (
      init?.method === "POST" &&
      url.includes("/delivered")
    ) {
      if (lost === 0) {
        lost = 1;
        return Promise.reject(
          new Error("The delivered report was lost on the network."),
        );
      }
    }
    return fetch(input, init);
  };
  return {
    fetch: wrapped,
    lostReports: () => lost,
  };
}

describe("dispatch claim lease", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let projectId: string;
  let agent: RegisteredAgent;
  let bridges: BridgeHandle[];

  beforeEach(async () => {
    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Lease</title>",
      idempotencyKey: "dispatch-lease-publish-artifact",
      name: "Lease report",
    })).body;
    projectId = published.artifact.projectId;
    agent = await client.registerAgent({
      agentSessionId: "pi-session-lease",
      connectionKey: "dispatch-lease-connection-key",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    bridges = [];
  });

  afterEach(async () => {
    for (const bridge of bridges) {
      // eslint-disable-next-line no-await-in-loop
      await bridge.stop();
    }
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-006-B: an expired lease returns the bundle to the queue and the restarted agent claims it again", async () => {
    expect.hasAssertions();
    const threadId = await openThread("lease-behavior");
    const dispatchId = await queueBundle(threadId, "behavior");

    const claimed = dispatchEnvelopeSchema.parse(
      await (await client.claim(agent.id)).json(),
    ).dispatch;
    expect(claimed).toMatchObject({id: dispatchId, state: "claimed"});
    const firstClaimedAt = claimed.claimedAt;
    expect(claimed.leaseExpiresAt).toBe(
      new Date(clock.now().getTime() + leaseMilliseconds).toISOString(),
    );

    // The lease holds for its whole term: nothing reclaims it early.
    clock.advance(leaseMilliseconds - 1_000);
    expect((await client.claim(agent.id)).status).toBe(204);
    expect(await readDispatch(dispatchId)).toMatchObject({
      claimedAt: firstClaimedAt,
      state: "claimed",
    });

    // The claimer died without reporting: the lease expires and the next read
    // returns the bundle to the queue instead of losing the work.
    clock.advance(2_000);
    const reclaimable = await readDispatch(dispatchId);
    expect(reclaimable).toMatchObject({
      claimedAt: null,
      deliveredAt: null,
      failedAt: null,
      leaseExpiresAt: null,
      state: "queued",
    });
    const listed = dispatchPageSchema.parse(
      await (await client.listDispatches(projectId, "&state=queued")).json(),
    );
    expect(listed.items.map((dispatch) => dispatch.id)).toEqual([dispatchId]);
    // A queued redelivery is still a live send: the thread stays off screen.
    expect(await client.listThreadIds(published)).toEqual([]);

    // The agent restarts under the same connection key and claims it again.
    const restarted = await client.registerAgent({
      agentSessionId: "pi-session-lease-restarted",
      connectionKey: "dispatch-lease-connection-key",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    expect(restarted.id).toBe(agent.id);
    const redelivered = dispatchEnvelopeSchema.parse(
      await (await client.claim(restarted.id)).json(),
    ).dispatch;
    expect(redelivered).toMatchObject({id: dispatchId, state: "claimed"});
    expect(redelivered.claimedAt).toBe(clock.now().toISOString());
    expect(redelivered.leaseExpiresAt).toBe(
      new Date(clock.now().getTime() + leaseMilliseconds).toISOString(),
    );

    // Redelivered exactly once in effect: the report completes it and no
    // further poll hands the same bundle out again.
    expect((await client.reportDelivered(dispatchId, agent.id)).status)
      .toBe(200);
    clock.advance(leaseMilliseconds + 60_000);
    expect((await client.claim(agent.id)).status).toBe(204);
    expect(await readDispatch(dispatchId)).toMatchObject({state: "delivered"});
  });

  test("DSP-006-F: a claimer that returns after its lease expired cannot report, and a reclaim never leaves two claims active", async () => {
    expect.hasAssertions();
    const threadId = await openThread("lease-failure");
    const dispatchId = await queueBundle(threadId, "failure");

    expect((await client.claim(agent.id)).status).toBe(200);
    clock.advance(leaseMilliseconds + 1_000);
    expect(await readDispatch(dispatchId)).toMatchObject({state: "queued"});

    // The stale claimer comes back and reports on a bundle it no longer holds.
    const lateDelivery = await client.reportDelivered(dispatchId, agent.id);
    expect(lateDelivery.status).toBe(409);
    expect(failureSchema.parse(await lateDelivery.json()).error.code)
      .toBe("DISPATCH_STATE_CONFLICT");
    const lateFailure = await client.reportFailed(
      dispatchId,
      agent.id,
      "A stale claimer must not close this bundle.",
    );
    expect(lateFailure.status).toBe(409);
    expect(failureSchema.parse(await lateFailure.json()).error.code)
      .toBe("DISPATCH_STATE_CONFLICT");
    expect(await readDispatch(dispatchId)).toMatchObject({
      deliveredAt: null,
      failedAt: null,
      failureReason: null,
      state: "queued",
    });

    // Two polls racing over the reclaim: one claim, never two.
    const [raceOne, raceTwo] = await Promise.all([
      client.claim(agent.id),
      client.claim(agent.id),
    ]);
    expect([raceOne.status, raceTwo.status].toSorted((left, right) =>
      left - right
    )).toEqual([200, 204]);
    const winner = raceOne.status === 200 ? raceOne : raceTwo;
    const reclaimed = dispatchEnvelopeSchema.parse(await winner.json())
      .dispatch;
    expect(reclaimed).toMatchObject({id: dispatchId, state: "claimed"});
    expect((await client.claim(agent.id)).status).toBe(204);

    // The reclaiming poll owns the only active claim, and it can report.
    expect((await client.reportDelivered(dispatchId, agent.id)).status)
      .toBe(200);
    const afterDelivery = await readDispatch(dispatchId);
    expect(afterDelivery).toMatchObject({state: "delivered"});
    expect(afterDelivery.claimedAt).toBe(reclaimed.claimedAt);
    expect(Date.parse(afterDelivery.deliveredAt ?? ""))
      .toBeGreaterThanOrEqual(Date.parse(reclaimed.claimedAt ?? ""));
  });

  test("a lost delivered report redelivers the bundle without marking it failed", async () => {
    expect.hasAssertions();
    const host = new RecordingHostPort();
    const {fetch: losingFetch, lostReports} =
      fetchThatLosesFirstDeliveredReport();
    const bridge = startBridge({
      agentSessionId: "pi-session-lost-ack",
      credentials: {origin: server.baseUrl, token: installation.apiToken},
      displayName: "lost-ack-host",
      fetchImplementation: losingFetch,
      host,
      hostname: "lost-ack-host",
      kind: "pi",
      timers: instantTimers,
      waitSeconds: 1,
      workingDirectory: "/work/lost-ack-host",
    });
    bridges.push(bridge);

    const agentId = await eventually(() => Promise.resolve(bridge.agentId()));
    const thread = await client.openThread(
      published,
      "Update the heading.",
      "lost-ack-comment-thread",
    );
    const sent = await client.sendDispatch({
      agentId,
      idempotencyKey: "lost-ack-dispatch",
      projectId,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;

    // The bridge claims and delivers to the fake host, but the delivered
    // report is lost on the network.
    await eventually(() =>
      Promise.resolve(host.messages.length === 1 ? true : null)
    );
    expect(lostReports()).toBe(1);
    expect(await readDispatch(dispatchId)).toMatchObject({state: "claimed"});

    // After the lease expires the server requeues the bundle. The bridge
    // claims it again and redelivers; the duplicate host admission is
    // tolerated and the second delivered report succeeds.
    clock.advance(leaseMilliseconds + 1_000);
    await eventually(() =>
      Promise.resolve(host.messages.length === 2 ? true : null)
    );
    expect(lostReports()).toBe(1);
    const final = await readDispatch(dispatchId);
    expect(final).toMatchObject({
      failedAt: null,
      state: "delivered",
    });
  });

  test("duplicate lease delivery is tolerated and reported honestly", async () => {
    expect.hasAssertions();
    const host = new RecordingHostPort();
    const {fetch: losingFetch, lostReports} =
      fetchThatLosesFirstDeliveredReport();
    const bridge = startBridge({
      agentSessionId: "pi-session-duplicate-lease",
      credentials: {origin: server.baseUrl, token: installation.apiToken},
      displayName: "duplicate-lease-host",
      fetchImplementation: losingFetch,
      host,
      hostname: "duplicate-lease-host",
      kind: "pi",
      timers: instantTimers,
      waitSeconds: 1,
      workingDirectory: "/work/duplicate-lease-host",
    });
    bridges.push(bridge);

    const agentId = await eventually(() => Promise.resolve(bridge.agentId()));
    const thread = await client.openThread(
      published,
      "Update the heading.",
      "duplicate-lease-thread",
    );
    const sent = await client.sendDispatch({
      agentId,
      idempotencyKey: "duplicate-lease-dispatch",
      projectId,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;

    await eventually(() =>
      Promise.resolve(host.messages.length === 1 ? true : null)
    );
    const firstMessage = host.messages[0]?.text ?? "";
    expect(lostReports()).toBe(1);

    clock.advance(leaseMilliseconds + 1_000);
    await eventually(() =>
      Promise.resolve(host.messages.length === 2 ? true : null)
    );
    const secondMessage = host.messages[1]?.text ?? "";
    expect(secondMessage).toBe(firstMessage);
    expect(lostReports()).toBe(1);
    expect(await readDispatch(dispatchId)).toMatchObject({
      failedAt: null,
      state: "delivered",
    });
  });

  async function openThread(label: string): Promise<string> {
    const thread = await client.openThread(
      published,
      `An annotation sent under the ${label} lease.`,
      `dispatch-lease-thread-${label}`,
    );
    return thread.id;
  }

  async function queueBundle(
    threadId: string,
    label: string,
  ): Promise<string> {
    const response = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: `dispatch-lease-send-bundle-${label}`,
      projectId,
      threadIds: [threadId],
    });
    expect(response.status).toBe(201);
    return dispatchCreationSchema.parse(await response.json()).dispatch.id;
  }

  async function readDispatch(dispatchId: string) {
    const response = await client.getDispatch(dispatchId, projectId);
    expect(response.status).toBe(200);
    return dispatchEnvelopeSchema.parse(await response.json()).dispatch;
  }
});
