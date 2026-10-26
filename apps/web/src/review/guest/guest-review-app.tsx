import {useCallback, useEffect, useRef, useState, type CSSProperties} from "react";

import {ApiError} from "@/api/client";
import {guestApi, guestCommentsTransport, type GuestContext} from "@/api/guest-client";
import {
  Alert,
  CommentThread,
  type CommentThreadProps,
  SegmentedControl,
  Select,
  SurfaceState,
  THEME_MODE_LABELS,
  THEME_MODES,
} from "@/arkcase";
import {CommentComposer} from "@/components/comments/comment-composer";
import {GuestBadge} from "@/components/comments/guest-badge";
import {maximumCommentBodyCharacters} from "@/components/comments/comment-limits";
import {formatTimestamp} from "@/lib/presentation";
import {useThemeMode} from "@/theme/use-theme-mode";

import {useReviewComments, type ReviewCommentSession} from "../review-comments.tsx";
import {EndedLink} from "./ended-link.tsx";
import {guestBanner, guestShellControls, sharePathOf} from "./guest-model.ts";
import {GuestNameDialog} from "./guest-name-dialog.tsx";

type GuestState =
  | {readonly kind: "ended"}
  | {readonly kind: "failed"; readonly message: string}
  | {readonly kind: "loading"}
  | {readonly context: GuestContext; readonly kind: "ready"};

const platforms = {Desktop: null, Phone: 390, Tablet: 820} as const;
type Platform = keyof typeof platforms;
const platformNames: readonly Platform[] = ["Desktop", "Tablet", "Phone"];

/** Every refusal that means the link no longer admits this guest. */
function linkEnded(error: Error | null): boolean {
  return error instanceof ApiError && (error.code === "SHARE_LINK_NOT_FOUND" || error.code === "GUEST_SESSION_REQUIRED");
}

// One exchange per token, even when a development render mounts the app twice.
let opening: {readonly promise: Promise<GuestContext>; readonly token: string} | null = null;

function openLink(token: string): Promise<GuestContext> {
  if (opening?.token !== token) opening = {promise: guestApi.startSession(token), token};
  return opening.promise;
}

