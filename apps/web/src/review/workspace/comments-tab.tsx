import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

import {
  api,
  type AgentDispatch,
  type AgentPresence,
  type CommentReply,
  type CommentThread as ReviewThread,
} from "@/api/client";
import {Alert, Button, type CommentItem, CommentThread, IconButton, SegmentedControl, SurfaceState} from "@/arkcase";
import {CommentComposer} from "@/components/comments/comment-composer";
import {useCommentDraft} from "@/components/comments/comment-drafts";
import {maximumCommentBodyCharacters} from "@/components/comments/comment-limits";
import {useCommentPoll} from "@/components/comments/comment-poll";
import {bundleOfThreads} from "@/components/dispatch/dispatch-bundle";
import {loadDispatchIndex} from "@/components/dispatch/dispatch-index";
import {dispatchIsCancelable, DispatchStateChip} from "@/components/dispatch/dispatch-state";
import {useDispatchUndo} from "@/components/dispatch/dispatch-toast";
import {PresenceAvatar} from "@/components/dispatch/presence-avatar";
import {SendToAgentControl} from "@/components/dispatch/send-to-agent-dialog";
import {formatTimestamp} from "@/lib/presentation";
import {useDensity} from "@/ui/density";

import {
  agentPresenceSummary,
  loadAllThreads,
  loadConversations,
  type ReviewCommentSession,
} from "../review-comments.tsx";
import {reviewAnchorSchema, type UnanchoredReason} from "@/review-frame/protocol";
import {threadPlacement} from "./scenario-model.ts";
import {useScenarioSession, type ScenarioSession} from "./scenario-session.tsx";

type CommentView = "all" | "open" | "resolved" | "sent";

const commentViews = ["open", "all", "resolved", "sent"] as const satisfies readonly CommentView[];
const commentViewLabels = {
  all: "All",
  open: "Open",
  resolved: "Resolved",
  sent: "Sent",
} satisfies Record<CommentView, string>;

/** Lets the canvas's Reload refresh threads, sends and presence together. */
export interface CommentsTabHandle {
  readonly reload: () => Promise<void>;
}

export interface CommentsTabProps {
  readonly agentControlsOpen: boolean;
  readonly canComment: boolean;
  /** Brings the thread's place on the page into view. */
  readonly onShowInArtifact: (threadId: string) => void;
  readonly canDeleteAny: boolean;
  readonly handleRef: RefObject<CommentsTabHandle | null>;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly versionId: string | null;
}

