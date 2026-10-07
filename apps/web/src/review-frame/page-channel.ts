import {
  pageProtocolVersion,
  type FrameToPageMessage,
  type PageMessage,
  type PageProps,
  type PageRegion,
  type PageState,
} from "./page-protocol.ts";

export type RestoreResult =
  | {readonly outcome: "restored"; readonly state: PageState}
  | {
    readonly outcome: "failed";
    readonly reason: "adapter-error" | "scenario-mismatch" | "timeout";
    readonly state: PageState | null;
  }
  | {readonly outcome: "unsupported"; readonly reason: "no-adapter"};

export type RegionAnswer =
  | {readonly region: PageRegion}
  | {readonly reason: "ambiguous" | "none" | "unsupported"; readonly region: null};

export type RegionCounts = ReadonlyMap<string, {readonly count: number; readonly tagName: string | null}>;

export interface PageChannel {
  readonly capture: (props: readonly string[]) => Promise<PageState | null>;
  readonly findRegions: (regionIds: readonly string[]) => Promise<RegionCounts | null>;
  readonly receive: (message: PageMessage) => void;
  readonly regionAt: (selector: string) => Promise<RegionAnswer>;
  /** The sandbox document was replaced: forget its handshake and pending replies. */
  readonly reset: () => void;
  readonly restore: (props: PageProps, scenarioId: string) => Promise<RestoreResult>;
  /** `null` while waiting for hello, then whether this page has an adapter. */
  readonly supports: () => boolean | null;
}

export interface PageChannelOptions {
  readonly helloTimeoutMilliseconds?: number;
  readonly nextRequestId?: () => string;
  /** An adapter said hello after the wait had already reported none. */
  readonly onLateHello?: () => void;
  readonly onUnpromptedState: (state: PageState) => void;
  readonly post: (message: FrameToPageMessage) => void;
  readonly replyTimeoutMilliseconds?: number;
  readonly schedule?: (callback: () => void, milliseconds: number) => () => void;
}

type Pending = (message: PageMessage | null) => void;

const defaultSchedule = (callback: () => void, milliseconds: number): (() => void) => {
  const handle = setTimeout(callback, milliseconds);
  return () => clearTimeout(handle);
};

/** One page adapter session inside the review frame's sandbox. */
export function createPageChannel(options: PageChannelOptions): PageChannel {
  const schedule = options.schedule ?? defaultSchedule;
  const nextRequestId = options.nextRequestId ?? (() => crypto.randomUUID());
  const helloTimeout = options.helloTimeoutMilliseconds ?? 3_000;
  const replyTimeout = options.replyTimeoutMilliseconds ?? 6_000;
  let supported: boolean | null = null;
  let waiters: ((supported: boolean) => void)[] = [];
  let pending = new Map<string, Pending>();
  let cancelHelloWait = schedule(() => settleHello(false), helloTimeout);

  function settleHello(value: boolean): void {
    if (supported !== null) return;
    supported = value;
    cancelHelloWait();
    const released = waiters;
    waiters = [];
    for (const waiter of released) waiter(value);
  }

  function ready(): Promise<boolean> {
    if (supported !== null) return Promise.resolve(supported);
    return new Promise((resolve) => waiters.push(resolve));
  }

  /** Send one request and wait for its reply, or `null` on timeout or reset. */
  async function ask(build: (requestId: string) => FrameToPageMessage): Promise<PageMessage | null> {
    if (!await ready()) return null;
    const requestId = nextRequestId();
    const owner = pending;
    return new Promise((resolve) => {
      const cancel = schedule(() => {
        if (owner.delete(requestId)) resolve(null);
      }, replyTimeout);
      owner.set(requestId, (message) => {
        cancel();
        resolve(message);
      });
      options.post(build(requestId));
    });
  }

  return {
    capture: async (props) => {
      const reply = await ask((requestId) => ({props, requestId, type: "as-page-capture"}));
      return reply?.type === "as-page-state" ? reply.state : null;
    },
    findRegions: async (regionIds) => {
      const reply = await ask((requestId) => ({regionIds, requestId, type: "as-page-region-find"}));
      if (reply?.type !== "as-page-regions") return null;
      return new Map(reply.results.map((result) => [result.regionId, {count: result.count, tagName: result.tagName}]));
    },
    receive: (message) => {
      if (message.type === "as-page-hello") {
        if (supported === true) return;
        options.post({pageVersion: Math.min(message.pageVersion, pageProtocolVersion), type: "as-page-welcome"});
        if (supported === null) {
          settleHello(true);
          return;
        }
        // A slow page (one that loads its own runtime, say) still gets its adapter.
        supported = true;
        options.onLateHello?.();
        return;
      }
      if (message.type === "as-page-state" && message.requestId === null) {
        options.onUnpromptedState(message.state);
        return;
      }
      const requestId = message.requestId;
      if (requestId === null) return;
      const resolve = pending.get(requestId);
      if (resolve === undefined) return;
      pending.delete(requestId);
      resolve(message);
    },
    regionAt: async (selector) => {
      const reply = await ask((requestId) => ({requestId, selector, type: "as-page-region-at"}));
      if (reply?.type !== "as-page-region") return {reason: supported === false ? "unsupported" : "none", region: null};
      return reply.region === null ? {reason: reply.reason ?? "none", region: null} : {region: reply.region};
    },
    reset: () => {
      const abandoned = pending;
      pending = new Map();
      for (const resolve of abandoned.values()) resolve(null);
      const blocked = waiters;
      waiters = [];
      supported = null;
      cancelHelloWait();
      cancelHelloWait = schedule(() => settleHello(false), helloTimeout);
      // Callers waiting on the old document's hello must wait for the new one.
      waiters.push(...blocked);
    },
    restore: async (props, scenarioId) => {
      if (!await ready()) return {outcome: "unsupported", reason: "no-adapter"};
      const reply = await ask((requestId) => ({props, requestId, type: "as-page-restore"}));
      if (reply === null) return {outcome: "failed", reason: "timeout", state: null};
      if (reply.type !== "as-page-restored") return {outcome: "failed", reason: "adapter-error", state: null};
      if (!reply.ok) return {outcome: "failed", reason: reply.reason ?? "adapter-error", state: reply.state};
      if (reply.state?.scenarioId !== scenarioId) {
        return {outcome: "failed", reason: "scenario-mismatch", state: reply.state};
      }
      return {outcome: "restored", state: reply.state};
    },
    supports: () => supported,
  };
}
