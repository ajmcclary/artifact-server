import {
  HtmlViewer,
  type Annotation,
  type ViewerHandle,
} from "@plannotator/ui/components/html-viewer";
import { useCallback, useEffect, useRef, useState } from "react";

import { withBaseHref } from "./base-href.ts";
import { createPageChannel, type PageChannel } from "./page-channel.ts";
import { pageMessageSchema } from "./page-protocol.ts";
import {
  hostMessageSchema,
  reviewAnchorFrom,
  reviewProtocolVersion,
  type FrameMessage,
  type ReviewAnnotation,
  type ReviewInit,
  type ReviewTheme,
  type UnanchoredReason,
} from "./protocol.ts";

interface ReviewSession {
  readonly annotateModeActive: boolean;
  readonly annotations: Annotation[];
  readonly entryPath: string;
  readonly html: string;
  readonly readOnly: boolean;
  readonly supportsAnnotateMode: boolean;
}

/** Project one host thread into the record the viewer paints and numbers. */
function toAnnotation(review: ReviewAnnotation): Annotation {
  const annotation: Annotation = {
    blockId: "",
    createdA: 0,
    endOffset: 0,
    id: review.threadId,
    originalText: review.anchor?.originalText ?? "",
    startOffset: 0,
    text: review.body,
    type: "COMMENT",
  };
  const anchor = review.anchor;
  if (anchor === null) return annotation;
  if (anchor.htmlAnchor !== null) annotation.htmlAnchor = anchor.htmlAnchor;
  if (anchor.htmlAdditionalTargets !== undefined) {
    annotation.htmlAdditionalTargets = anchor.htmlAdditionalTargets;
  }
  return annotation;
}

function sessionFrom(init: ReviewInit): ReviewSession {
  return {
    annotateModeActive: init.annotateModeActive ?? false,
    annotations: init.annotations.map(toAnnotation),
    entryPath: init.entryPath,
    html: withBaseHref(init.html, init.baseHref),
    readOnly: init.readOnly,
    supportsAnnotateMode: init.annotateModeActive !== undefined,
  };
}

/** Adopt the host's palette so the viewer chrome and the sandbox agree. */
function applyTheme(theme: ReviewInit | ReviewTheme): void {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.themeTokens)) {
    root.style.setProperty(token, value);
  }
  root.classList.toggle("light", theme.isLight);
}

/** The sandboxed artifact document's window, which only Plannotator creates. */
function pageWindow(): Window | null {
  return document.querySelector<HTMLIFrameElement>("iframe[srcdoc]")?.contentWindow ?? null;
}

/** A thread anchored to a region is placed by that region's own identity selector. */
function regionAnnotation(
  annotation: Annotation,
  regionId: string,
  tagName: string,
): Annotation {
  const point = annotation.htmlAnchor?.point;
  const selector = `${tagName}[data-review-region="${regionId}"]`;
  const placed: Annotation = {
    ...annotation,
    htmlAnchor: point === undefined ? {selector, tagName} : {point, selector, tagName},
  };
  delete placed.htmlAdditionalTargets;
  return placed;
}

/**
 * The review frame: a same-origin document whose only job is to host
 * `@plannotator/ui`'s sandboxed HTML annotation surface and relay its events
 * to the application shell. It holds no credential, makes no request, and
 * learns everything it renders from one validated `as-review-init` message.
 */