const tabStyle = {display: "flex", flexDirection: "column", gap: 10, padding: "10px 12px 16px"} satisfies CSSProperties;
const agentsStyle = {alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between"} satisfies CSSProperties;
const agentsSummaryStyle = {display: "flex", flexDirection: "column", minWidth: 0} satisfies CSSProperties;
const avatarRowStyle = {display: "flex", flexWrap: "wrap", gap: 4} satisfies CSSProperties;
const noteStyle = {color: "var(--text-secondary)", fontSize: "var(--font-size-xs, 12px)", margin: 0} satisfies CSSProperties;
const sendAllStyle = {display: "flex", flexWrap: "wrap", minWidth: 0} satisfies CSSProperties;
const bodyStyle = {borderRadius: "var(--radius-sm, 4px)", display: "flex", flexDirection: "column", gap: 4} satisfies CSSProperties;
const selectedBodyStyle = {...bodyStyle, background: "var(--tint-primary-selected)", boxShadow: "0 0 0 4px var(--tint-primary-selected)"} satisfies CSSProperties;
const threadTextStyle = {margin: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap"} satisfies CSSProperties;
const metaStyle = {color: "var(--text-secondary)", fontSize: "var(--font-size-label, 11px)", margin: 0} satisfies CSSProperties;
const replyActionsStyle = {display: "flex", gap: 4, marginTop: 4} satisfies CSSProperties;
const markStyle = {
  alignItems: "center",
  color: "var(--text-secondary)",
  display: "inline-flex",
  flex: "none",
  fontSize: 13,
  justifyContent: "center",
  width: 18,
} satisfies CSSProperties;
const composerStyle = {display: "flex", flexDirection: "column", gap: 6} satisfies CSSProperties;
const contextStyle = {
  alignItems: "center",
  color: "var(--text-secondary)",
  display: "flex",
  fontSize: "var(--font-size-xs, 12px)",
  gap: 6,
  minHeight: 24,
} satisfies CSSProperties;
const contextTextStyle = {flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"} satisfies CSSProperties;
const contextStrongStyle = {color: "var(--text-emphasis)"} satisfies CSSProperties;

/**
 * The Comments view: presence, send, filters and every thread. Threads are selectable:
 * the selected one opens its replies and actions, the others collapse to a summary.
 * The composer is docked at the panel's foot (`CommentsComposer`).
 */
export function CommentsTab({
  agentControlsOpen,
  canComment,
  canDeleteAny,
  onShowInArtifact,
  handleRef,
  principalId,
  session,
  versionId,
}: CommentsTabProps) {
  const unanchored = new Set(session.unanchoredIds);
  const scenario = useScenarioSession();
  const [agents, setAgents] = useState<readonly AgentPresence[] | null>(null);
  const [agentError, setAgentError] = useState<Error | null>(null);
  const [view, setView] = useState<CommentView>("open");
  // A newly selected thread the current filter hides (a resolved one opened from Activity, say) widens the view to All once.
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  const selectedThread = session.threads.find((thread) => thread.id === session.selectedThreadId);
  if ((selectedThread?.id ?? null) !== revealedFor) {
    setRevealedFor(selectedThread?.id ?? null);
    if ((view === "open" && selectedThread?.state === "resolved") || (view === "resolved" && selectedThread?.state === "open")) setView("all");
  }
  const [sentThreads, setSentThreads] = useState<readonly ReviewThread[]>([]);
  const [sentReplies, setSentReplies] = useState<ReadonlyMap<string, readonly CommentReply[]>>(new Map());
  const [dispatchByThread, setDispatchByThread] = useState<ReadonlyMap<string, AgentDispatch>>(new Map());
  const [sentLoading, setSentLoading] = useState(false);
  // Sent threads are not in the session's list, so the Sent view keeps its own selection.
  const [sentSelectedId, setSentSelectedId] = useState<string | null>(null);
  const [sentError, setSentError] = useState<Error | null>(null);
  const density = useDensity();

  const loadAgents = useCallback(async (): Promise<void> => {
    try {
      setAgents(await api.agentPresence());
      setAgentError(null);
    } catch (caught) {
      setAgentError(caught instanceof Error ? caught : new Error("Agent presence failed."));
    }
  }, []);

  // The tab stays mounted across artifacts, so each read of the Sent listing is
  // tied to the version it was asked for and a late answer for another is dropped.
  const sentOpen = view === "sent";
  const sentOpenRef = useRef(sentOpen);
  sentOpenRef.current = sentOpen;
  const sentRequestRef = useRef(0);
  const sentVersionRef = useRef<string | null>(null);
  const loadSent = useCallback(async (): Promise<void> => {
    const request = ++sentRequestRef.current;
    const sentVersion = session.artifactId === null || versionId === null
      ? null
      : `${session.projectId}\n${session.artifactId}\n${versionId}`;
    if (sentVersion !== sentVersionRef.current) {
      sentVersionRef.current = sentVersion;
      setSentThreads([]);
      setSentReplies(new Map());
      setDispatchByThread(new Map());
    }
    if (session.artifactId === null || session.projectId === "" || versionId === null) return;
    setSentLoading(true);
    setSentError(null);
    try {
      const listed = await loadAllThreads(session.projectId, session.artifactId, versionId, "only");
      if (request !== sentRequestRef.current) return;
      setSentThreads(listed.threads);
      // The count needs only the listing; replies and send states load when Sent is open.
      if (!sentOpenRef.current) return;
      const [conversations, index] = await Promise.all([
        loadConversations(session.projectId, session.artifactId, listed.threads),
        loadDispatchIndex(session.projectId, listed.threads.map((thread) => thread.id)),
      ]);
      if (request !== sentRequestRef.current) return;
      setSentThreads(conversations.map(({thread}) => thread));
      setSentReplies(new Map(conversations.map(({replies, thread}) => [thread.id, replies])));
      setDispatchByThread(index);
    } catch (caught) {
      if (request !== sentRequestRef.current) return;
      setSentError(caught instanceof Error ? caught : new Error("Sent comments failed."));
    } finally {
      if (request === sentRequestRef.current) setSentLoading(false);
    }
  }, [session.artifactId, session.projectId, versionId]);

  const reloadDispatchSurface = useCallback(async (): Promise<void> => {
    await Promise.all([session.reload(), loadSent(), loadAgents()]);
  }, [loadAgents, loadSent, session.reload]);
  useImperativeHandle(handleRef, () => ({reload: reloadDispatchSurface}), [reloadDispatchSurface]);
  const dispatchUndo = useDispatchUndo(session.projectId, reloadDispatchSurface);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);
  useEffect(() => {
    void loadSent();
  }, [loadSent, sentOpen]);
  useCommentPoll(loadAgents, session.projectId !== "");
  useCommentPoll(loadSent, sentOpen && session.artifactId !== null && versionId !== null);

  const openThreads = session.threads.filter((thread) => thread.state === "open");
  const resolvedThreads = session.threads.filter((thread) => thread.state === "resolved");
  const visibleThreads = view === "sent"
    ? sentThreads
    : view === "all"
      ? [...openThreads, ...resolvedThreads]
      : view === "open"
        ? openThreads
        : resolvedThreads;
  const visibleReplies = view === "sent" ? sentReplies : session.repliesByThread;
  const loadingVisible = view === "sent" ? sentLoading : session.loading;
  const now = Date.now();

  const cancelDispatch = async (dispatch: AgentDispatch): Promise<void> => {
    setSentError(null);
    try {
      await api.cancelAgentDispatch(session.projectId, dispatch.id);
      await reloadDispatchSurface();
    } catch (caught) {
      setSentError(caught instanceof Error ? caught : new Error("Cancel failed."));
    }
  };

  const onSent = async (): Promise<void> => {
    await reloadDispatchSurface();
  };

  const emptyMessage = view === "all"
    ? "No comments on this version yet."
    : view === "sent"
      ? "No sent comments on this version."
      : view === "open" && resolvedThreads.length > 0
        ? "All comments on this version are resolved."
        : `No ${view} comments on this version.`;
  const findThread = (id: string): ReviewThread | undefined =>
    visibleThreads.find((thread) => thread.id === id);

  const threadList: ComponentProps<typeof CommentThread> = {
    "aria-label": "Comment threads",
    comments: visibleThreads.map((thread) => {
      const replies = visibleReplies.get(thread.id) ?? [];
      const last = replies.at(-1);
      const item: CommentItem = {
        author: thread.author.displayName,
        badge: <ThreadMark thread={thread} />,
        id: thread.id,
        replies: replies.map((reply) => ({
          author: reply.author.displayName,
          id: reply.id,
          text: (
            <ReplyBody
              canDeleteAny={canDeleteAny}
              canMutate={canComment}
              onDelete={session.deleteReply}
              onUpdate={session.updateReply}
              principalId={principalId}
              reply={reply}
            />
          ),
          time: formatTimestamp(reply.updatedAt),
        })),
        resolved: thread.state === "resolved",
        text: (
          <ThreadBody
            dispatch={view === "sent" ? dispatchByThread.get(thread.id) ?? null : null}
            replyCount={replies.length}
            selected={session.selectedThreadId === thread.id}
            thread={thread}
            unanchored={view !== "sent" && unanchored.has(thread.id)}
            unanchoredReason={view === "sent" ? null : session.unanchoredReasons.get(thread.id) ?? null}
          />
        ),
        time: formatTimestamp(thread.createdAt),
      };
      // A collapsed thread says who answered last and when.
      if (last !== undefined) {
        item.activity = `${replies.length} ${replies.length === 1 ? "reply" : "replies"} · ${last.author.displayName}, ${formatTimestamp(last.updatedAt)}`;
      }
      return item;
    }),
    density,
    onSelect: (id) => {
      if (view === "sent") setSentSelectedId((current) => current === id ? null : id);
      else session.selectThread(session.selectedThreadId === id ? null : id);
    },
    renderActions: (id) => {
      const thread = findThread(id);
      if (thread === undefined) return null;
      if (view === "sent") {
        const dispatch = dispatchByThread.get(thread.id);
        return dispatch !== undefined && dispatchIsCancelable(dispatch.state) ? (
          <Button onClick={() => void cancelDispatch(dispatch)} outline size="xs" variant="secondary">
            Cancel send
          </Button>
        ) : null;
      }
      return (
        <>
          {canComment && thread.state === "open" ? (
            <SendToAgentControl
              agents={agents}
              buttonSize="xs"
              buttonVariant="outline"
              feedback={dispatchUndo.feedback}
              label="Send…"
              onSent={onSent}
              oneAgentLabel={(name) => `Send to ${name}`}
              openCount={1}
              principalId={principalId}
              projectId={session.projectId}
              reasonDisplay="hidden"
              resolveBundle={() => Promise.resolve(bundleOfThreads([thread]))}
            />
          ) : null}
          <OpenScenarioAction scenario={scenario} thread={thread} />
          {thread.path === null ? null : (
            <IconButton
              ariaLabel="Show in the artifact"
              icon="bi-geo-alt"
              onClick={() => onShowInArtifact(thread.id)}
              size="xs"
              title="Show in the artifact"
            />
          )}
        </>
      );
    },
    selectedId: view === "sent" ? sentSelectedId : session.selectedThreadId,
  };
  if (view !== "sent" && canComment) {
    threadList.onResolve = (id) => {
      const thread = findThread(id);
      if (thread !== undefined) void session.changeState(thread);
    };
  }

  return (
    <div style={tabStyle}>
      <div hidden={!agentControlsOpen} id="review-agent-controls" style={{display: agentControlsOpen ? "flex" : "none", flexDirection: "column", gap: 8}}>
      <section aria-label="Agents" style={agentsStyle}>
        <div style={agentsSummaryStyle}>
          <strong>Agents</strong>
          <span style={noteStyle}>{agentPresenceSummary(agents)}</span>
        </div>
        <div aria-label="Agent presence" role="group" style={avatarRowStyle}>
          {agents?.map((agent) => <PresenceAvatar agent={agent} key={agent.id} now={now} />)}
        </div>
      </section>
      {agentError === null ? null : <Alert variant="warning">{agentError.message}</Alert>}
      {canComment ? (
        <div style={sendAllStyle}>
          <SendToAgentControl
            agents={agents}
            buttonSize="xs"
            buttonVariant="primary"
            feedback={dispatchUndo.feedback}
            label={`Send all open (${openThreads.length})…`}
            onSent={onSent}
            oneAgentLabel={(name) => `Send all open (${openThreads.length}) to ${name}`}
            openCount={openThreads.length}
            principalId={principalId}
            projectId={session.projectId}
            resolveBundle={() => Promise.resolve(bundleOfThreads(openThreads))}
          />
        </div>
      ) : null}
      </div>
      {!canComment ? <p style={noteStyle}>Comments are read-only for this account or archived project.</p> : null}
      {session.error === null ? null : <Alert variant="danger">{session.error.message}</Alert>}
      {sentError === null ? null : <Alert variant="danger">{sentError.message}</Alert>}
      <SegmentedControl
        label="Comment filters"
        mode="toggle"
        onChange={(id) => {
          const next = commentViews.find((candidate) => candidate === id);
          if (next !== undefined) setView(next);
        }}
        options={commentViews.map((candidate) => ({
          id: candidate,
          label: candidate === "sent" ? `Sent (${sentThreads.length})` : commentViewLabels[candidate],
        }))}
        size="sm"
        value={view}
      />
      {loadingVisible && visibleThreads.length === 0 ? (
        <SurfaceState density="inline" loadingStyle="spinner" loadingTitle="Loading comments…" noun="comments" phase="loading" />
      ) : null}
      {!loadingVisible && visibleThreads.length === 0 ? <p style={noteStyle}>{emptyMessage}</p> : null}
      {visibleThreads.length === 0 ? null : <CommentThread {...threadList} />}
    </div>
  );
}

interface ThreadBodyProps {
  readonly dispatch: AgentDispatch | null;
  readonly replyCount: number;
  readonly selected: boolean;
  readonly thread: ReviewThread;
  readonly unanchored: boolean;
  readonly unanchoredReason: UnanchoredReason | null;
}

/** A thread's body and its record line; marks the thread the page selected. */
function ThreadBody({dispatch, replyCount, selected, thread, unanchored, unanchoredReason}: ThreadBodyProps) {
  return (
    <div aria-current={selected ? "true" : undefined} data-state={thread.state} style={selected ? selectedBodyStyle : bodyStyle}>
      <p style={threadTextStyle}>{thread.body}</p>
      <p style={metaStyle}>
        <span>Updated <time dateTime={thread.updatedAt}>{formatTimestamp(thread.updatedAt)}</time></span>
        <span aria-hidden="true"> · </span>
        <span>{thread.path === null ? "Whole version" : <>Page <code>{thread.path}</code></>}</span>
        {replyCount === 0 ? null : (
          <>
            <span aria-hidden="true"> · </span>
            <span>{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>
          </>
        )}
      </p>
      <ThreadLocation thread={thread} unanchored={unanchored} unanchoredReason={unanchoredReason} />
      {dispatch === null ? null : <DispatchStateChip state={dispatch.state} />}
    </div>
  );
}

/**
 * A selected thread made in another designed scenario offers to open it. It
 * sits with the thread's actions, not inside the selectable thread body.
 */
function OpenScenarioAction({scenario, thread}: {
  readonly scenario: ScenarioSession;
  readonly thread: ReviewThread;
}) {
  const parsed = reviewAnchorSchema.safeParse(thread.anchor);
  const anchor = parsed.success ? parsed.data : null;
  const placement = threadPlacement(anchor, scenario.view, scenario.onScreen.scenarioId);
  if (placement.kind !== "other-scenario") return null;
  return (
    <Button
      onClick={() => scenario.requestScenario(placement.scenarioId, anchor?.view?.state.parameters ?? {})}
      outline
      size="xs"
      variant="secondary"
    >
      {`Open scenario ${placement.scenarioId}`}
    </Button>
  );
}

/** Where a thread is on the page now: placed, in another scenario, or unavailable. */
function ThreadLocation({thread, unanchored, unanchoredReason}: {
  readonly thread: ReviewThread;
  readonly unanchored: boolean;
  readonly unanchoredReason: UnanchoredReason | null;
}) {
  const scenario = useScenarioSession();
  const parsed = reviewAnchorSchema.safeParse(thread.anchor);
  const anchor = parsed.success ? parsed.data : null;
  const placement = threadPlacement(anchor, scenario.view, scenario.onScreen.scenarioId);
  const wanted = anchor?.view?.scenarioId ?? null;
  if (
    wanted !== null &&
    scenario.requested?.scenarioId === wanted &&
    (scenario.onScreen.status === "failed" || scenario.onScreen.status === "unsupported")
  ) {
    return <p style={metaStyle}>{`Location unavailable: scenario ${wanted} couldn't be opened`}</p>;
  }
  if (placement.kind === "other-scenario") {
    return <p style={metaStyle}>{`In scenario ${placement.scenarioId} · ${placement.scenarioLabel}`}</p>;
  }
  if (unanchoredReason !== null) return <p style={metaStyle}>Location unavailable: the region isn't on the page</p>;
  return unanchored ? <p style={metaStyle}>Location unavailable in this version</p> : null;
}

/** A thread's leading mark: a pin for a place on the page, layers for the whole page or version. */
function ThreadMark({thread}: {readonly thread: ReviewThread}) {
  const pinned = thread.anchor !== null && thread.anchor !== undefined;
  return (
    <span aria-hidden="true" style={markStyle}>
      <i className={pinned ? "bi bi-geo-alt-fill" : "bi bi-layers"} />
    </span>
  );
}

export interface CommentsComposerProps {
  readonly canComment: boolean;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly versionId: string | null;
}

/**
 * The composer docked at the Comments panel's foot. The line above the box says what is
 * being written: a reply to the selected thread (Escape or × cancels the reply and keeps
 * its draft), or a new comment on the version. Drafts are kept per thread and version.
 */
export function CommentsComposer({canComment, principalId, session, versionId}: CommentsComposerProps) {
  if (!canComment || versionId === null || session.artifactId === null) return null;
  const selected = session.threads.find((thread) => thread.id === session.selectedThreadId);
  const replyTo = selected !== undefined && selected.state === "open" ? selected : null;
  return replyTo === null ? (
    <NewThreadComposer
      artifactId={session.artifactId}
      key={`new:${session.artifactId}:${versionId}`}
      principalId={principalId}
      session={session}
      versionId={versionId}
    />
  ) : (
    <ReplyComposer
      artifactId={session.artifactId}
      key={`reply:${replyTo.id}`}
      principalId={principalId}
      session={session}
      thread={replyTo}
    />
  );
}

interface ComposerContextProps {
  readonly cancel?: {readonly label: string; readonly onClick: () => void};
  readonly children: ReactNode;
  readonly icon: string;
}

function ComposerContext({cancel, children, icon}: ComposerContextProps) {
  return (
    <div style={contextStyle}>
      <i aria-hidden="true" className={`bi ${icon}`} />
      <span style={contextTextStyle}>{children}</span>
      {cancel === undefined ? null : (
        <IconButton ariaLabel={cancel.label} icon="bi-x-lg" onClick={cancel.onClick} size="xs" />
      )}
    </div>
  );
}

interface NewThreadComposerProps {
  readonly artifactId: string;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly versionId: string;
}

/** The new-thread composer, drafted per artifact and version. */
function NewThreadComposer({artifactId, principalId, session, versionId}: NewThreadComposerProps) {
  const draft = useCommentDraft({artifactId, principalId, threadId: null, versionId});
  return (
    <div data-new-thread-composer="" style={composerStyle}>
      <ComposerContext icon="bi-layers">New comment on the whole version</ComposerContext>
      <CommentComposer
        cancelLabel={null}
        docked
        draftRestored={draft.restored}
        initialBody={draft.initialBody}
        key={`new-thread-${versionId}-${draft.restored ? "draft" : "empty"}`}
        label="Add a comment"
        maximumCharacters={maximumCommentBodyCharacters}
        onBodyChange={draft.onBodyChange}
        onCancel={null}
        onDiscardDraft={draft.onDiscard}
        onSubmit={async (body) => {
          const saved = await session.submit(body, null, null);
          if (saved) draft.onPosted();
          return saved;
        }}
        submitLabel="Post comment"
      />
    </div>
  );
}

interface ReplyComposerProps {
  readonly artifactId: string;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly thread: ReviewThread;
}

/** The selected thread's reply composer, drafted per thread. */
function ReplyComposer({artifactId, principalId, session, thread}: ReplyComposerProps) {
  const draft = useCommentDraft({artifactId, principalId, threadId: thread.id, versionId: null});
  const cancel = (): void => session.selectThread(null);
  return (
    <div data-reply-composer="" onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.stopPropagation();
        cancel();
      }
    }} style={composerStyle}>
      <ComposerContext cancel={{label: "Cancel reply", onClick: cancel}} icon="bi-reply">
        Replying to <strong style={contextStrongStyle}>{thread.author.displayName}</strong>
        {" · "}{thread.path === null ? "Whole version" : thread.path}
      </ComposerContext>
      <CommentComposer
        cancelLabel={null}
        docked
        draftRestored={draft.restored}
        initialBody={draft.initialBody}
        label="Reply"
        maximumCharacters={maximumCommentBodyCharacters}
        onBodyChange={draft.onBodyChange}
        onCancel={null}
        onDiscardDraft={draft.onDiscard}
        onSubmit={async (body, idempotencyKey) => {
          const saved = await session.createReply(thread, body, idempotencyKey);
          if (saved) draft.onPosted();
          return saved;
        }}
        submitLabel="Post reply"
      />
    </div>
  );
}