/** Review for someone holding a share link: one artifact, one version, the link's controls only. */
export function GuestReviewApp() {
  const [state, setState] = useState<GuestState>({kind: "loading"});

  useEffect(() => {
    let current = true;
    const path = sharePathOf(window.location.pathname);
    const load = async () => {
      if (path === null) {
        setState({kind: "ended"});
        return;
      }
      try {
        const context = path.kind === "open" ? await openLink(path.token) : await guestApi.session();
        // The token leaves the address bar, history and any later Referer before the page renders.
        if (path.kind === "open") window.history.replaceState(null, "", `/review/shared/${encodeURIComponent(context.link.id)}`);
        if (current) setState({context, kind: "ready"});
      } catch (caught) {
        if (!current) return;
        const failure = caught instanceof Error ? caught : null;
        setState(linkEnded(failure)
          ? {kind: "ended"}
          : {kind: "failed", message: failure?.message ?? "This link could not be opened."});
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, []);

  if (state.kind === "loading") {
    return <SurfaceState loadingTitle="Opening the shared link" noun="link" phase="loading" />;
  }
  if (state.kind === "ended") return <EndedLink />;
  if (state.kind === "failed") {
    return (
      <SurfaceState
        failedBody={state.message}
        failedTitle="This link could not be opened"
        noun="link"
        onRetry={() => window.location.reload()}
        phase="failed"
      />
    );
  }
  return (
    <GuestReview
      context={state.context}
      onContext={(context) => setState({context, kind: "ready"})}
      onEnded={() => setState({kind: "ended"})}
    />
  );
}

interface GuestReviewProps {
  readonly context: GuestContext;
  readonly onContext: (context: GuestContext) => void;
  readonly onEnded: () => void;
}

function GuestReview({context, onContext, onEnded}: GuestReviewProps) {
  const controls = guestShellControls(context.link.permissions);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>("Desktop");
  const appearance = useThemeMode();
  const onVersionChanged = useCallback(() => undefined, []);
  const session = useReviewComments({
    artifactId: controls.comments ? context.artifact.id : null,
    onVersionChanged,
    projectId: context.project.id,
    transport: guestCommentsTransport,
    versionId: context.version.id,
  });

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const lease = await guestApi.previewLease();
        if (current) setPreviewUrl(lease.baseUrl);
      } catch (caught) {
        if (!current) return;
        const failure = caught instanceof Error ? caught : null;
        if (linkEnded(failure)) onEnded();
        else setPreviewFailure(failure?.message ?? "The page could not be opened.");
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [context.version.id, onEnded]);

  useEffect(() => {
    if (linkEnded(session.error)) onEnded();
  }, [onEnded, session.error]);

  const width = platforms[platform];
  return (
    <div style={shellStyle}>
      <header style={bannerStyle}>
        <span style={bannerTextStyle}>
          <i aria-hidden="true" className="bi bi-person-badge" />
          <span>{guestBanner(context.link.createdByName, context.link.expiresAt)}</span>
        </span>
        <span style={bannerTitleStyle}>
          <strong>{context.artifact.name}</strong>
          <span style={subtleStyle}>Version {context.version.number}</span>
        </span>
        <span style={controlsStyle}>
          <SegmentedControl
            label="Platform"
            mode="radio"
            onChange={(label) => {
              const chosen = platformNames.find((name) => name === label);
              if (chosen !== undefined) setPlatform(chosen);
            }}
            options={[...platformNames]}
            value={platform}
          />
          <Select
            label="Appearance"
            onChange={(event) => {
              const chosen = THEME_MODES.find((mode) => mode === event.currentTarget.value);
              if (chosen !== undefined) appearance.setMode(chosen);
            }}
            options={THEME_MODES.map((mode) => ({label: THEME_MODE_LABELS[mode], value: mode}))}
            size="sm"
            value={appearance.mode}
          />
        </span>
      </header>
      <div style={bodyStyle}>
        <main aria-label="Shared page" style={stageStyle}>
          {previewFailure !== null ? (
            <Alert variant="danger">{previewFailure}</Alert>
          ) : previewUrl === null ? (
            <SurfaceState loadingTitle="Opening the page" noun="page" phase="loading" />
          ) : (
            <iframe
              src={previewUrl}
              style={{...frameStyle, maxWidth: width ?? "100%", width: width ?? "100%"}}
              title={context.artifact.name}
            />
          )}
        </main>
        {controls.comments ? (
          <GuestComments
            composer={controls.composer}
            context={context}
            onContext={onContext}
            onEnded={onEnded}
            session={session}
          />
        ) : null}
      </div>
    </div>
  );
}

interface GuestCommentsProps {
  readonly composer: boolean;
  readonly context: GuestContext;
  readonly onContext: (context: GuestContext) => void;
  readonly onEnded: () => void;
  readonly session: ReviewCommentSession;
}

function GuestComments({composer, context, onContext, onEnded, session}: GuestCommentsProps) {
  const [naming, setNaming] = useState(false);
  const resolveNaming = useRef<((named: boolean) => void) | null>(null);
  const selected = session.threads.find((thread) => thread.id === session.selectedThreadId) ?? null;

  /** The first write waits for a name; the composer keeps its text until the comment is saved. */
  const ensureNamed = async (): Promise<boolean> => {
    if (context.guest.displayName !== null) return true;
    setNaming(true);
    return new Promise((resolve) => {
      resolveNaming.current = resolve;
    });
  };

  const submit = async (body: string, idempotencyKey: string): Promise<boolean> => {
    if (!(await ensureNamed())) return false;
    return selected === null
      ? session.submit(body, null, null)
      : session.createReply(selected, body, idempotencyKey);
  };

  const items = session.threads.map((thread) => ({
    author: thread.author.displayName,
    badge: thread.author.principalKind === "guest" ? <GuestBadge /> : undefined,
    id: thread.id,
    replies: (session.repliesByThread.get(thread.id) ?? []).map((reply) => ({
      author: reply.author.displayName,
      badge: reply.author.principalKind === "guest" ? <GuestBadge /> : undefined,
      id: reply.id,
      text: reply.body,
      time: formatTimestamp(reply.updatedAt),
    })),
    resolved: thread.state === "resolved",
    text: thread.body,
    time: formatTimestamp(thread.createdAt),
  }));

  const resolveControl: Pick<CommentThreadProps, "onResolve"> = composer
    ? {
      onResolve: (id, next) => {
        const thread = session.threads.find((candidate) => candidate.id === id);
        if (thread !== undefined && (thread.state === "resolved") !== next) void session.changeState(thread);
      },
    }
    : {};

  return (
    <aside aria-label="Comments" style={panelStyle}>
      <h2 style={panelHeadingStyle}>Comments</h2>
      {session.error === null ? null : <Alert variant="danger">{session.error.message}</Alert>}
      <div style={threadsStyle}>
        <CommentThread
          aria-label="Comment threads"
          comments={items}
          density="compact"
          emptyMessage={composer ? "No comments yet. Leave the first one below." : "No comments yet."}
          {...resolveControl}
          onSelect={(id) => session.selectThread(session.selectedThreadId === id ? null : id)}
          selectedId={session.selectedThreadId}
        />
      </div>
      {composer ? (
        <div style={composerStyle}>
          <CommentComposer
            cancelLabel={selected === null ? null : "Cancel reply"}
            docked
            initialBody=""
            key={selected?.id ?? "new"}
            label={selected === null ? "Add a comment" : `Reply to ${selected.author.displayName}`}
            maximumCharacters={maximumCommentBodyCharacters}
            onCancel={selected === null ? null : () => session.selectThread(null)}
            onSubmit={submit}
            submitLabel={selected === null ? "Comment" : "Reply"}
          />
        </div>
      ) : null}
      <GuestNameDialog
        onClose={(named) => {
          setNaming(false);
          if (named !== null) onContext(named);
          resolveNaming.current?.(named !== null);
          resolveNaming.current = null;
        }}
        onEnded={onEnded}
        open={naming}
      />
    </aside>
  );
}

const shellStyle = {
  background: "var(--surface-page, #f5f6f8)",
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  minHeight: 0,
} satisfies CSSProperties;
const bannerStyle = {
  alignItems: "center",
  background: "var(--surface-card, #fff)",
  borderBottom: "1px solid var(--border-subtle, #dde1e6)",
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  justifyContent: "space-between",
  padding: "8px 16px",
} satisfies CSSProperties;
const bannerTextStyle = {alignItems: "center", display: "inline-flex", fontSize: 13, gap: 8} satisfies CSSProperties;
const bannerTitleStyle = {alignItems: "baseline", display: "inline-flex", gap: 8, minWidth: 0} satisfies CSSProperties;
const controlsStyle = {alignItems: "center", display: "inline-flex", gap: 12} satisfies CSSProperties;
const subtleStyle = {color: "var(--text-secondary)", fontSize: 12} satisfies CSSProperties;
const bodyStyle = {display: "flex", flex: "1 1 auto", minHeight: 0} satisfies CSSProperties;
const stageStyle = {
  alignItems: "stretch",
  display: "flex",
  flex: "1 1 auto",
  justifyContent: "center",
  minWidth: 0,
  padding: 16,
} satisfies CSSProperties;
const frameStyle = {
  background: "#fff",
  border: "1px solid var(--border-subtle, #dde1e6)",
  borderRadius: 6,
  height: "100%",
} satisfies CSSProperties;
const panelStyle = {
  background: "var(--surface-card, #fff)",
  borderLeft: "1px solid var(--border-subtle, #dde1e6)",
  display: "flex",
  flex: "0 0 360px",
  flexDirection: "column",
  gap: 8,
  minHeight: 0,
  padding: 12,
} satisfies CSSProperties;
const panelHeadingStyle = {fontSize: "var(--font-size-md, 16px)", margin: 0} satisfies CSSProperties;
const threadsStyle = {flex: "1 1 auto", minHeight: 0, overflowY: "auto"} satisfies CSSProperties;
const composerStyle = {borderTop: "1px solid var(--border-subtle, #dde1e6)", paddingTop: 8} satisfies CSSProperties;
