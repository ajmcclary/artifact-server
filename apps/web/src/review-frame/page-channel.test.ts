import {describe, expect, test} from "vitest";

import {createPageChannel} from "./page-channel.ts";
import type {FrameToPageMessage, PageMessage, PageState} from "./page-protocol.ts";

function harness() {
  const posted: FrameToPageMessage[] = [];
  const unprompted: PageState[] = [];
  const timers: {callback: () => void; at: number; cancelled: boolean}[] = [];
  let now = 0;
  let next = 0;
  const channel = createPageChannel({
    nextRequestId: () => `r${++next}`,
    onUnpromptedState: (state) => unprompted.push(state),
    post: (message) => posted.push(message),
    schedule: (callback, milliseconds) => {
      const timer = {at: now + milliseconds, callback, cancelled: false};
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const advance = (milliseconds: number) => {
    now += milliseconds;
    for (const timer of timers.filter((candidate) => !candidate.cancelled && candidate.at <= now)) {
      timer.cancelled = true;
      timer.callback();
    }
  };
  return {advance, channel, posted, unprompted};
}

const state = (scenarioId: string | null): PageState => ({
  direction: "ltr",
  locale: null,
  pageVersion: 1,
  props: {scenario: scenarioId ?? "none"},
  scenarioId,
  theme: "light",
  viewport: {height: 900, width: 1440},
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const hello: PageMessage = {capabilities: ["capture", "regions", "restore"], pageVersion: 3, type: "as-page-hello"};

describe("page channel", () => {
  test("negotiates the lower version and restores after hello", async () => {
    const {channel, posted} = harness();
    const restoring = channel.restore({scenario: "5"}, "5");
    channel.receive(hello);
    await flush();
    expect(posted[0]).toEqual({pageVersion: 1, type: "as-page-welcome"});
    expect(posted[1]).toEqual({props: {scenario: "5"}, requestId: "r1", type: "as-page-restore"});
    channel.receive({ok: true, requestId: "r1", state: state("5"), type: "as-page-restored"});
    expect(await restoring).toEqual({outcome: "restored", state: state("5")});
  });

  test("reports a page that confirms another scenario as a mismatch", async () => {
    const {channel} = harness();
    channel.receive(hello);
    const restoring = channel.restore({scenario: "5"}, "5");
    await flush();
    channel.receive({ok: true, requestId: "r1", state: state("6"), type: "as-page-restored"});
    expect(await restoring).toEqual({outcome: "failed", reason: "scenario-mismatch", state: state("6")});
  });

  test("reports no adapter after the hello wait that follows the page's load", async () => {
    const {advance, channel} = harness();
    const restoring = channel.restore({scenario: "5"}, "5");
    channel.documentLoaded();
    advance(3_000);
    expect(await restoring).toEqual({outcome: "unsupported", reason: "no-adapter"});
    expect(channel.supports()).toBe(false);
    expect(await channel.findRegions(["a"])).toBeNull();
  });

  test("times out a restore the page never answers", async () => {
    const {advance, channel} = harness();
    channel.receive(hello);
    const restoring = channel.restore({scenario: "5"}, "5");
    await flush();
    advance(6_000);
    expect(await restoring).toEqual({outcome: "failed", reason: "timeout", state: null});
  });

  test("ignores replies to unknown requests and relays unprompted state", async () => {
    const {channel, unprompted} = harness();
    channel.receive(hello);
    channel.receive({ok: true, requestId: "never-asked", state: state("5"), type: "as-page-restored"});
    channel.receive({region: null, reason: "none", requestId: "never-asked", type: "as-page-region"});
    channel.receive({requestId: null, state: state("6"), type: "as-page-state"});
    expect(unprompted).toEqual([state("6")]);
  });

  test("forgets the old document on reset", async () => {
    const {advance, channel} = harness();
    channel.receive(hello);
    const before = channel.capture(["scenario"]);
    await flush();
    channel.reset();
    channel.receive({requestId: "r1", state: state("5"), type: "as-page-state"});
    expect(await before).toBeNull();
    expect(channel.supports()).toBeNull();
    channel.documentLoaded();
    advance(3_000);
    expect(channel.supports()).toBe(false);
  });

  test("DSN-008-B: a cold page that is still loading its runtime gets its hello window after load", async () => {
    const {advance, channel, posted} = harness();
    const restoring = channel.restore({scenario: "5"}, "5");
    // A cold cache: React and a large bundle take longer than the hello window to arrive.
    advance(9_000);
    expect(channel.supports()).toBeNull();
    channel.documentLoaded();
    advance(1_000);
    channel.receive(hello);
    await flush();
    expect(posted[1]).toEqual({props: {scenario: "5"}, requestId: "r1", type: "as-page-restore"});
    channel.receive({ok: true, requestId: "r1", state: state("5"), type: "as-page-restored"});
    expect(await restoring).toEqual({outcome: "restored", state: state("5")});
  });

  test("DSN-008-F: a page whose document never finishes loading is reported without an adapter", async () => {
    const {advance, channel} = harness();
    const restoring = channel.restore({scenario: "5"}, "5");
    advance(20_000);
    expect(await restoring).toEqual({outcome: "unsupported", reason: "no-adapter"});
  });

  test("DSN-008-F: a restore superseded by a later one is superseded, not a timeout", async () => {
    const {channel} = harness();
    channel.receive(hello);
    const first = channel.restore({scenario: "6"}, "6");
    await flush();
    const second = channel.restore({scenario: "5"}, "5");
    await flush();
    // Design's pageVersion 1 adapter ends the earlier restore with reason "timeout".
    channel.receive({ok: false, reason: "timeout", requestId: "r1", state: state("1"), type: "as-page-restored"});
    channel.receive({ok: true, requestId: "r2", state: state("5"), type: "as-page-restored"});
    expect(await first).toEqual({outcome: "superseded"});
    expect(await second).toEqual({outcome: "restored", state: state("5")});
  });

  test("DSN-008-F: an adapter's own superseded reason is never a failure", async () => {
    const {channel} = harness();
    channel.receive(hello);
    const only = channel.restore({scenario: "6"}, "6");
    await flush();
    channel.receive({ok: false, reason: "superseded", requestId: "r1", state: state("1"), type: "as-page-restored"});
    expect(await only).toEqual({outcome: "superseded"});
  });

  test("answers region queries", async () => {
    const {channel} = harness();
    channel.receive(hello);
    const at = channel.regionAt("label[data-review-region=\"a.b\"]");
    const find = channel.findRegions(["a.b", "gone"]);
    await flush();
    channel.receive({region: {label: "Minimum length", regionId: "a.b", tagName: "label"}, requestId: "r1", type: "as-page-region"});
    channel.receive({requestId: "r2", results: [{count: 1, regionId: "a.b", tagName: "label"}, {count: 0, regionId: "gone", tagName: null}], type: "as-page-regions"});
    expect(await at).toEqual({region: {label: "Minimum length", regionId: "a.b", tagName: "label"}});
    expect(await find).toEqual(new Map([["a.b", {count: 1, tagName: "label"}], ["gone", {count: 0, tagName: null}]]));
  });
});

describe("a late adapter", () => {
  test("upgrades the session when hello arrives after the wait", () => {
    const posted: FrameToPageMessage[] = [];
    let late = 0;
    const scheduled: (() => void)[] = [];
    const channel = createPageChannel({
      onLateHello: () => {
        late += 1;
      },
      onUnpromptedState: () => undefined,
      post: (message) => posted.push(message),
      schedule: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      },
    });
    for (const callback of scheduled) callback();
    expect(channel.supports()).toBe(false);
    channel.receive(hello);
    expect(channel.supports()).toBe(true);
    expect(posted).toEqual([{pageVersion: 1, type: "as-page-welcome"}]);
    expect(late).toBe(1);
  });
});
