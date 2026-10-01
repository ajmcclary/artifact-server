import {useEffect, useRef, useState, type CSSProperties} from "react";

import {api} from "@/api/client";
import {createRequestLimiter} from "@/lib/request-limiter";
import {frameMessageSchema, reviewAnnotationSchema, reviewProtocolVersion, type HostMessage} from "@/review-frame/protocol";
import {arkcaseFrameTokens, frameIsLight} from "@/theme/frame-theme";

import type {FeedEvent} from "./activity-adapter";
import {thumbnailPlan} from "./thumbnail-plan";

/** At most four conversation screens load at once, across the whole feed. */
const loadSlot = createRequestLimiter(4);
const frameReadyTimeoutMilliseconds = 10_000;
const frameStyle = {border: 0, display: "block", height: 500, width: 800} satisfies CSSProperties;
const tileStyle = {alignItems: "center", background: "var(--surface-muted, #f1f5f7)", color: "var(--text-secondary, #5a6268)",
  display: "flex", fontSize: 160, height: 500, justifyContent: "center", width: 800} satisfies CSSProperties;

type Loaded = {readonly baseHref: string; readonly entryPath: string; readonly html: string};
type ScreenState = {readonly kind: "idle" | "tile"; readonly reason: string} | {readonly kind: "frame"; readonly loaded: Loaded};

const rememberedScreens = 200;
const leaseMarginMilliseconds = 60_000;
/**
 * Screens already read in this tab, until their lease nears expiry. The feed's conversation
 * header re-mounts as it docks and undocks, and a re-mounted thumbnail must not lease again.
 */
const loadedScreens = new Map<string, {readonly state: ScreenState; readonly until: number}>();

function rememberScreen(key: string, state: ScreenState, until: number): void {
  loadedScreens.delete(key);
  loadedScreens.set(key, {state, until});
  const oldest = loadedScreens.keys().next().value;
  if (loadedScreens.size > rememberedScreens && oldest !== undefined) loadedScreens.delete(oldest);
}

function knownScreen(key: string | null): ScreenState | null {
  const known = key === null ? undefined : loadedScreens.get(key);
  return known === undefined || known.until <= Date.now() ? null : known.state;
}

/** The file-type tile shown before loading, for non-HTML entries, unplaceable anchors and failures. */
function FileTile({reason}: {readonly reason: string}) {
  return <div data-thumbnail="tile" data-thumbnail-reason={reason} style={tileStyle}><i aria-hidden="true" className="bi bi-file-earmark-richtext" /></div>;
}