export function ReviewFrame(): React.ReactNode {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const paintedIdsRef = useRef<ReadonlySet<string>>(new Set<string>());
  const channelRef = useRef<PageChannel | null>(null);
  const capturePropsRef = useRef<readonly string[]>([]);
  const viewerUnanchoredRef = useRef<readonly string[]>([]);
  const regionFailuresRef = useRef<ReadonlyMap<string, UnanchoredReason>>(new Map());
  const annotationGenerationRef = useRef(0);

  const send = useCallback((message: FrameMessage): void => {
    window.parent.postMessage(message, window.location.origin);
  }, []);

  const reportUnanchored = useCallback((): void => {
    const failures = regionFailuresRef.current;
    const threadIds = [...new Set([...viewerUnanchoredRef.current, ...failures.keys()])];
    send(failures.size === 0
      ? {threadIds, type: "as-review-unanchored", v: reviewProtocolVersion}
      : {reasons: Object.fromEntries(failures), threadIds, type: "as-review-unanchored", v: reviewProtocolVersion});
  }, [send]);

  // Region anchors are placed only where the page reports exactly one element
  // carrying the region id; anything else is reported, never guessed.
  const applyAnnotations = useCallback(async (reviews: readonly ReviewAnnotation[]): Promise<Annotation[] | null> => {
    annotationGenerationRef.current += 1;
    const generation = annotationGenerationRef.current;
    const regionIds = [...new Set(reviews.flatMap((review) => review.anchor?.view?.regionId ?? []))];
    if (regionIds.length === 0) {
      regionFailuresRef.current = new Map();
      reportUnanchored();
      return reviews.map(toAnnotation);
    }
    const counts = await channelRef.current?.findRegions(regionIds.slice(0, 64)) ?? null;
    if (generation !== annotationGenerationRef.current) return null;
    const failures = new Map<string, UnanchoredReason>();
    const placed = reviews.flatMap((review) => {
      const regionId = review.anchor?.view?.regionId;
      const annotation = toAnnotation(review);
      if (regionId === undefined) return [annotation];
      const found = counts?.get(regionId);
      if (found !== undefined && found.count === 1 && found.tagName !== null) {
        return [regionAnnotation(annotation, regionId, found.tagName)];
      }
      failures.set(review.threadId, (found?.count ?? 0) > 1 ? "region-ambiguous" : "region-missing");
      return [];
    });
    regionFailuresRef.current = failures;
    reportUnanchored();
    return placed;
  }, [reportUnanchored]);

  const showAnnotations = useCallback((reviews: readonly ReviewAnnotation[]): void => {
    void (async () => {
      const annotations = await applyAnnotations(reviews);
      if (annotations === null) return;
      setSession((current) => current === null ? current : {...current, annotations});
    })();
  }, [applyAnnotations]);

  useEffect(() => {
    const channel = createPageChannel({
      onLateHello: () => {
        // The host already heard "no adapter": tell it what the page now shows.
        void (async () => {
          const state = await channel.capture(capturePropsRef.current);
          if (state !== null) {
            send({outcome: "restored", requestId: null, state, type: "as-review-view-state", v: reviewProtocolVersion});
          }
        })();
      },
      onUnpromptedState: (state) => {
        send({outcome: "restored", requestId: null, state, type: "as-review-view-state", v: reviewProtocolVersion});
      },
      post: (message) => {
        // The sandbox's origin is opaque ("null"), so no narrower target exists.
        pageWindow()?.postMessage(message, "*");
      },
    });
    channelRef.current = channel;
    const onPageMessage = (event: MessageEvent<unknown>): void => {
      const page = pageWindow();
      if (page === null || event.source !== page || event.origin !== "null") return;
      const parsed = pageMessageSchema.safeParse(event.data);
      if (parsed.success) channel.receive(parsed.data);
    };
    window.addEventListener("message", onPageMessage);
    // Plannotator owns the sandbox iframe; its load does not bubble, so listen while capturing.
    const onDocumentLoad = (event: Event): void => {
      if (event.target instanceof HTMLIFrameElement && event.target.hasAttribute("srcdoc")) channel.documentLoaded();
    };
    document.addEventListener("load", onDocumentLoad, true);
    return () => {
      document.removeEventListener("load", onDocumentLoad, true);
      window.removeEventListener("message", onPageMessage);
      channel.reset();
      channelRef.current = null;
    };
  }, [send]);

  useEffect(() => {
    // Framed by the application shell or nothing: a top-level review frame has
    // no host to authenticate against, so it never listens and never speaks.
    const framed = window.parent !== window;
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== window.parent) return;
      if (event.origin !== window.location.origin) return;
      const parsed = hostMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "as-review-init") {
        applyTheme(message);
        channelRef.current?.reset();
        regionFailuresRef.current = new Map();
        viewerUnanchoredRef.current = [];
        const hasRegions = message.annotations.some((annotation) => annotation.anchor?.view?.regionId !== undefined);
        if (!hasRegions) {
          paintedIdsRef.current = new Set(
            message.annotations.map((annotation) => annotation.threadId),
          );
          setSession(sessionFrom(message));
          return;
        }
        paintedIdsRef.current = new Set();
        setSession({...sessionFrom(message), annotations: []});
        showAnnotations(message.annotations);
        return;
      }
      if (message.type === "as-review-theme") {
        applyTheme(message);
        return;
      }
      if (message.type === "as-review-annotations") {
        showAnnotations(message.annotations);
        return;
      }
      if (message.type === "as-review-annotate-mode") {
        setSession((current) =>
          current === null
            ? current
            : {...current, annotateModeActive: message.active}
        );
        return;
      }
      if (message.type === "as-review-restore") {
        capturePropsRef.current = Object.keys(message.props);
        const channel = channelRef.current;
        void (async () => {
          const result = channel === null
            ? {outcome: "unsupported", reason: "no-adapter"} as const
            : await channel.restore(message.props, message.scenarioId);
          // The restore that replaced this one answers the host instead.
          if (result.outcome === "superseded") return;
          send(result.outcome === "restored"
            ? {outcome: "restored", requestId: message.requestId, state: result.state, type: "as-review-view-state", v: reviewProtocolVersion}
            : result.outcome === "failed"
              ? {outcome: "failed", reason: result.reason, requestId: message.requestId, state: result.state, type: "as-review-view-state", v: reviewProtocolVersion}
              : {outcome: "unsupported", reason: "no-adapter", requestId: message.requestId, state: null, type: "as-review-view-state", v: reviewProtocolVersion});
        })();
        return;
      }
      if (message.type === "as-review-capture") {
        capturePropsRef.current = message.props;
        const channel = channelRef.current;
        void (async () => {
          const state = channel === null ? null : await channel.capture(message.props);
          send(state === null
            ? {outcome: "unsupported", reason: "no-adapter", requestId: message.requestId, state: null, type: "as-review-view-state", v: reviewProtocolVersion}
            : {outcome: "restored", requestId: message.requestId, state, type: "as-review-view-state", v: reviewProtocolVersion});
        })();
        return;
      }
      setSelectedThreadId(message.threadId);
    };
    if (framed) {
      window.addEventListener("message", onMessage);
      send({type: "as-review-ready", v: reviewProtocolVersion});
    }
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [send, showAnnotations]);

  // The viewer paints marks for its initial prop set when the bridge reports
  // ready; every later arrival or removal is reconciled by id so a replaced
  // optimistic annotation leaves no orphan marker behind.
  const annotations = session?.annotations;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer === null || annotations === undefined) return;
    const painted = paintedIdsRef.current;
    const next = new Set(annotations.map((annotation) => annotation.id));
    for (const id of painted) {
      if (!next.has(id)) viewer.removeHighlight(id);
    }
    const added = annotations.filter(
      (annotation) => !painted.has(annotation.id),
    );
    if (added.length > 0) viewer.applySharedAnnotations(added);
    paintedIdsRef.current = next;
  }, [annotations]);

  const handleAdd = useCallback((annotation: Annotation): void => {
    setSession((current) =>
      current === null
        ? current
        : {...current, annotations: [...current.annotations, annotation]}
    );
    const anchor = reviewAnchorFrom(
      annotation.originalText,
      annotation.htmlAnchor,
      annotation.htmlAdditionalTargets,
    );
    const channel = channelRef.current;
    const selector = annotation.htmlAnchor?.selector;
    void (async () => {
      const body = annotation.text ?? "";
      if (channel === null || channel.supports() !== true) {
        send({anchor, body, originalText: annotation.originalText, type: "as-review-submit", v: reviewProtocolVersion});
        return;
      }
      // Page context is evidence for the host, which decides what to store.
      const [state, answer] = await Promise.all([
        channel.capture(capturePropsRef.current),
        selector === undefined ? null : channel.regionAt(selector),
      ]);
      send({
        anchor,
        body,
        capture: {region: answer?.region ?? null, state},
        originalText: annotation.originalText,
        type: "as-review-submit",
        v: reviewProtocolVersion,
      });
    })();
  }, [send]);

  const handleSelect = useCallback((threadId: string | null): void => {
    setSelectedThreadId(threadId);
    send({threadId, type: "as-review-select", v: reviewProtocolVersion});
  }, [send]);

  const handleUnanchored = useCallback((threadIds: string[]): void => {
    viewerUnanchoredRef.current = threadIds;
    reportUnanchored();
  }, [reportUnanchored]);

  const requestAnnotateMode = useCallback((active: boolean): void => {
    send({
      active,
      type: "as-review-annotate-mode-request",
      v: reviewProtocolVersion,
    });
  }, [send]);

  if (session === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        Waiting for the artifact to load.
      </p>
    );
  }

  return (
    <HtmlViewer
      annotateModeActive={session.annotateModeActive}
      annotations={session.annotations}
      fullViewport
      hideControls
      inputMethod="pinpoint"
      mode="comment"
      onAddAnnotation={handleAdd}
      onAnnotateModeExit={session.supportsAnnotateMode
        ? () => requestAnnotateMode(false)
        : undefined}
      onAnnotateModeToggle={session.supportsAnnotateMode
        ? () => requestAnnotateMode(!session.annotateModeActive)
        : undefined}
      onSelectAnnotation={handleSelect}
      onUnanchoredChange={handleUnanchored}
      rawHtml={session.html}
      readOnly={session.readOnly}
      ref={viewerRef}
      selectedAnnotationId={selectedThreadId}
      title={`Artifact review: ${session.entryPath}`}
    />
  );
}
