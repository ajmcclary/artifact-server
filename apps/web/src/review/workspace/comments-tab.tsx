import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  type ComponentProps,
  type CSSProperties,
  type RefObject,
} from "react";

import {
  api,
  type AgentDispatch,
  type AgentPresence,
  type CommentReply,
  type CommentThread as ReviewThread,
} from "@/api/client";
import {Alert, Button, CommentThread, SegmentedControl, SurfaceState} from "@/arkcase";
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
  readonly canComment: boolean;
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

/** The Comments view: presence, send, filters, the new-thread composer and every thread. */
export function CommentsTab({
  canComment,
  canDeleteAny,
  handleRef,
  principalId,
  session,
  versionId,
}: CommentsTabProps) {
  const unanchored = new Set(session.unanchoredIds);
  const [agents, setAgents] = useState<readonly AgentPresence[] | null>(null);
  const [agentError, setAgentError] = useState<Error | null>(null);
  const [view, setView] = useState<CommentView>("open");
  const [sentThreads, setSentThreads] = useState<readonly ReviewThread[]>([]);
  const [sentReplies, setSentReplies] = useState<ReadonlyMap<string, readonly CommentReply[]>>(new Map());
  const [dispatchByThread, setDispatchByThread] = useState<ReadonlyMap<string, AgentDispatch>>(new Map());
  const [sentLoading, setSentLoading] = useState(false);
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

  const loadSent = useCallback(async (): Promise<void> => {
    if (session.artifactId === null || session.projectId === "" || versionId === null) {
      setSentThreads([]);
      setSentReplies(new Map());
      setDispatchByThread(new Map());
      return;
    }
    setSentLoading(true);
    setSentError(null);
    try {
      const listed = await loadAllThreads(session.projectId, session.artifactId, versionId, "only");
      const [conversations, index] = await Promise.all([
        loadConversations(session.projectId, session.artifactId, listed.threads),
        loadDispatchIndex(session.projectId, listed.threads.map((thread) => thread.id)),
      ]);
      setSentThreads(conversations.map(({thread}) => thread));
      setSentReplies(new Map(conversations.map(({replies, thread}) => [thread.id, replies])));
      setDispatchByThread(index);
    } catch (caught) {
      setSentError(caught instanceof Error ? caught : new Error("Sent comments failed."));
    } finally {
      setSentLoading(false);
    }
  }, [session.artifactId, session.projectId, versionId]);

  const reloadDispatchSurface = useCallback(async (): Promise<void> => {
    await Promise.all([session.reload(), loadSent(), loadAgents()]);
  }, [loadAgents, loadSent, session.reload]);
  useImperativeHandle(handleRef, () => ({reload: reloadDispatchSurface}), [reloadDispatchSurface]);
  const dispatchUndo = useDispatchUndo(session.projectId, reloadDispatchSurface);

  useEffect(() => {
    void Promise.all([loadAgents(), loadSent()]);
  }, [loadAgents, loadSent]);
  useCommentPoll(loadAgents, session.projectId !== "");
  useCommentPoll(loadSent, view === "sent" && session.artifactId !== null && versionId !== null);

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
      return {
        author: thread.author.displayName,
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
          />
        ),
        time: formatTimestamp(thread.createdAt),
      };
    }),
    density,
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
          {thread.path === null ? null : (
            <Button onClick={() => session.selectThread(thread.id)} size="xs" variant="ghost">Show in page</Button>
          )}
        </>
      );
    },
    renderReplyComposer: (id) => {
      const thread = findThread(id);
      if (
        thread === undefined
        || view === "sent"
        || !canComment
        || thread.state !== "open"
        || session.artifactId === null
      ) return null;
      return (
        <ReplyComposer
          artifactId={session.artifactId}
          key={thread.id}
          principalId={principalId}
          session={session}
          thread={thread}
        />
      );
    },
  };
  if (view !== "sent" && canComment) {
    threadList.onResolve = (id) => {
      const thread = findThread(id);
      if (thread !== undefined) void session.changeState(thread);
    };
  }

  return (
    <div style={tabStyle}>
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
      ) : (
        <p style={noteStyle}>Comments are read-only for this account or archived project.</p>
      )}
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
      {canComment && versionId !== null && session.artifactId !== null ? (
        <NewThreadComposer
          artifactId={session.artifactId}
          key={`${session.artifactId}-${versionId}`}
          principalId={principalId}
          session={session}
          versionId={versionId}
        />
      ) : null}
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
}

/** A thread's body and its record line; marks the thread the page selected. */
function ThreadBody({dispatch, replyCount, selected, thread, unanchored}: ThreadBodyProps) {
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
      {unanchored ? <p style={metaStyle}>Location unavailable in this version</p> : null}
      {dispatch === null ? null : <DispatchStateChip state={dispatch.state} />}
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
    <div data-new-thread-composer="">
      <CommentComposer
        cancelLabel={null}
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

/** One thread's reply composer, drafted per thread; collapsed to a Reply button until used. */
function ReplyComposer({artifactId, principalId, session, thread}: ReplyComposerProps) {
  const draft = useCommentDraft({artifactId, principalId, threadId: thread.id, versionId: null});
  const [expanded, setExpanded] = useState(draft.restored);
  const [replyBody, setReplyBody] = useState(draft.initialBody);

  if (!expanded) {
    return (
      <Button onClick={() => setExpanded(true)} outline size="xs" variant="secondary">Reply</Button>
    );
  }

  return (
    <CommentComposer
      autoFocus
      cancelLabel="Cancel"
      draftRestored={draft.restored}
      initialBody={replyBody}
      label="Reply"
      maximumCharacters={maximumCommentBodyCharacters}
      onBodyChange={(body) => {
        setReplyBody(body);
        draft.onBodyChange(body);
      }}
      onCancel={() => setExpanded(false)}
      onDiscardDraft={() => {
        setReplyBody("");
        draft.onDiscard();
      }}
      onSubmit={async (body, idempotencyKey) => {
        const saved = await session.createReply(thread, body, idempotencyKey);
        if (saved) {
          setReplyBody("");
          draft.onPosted();
          setExpanded(false);
        }
        return saved;
      }}
      submitLabel="Post reply"
    />
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