export function ActivityThumbnail({event}: {readonly event: FeedEvent}) {
  const entry = event.entry;
  const thread = entry.thread;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const screenKey = thread === undefined || entry.artifact === null || entry.project === null
    ? null
    : JSON.stringify([entry.project.id, entry.artifact.id, thread.id, thread.versionId, thread.path, thread.anchor]);
  const [near, setNear] = useState(false);
  const [state, setState] = useState<ScreenState>(() => knownScreen(screenKey) ?? {kind: "idle", reason: "waiting"});

  useEffect(() => {
    const root = rootRef.current;
    if (root === null || near) return undefined;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) setNear(true);
    }, {rootMargin: "200px"});
    observer.observe(root);
    return () => observer.disconnect();
  }, [near]);

  // Load once per conversation screen: a refreshed or re-hydrated entry with the same version,
  // page and anchor keeps its frame instead of leasing and fetching again.
  const entryRef = useRef(entry);
  entryRef.current = entry;
  useEffect(() => {
    const current = entryRef.current;
    const screen = current.thread;
    const known = knownScreen(screenKey);
    if (known !== null) {
      setState(known);
      return undefined;
    }
    if (!near || screenKey === null || screen === undefined || current.artifact === null || current.project === null) return undefined;
    let live = true;
    // A cancelled load gives its slot back at once rather than holding it until the frame timeout.
    const released = Promise.withResolvers<undefined>();
    const projectId = current.project.id;
    const artifactId = current.artifact.id;
    const versionId = screen.versionId;
    void loadSlot(async () => {
      if (!live) return;
      const entryPath = screen.path ?? (await api.version(projectId, artifactId, versionId)).version.entryPath;
      if (!live) return;
      const plan = thumbnailPlan(current, entryPath);
      if (plan.kind === "tile") {
        const tile = {kind: "tile", reason: plan.reason} as const;
        rememberScreen(screenKey, tile, Number.POSITIVE_INFINITY);
        setState(tile);
        return;
      }
      const [html, lease] = await Promise.all([api.versionFile(projectId, artifactId, versionId, plan.path), api.previewLease(projectId, artifactId, versionId)]);
      // An exact-version lease only: any other version is never drawn as this conversation's screen.
      if (lease.versionId !== versionId) throw new Error("lease version mismatch");
      if (!live) return;
      const base = new URL(plan.path.split("/").map(encodeURIComponent).join("/"), lease.baseUrl);
      const frame = {kind: "frame", loaded: {baseHref: new URL(".", base).toString(), entryPath: plan.path, html}} as const;
      rememberScreen(screenKey, frame, Date.parse(lease.expiresAt) - leaseMarginMilliseconds);
      setState(frame);
      // Hold the slot until the frame has been initialised, gives up, or this load is cancelled.
      await Promise.race([
        released.promise,
        new Promise<void>((resolve) => {
          const done = (): void => resolve();
          setTimeout(done, frameReadyTimeoutMilliseconds);
          frameRef.current?.addEventListener("load", () => setTimeout(done, 500), {once: true});
        }),
      ]);
    }).catch(() => {
      if (live) setState({kind: "tile", reason: "failed"});
    });
    return () => {
      live = false;
      released.resolve(undefined);
    };
  }, [near, screenKey]);

  useEffect(() => {
    if (state.kind !== "frame" || thread === undefined) return undefined;
    const post = (message: HostMessage): void => frameRef.current?.contentWindow?.postMessage(message, window.location.origin);
    const onMessage = (message: MessageEvent<unknown>): void => {
      if (message.source !== frameRef.current?.contentWindow || message.origin !== window.location.origin) return;
      const parsed = frameMessageSchema.safeParse(message.data);
      if (!parsed.success) return;
      if (parsed.data.type === "as-review-ready") {
        // The wire anchor is untyped JSON; the frame's own schema decides what it can place.
        const annotation = reviewAnnotationSchema.parse({anchor: thread.anchor, body: thread.opener.body,
          state: thread.isResolved ? "resolved" : "open", threadId: thread.id});
        post({annotateModeActive: false, annotations: [annotation],
          baseHref: state.loaded.baseHref, entryPath: state.loaded.entryPath, html: state.loaded.html, isLight: frameIsLight(),
          readOnly: true, themeTokens: arkcaseFrameTokens(), type: "as-review-init", v: reviewProtocolVersion});
        post({threadId: thread.id, type: "as-review-focus", v: reviewProtocolVersion});
      }
      // The frame could not place this thread's anchor on the page: never show a misplaced pin.
      if (parsed.data.type === "as-review-unanchored" && parsed.data.threadIds.includes(thread.id)) {
        const tile = {kind: "tile", reason: "unanchored"} as const;
        if (screenKey !== null) rememberScreen(screenKey, tile, Number.POSITIVE_INFINITY);
        setState(tile);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [state, thread]);

  return (
    <div ref={rootRef} data-thumbnail-for={thread?.id}>
      {state.kind === "frame"
        ? <iframe data-thumbnail="frame" ref={frameRef} src="/review-frame" style={frameStyle} tabIndex={-1} title={`Screen of ${event.artifactName ?? "artifact"}`} />
        : <FileTile reason={state.reason} />}
    </div>
  );
}