interface ReplyBodyProps {
  readonly canDeleteAny: boolean;
  readonly canMutate: boolean;
  readonly onDelete: (reply: CommentReply) => Promise<void>;
  readonly onUpdate: (reply: CommentReply, body: string) => Promise<boolean>;
  readonly principalId: string;
  readonly reply: CommentReply;
}

/** One reply's text, or its editor, with the author's Edit and the permitted Delete. */
function ReplyBody({canDeleteAny, canMutate, onDelete, onUpdate, principalId, reply}: ReplyBodyProps) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ownReply = reply.author.principalId === principalId;
  const remove = async (): Promise<void> => {
    setDeleting(true);
    await onDelete(reply);
    setDeleting(false);
  };
  return (
    <>
      {editing ? (
        <CommentComposer
          autoFocus
          cancelLabel="Cancel"
          initialBody={reply.body}
          label="Edit reply"
          maximumCharacters={maximumCommentBodyCharacters}
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            const changed = await onUpdate(reply, body);
            if (changed) setEditing(false);
            return changed;
          }}
          submitLabel="Save reply"
        />
      ) : <p style={threadTextStyle}>{reply.body}</p>}
      {!canMutate || editing || (!ownReply && !canDeleteAny) ? null : (
        <div style={replyActionsStyle}>
          {ownReply ? (
            <Button onClick={() => setEditing(true)} size="xs" variant="ghost">Edit</Button>
          ) : null}
          <Button disabled={deleting} onClick={() => void remove()} size="xs" variant="ghost">
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      )}
    </>
  );
}
