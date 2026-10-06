import {useEffect, useMemo, useState} from "react";
import {z} from "zod";

import {api, type ActivityEntry} from "@/api/client";
import {CommentComposer} from "@/components/comments/comment-composer";
import {useCommentDraft} from "@/components/comments/comment-drafts";
import {maximumCommentBodyCharacters} from "@/components/comments/comment-limits";
import {createRequestLimiter} from "@/lib/request-limiter";
import {readStored, writeStored} from "@/lib/safe-storage";
import {navigateReview, workspaceHref} from "@/review/review-routes";
import {type ActivityArtifactGroup, type ActivityEntry as OpenedEntry, ActivityFeed} from "@/ui/review-ui";
import {useToasts} from "@/ui/toasts";

import {feedEntries, mergedFeed, openTarget, thumbnailEntry, toFeedEvents} from "./activity-adapter";
import type {ActivityFeedState} from "./use-activity-feed";

const expandedKey = "activity-expanded-threads";
const openGroupsKey = "activity-open-groups";

type WireComment = NonNullable<ActivityEntry["thread"]>["opener"];

/** A conversation entry with the artifact and project it needs for Reply, Resolve and fetching. */
interface ThreadContext {
  readonly artifact: {readonly id: string; readonly name: string};
  readonly entry: ActivityEntry;
  readonly projectId: string;
  readonly thread: NonNullable<ActivityEntry["thread"]>;
}

/** Each conversation's context, from its own entry (a resolution's copy only when its entry is not loaded). */
function threadContexts(entries: readonly ActivityEntry[]): Map<string, ThreadContext> {
  const contexts = new Map<string, ThreadContext>();
  for (const entry of entries) {
    if (entry.thread === undefined || entry.artifact === null || entry.project === null) continue;
    if (entry.kind !== "thread" && contexts.has(entry.thread.id)) continue;
    contexts.set(entry.thread.id, {artifact: entry.artifact, entry, projectId: entry.project.id, thread: entry.thread});
  }
  return contexts;
}
const hydrate = createRequestLimiter(4);
// Each longer conversation's full replies, by the reply count the feed reported, for this tab.
const hydratedReplies = new Map<string, {readonly replies: readonly WireComment[]; readonly replyCount: number}>();
const hydratingThreads = new Set<string>();

const expandedSchema = z.array(z.string());

/** Ids kept open for this tab: expanded threads, or open bursts. */
function readIds(key: string): string[] {
  try {
    const parsed = expandedSchema.safeParse(JSON.parse(readStored("session", key) ?? "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function toggled(current: readonly string[], id: string, open: boolean, key: string): string[] {
  const next = open ? [...new Set([...current, id])] : current.filter((known) => known !== id);
  writeStored("session", key, JSON.stringify(next));
  return next;
}

function ReplyComposer({context, onDone, onPosted, principalId}: {
  readonly context: ThreadContext; readonly onDone: () => void; readonly onPosted: (entry: ActivityEntry) => void; readonly principalId: string;
}) {
  const {artifact, entry, projectId, thread} = context;
  const toasts = useToasts();
  const draft = useCommentDraft({artifactId: artifact.id, principalId, threadId: thread.id, versionId: null});
  return (
    <CommentComposer
      autoFocus cancelLabel="Cancel" draftRestored={draft.restored} initialBody={draft.initialBody}
      label={`Reply on ${artifact.name}`} maximumCharacters={maximumCommentBodyCharacters}
      onBodyChange={draft.onBodyChange} onCancel={onDone} onDiscardDraft={draft.onDiscard}
      onSubmit={async (body, idempotencyKey) => {
        try {
          const {reply} = await api.createCommentReply(projectId, artifact.id, thread.id, body, idempotencyKey);
          draft.onPosted();
          const shown = {author: {kind: reply.author.principalKind, name: reply.author.displayName}, body: reply.body, createdAt: reply.createdAt, id: reply.id};
          onPosted({...entry, actor: {kind: reply.author.principalKind, name: reply.author.displayName}, at: reply.createdAt,
            id: `local:${reply.id}`, kind: "thread", thread: {...thread, replies: [...thread.replies, shown], replyCount: thread.replyCount + 1}, verb: "replied"});
          onDone();
          return true;
        } catch {
          toasts.push({message: "Your reply is kept as a draft. Try again.", title: "Reply not posted", variant: "danger"});
          return false;
        }
      }}
      submitLabel="Reply"
    />
  );
}

/** The feed body shared by Activity and a project's Activity section. */
export function ActivityFeedPanel({density = "comfortable", feed, filtered, label, onChanged, onClearFilters, principalId, renderThumbnail, stickyTop}: {
  readonly density?: "comfortable" | "compact";
  readonly feed: ActivityFeedState; readonly filtered: boolean; readonly label: string;
  /** Called after a reply or a resolve lands, so counts read beside the feed can re-read. */
  readonly onChanged?: (() => void) | undefined;
  readonly onClearFilters: () => void;
  readonly principalId: string;
  /** Draws an artifact card's screen from the conversation it chose (`thumbnailEntry`). */
  readonly renderThumbnail?: (entry: ActivityEntry, artifactName: string) => React.ReactNode; readonly stickyTop: number;
}) {
  const toasts = useToasts();
  const [expanded, setExpanded] = useState<string[]>(() => readIds(expandedKey));
  const [openGroups, setOpenGroups] = useState<string[]>(() => readIds(openGroupsKey));
  const [replying, setReplying] = useState<string | null>(null);
  const events = useMemo(() => mergedFeed(toFeedEvents(feed.entries)), [feed.entries]);
  const entries = useMemo(() => feedEntries(events), [events]);
  const byThread = useMemo(() => threadContexts(feed.entries), [feed.entries]);
  const byEvent = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);

  // The snapshot holds the newest two replies, and the vendored fold counts only loaded replies,
  // so each longer conversation's replies are read once per reply count and reused across refreshes.
  const {replaceThread} = feed;
  useEffect(() => {
    for (const {artifact, projectId, thread} of byThread.values()) {
      if (thread.replyCount <= thread.replies.length) continue;
      const known = hydratedReplies.get(thread.id);
      if (known !== undefined && known.replyCount === thread.replyCount) {
        replaceThread(thread.id, {...thread, replies: [...known.replies], replyCount: known.replies.length});
        continue;
      }
      if (hydratingThreads.has(thread.id)) continue;
      hydratingThreads.add(thread.id);
      void (async () => {
        try {
          const details = await hydrate(() => api.comment(projectId, artifact.id, thread.id));
          const replies = details.replies.map((reply) => ({
            author: {kind: reply.author.principalKind, name: reply.author.displayName}, body: reply.body, createdAt: reply.createdAt, id: reply.id,
          }));
          // Keyed by the count the feed reported, so the same snapshot never triggers another read.
          hydratedReplies.set(thread.id, {replies, replyCount: thread.replyCount});
          // Applied by thread id, so a refresh that landed meanwhile still gets the full replies.
          replaceThread(thread.id, {...thread, replies, replyCount: replies.length});
        } catch {
          // The two newest replies stay shown; the fold simply offers nothing earlier.
        } finally {
          hydratingThreads.delete(thread.id);
        }
      })();
    }
  }, [byThread, replaceThread]);

  // An event opens its artifact; an artifact card opens its newest conversation; a burst's items open one by one.
  const open = (entry: OpenedEntry): void => {
    const target = openTarget(entry, byEvent);
    if (target !== null) navigateReview(workspaceHref({...target, view: null}));
  };
  const resolve = async (threadKey: string, next: boolean): Promise<void> => {
    const context = byThread.get(threadKey);
    if (context === undefined) return;
    try {
      const saved = await api.updateComment(context.projectId, context.artifact.id, threadKey, {state: next ? "resolved" : "open"});
      feed.replaceThread(threadKey, {...context.thread, isResolved: saved.state === "resolved", state: saved.state === "resolved" ? "resolved" : "needs_you"});
      feed.reload();
      onChanged?.();
    } catch {
      toasts.push({message: "The conversation was not changed. Try again.", title: next ? "Not resolved" : "Not reopened", variant: "danger"});
    }
  };

  return (
    <ActivityFeed
      density={density}
      events={entries}
      expandedIds={expanded}
      filtered={filtered}
      hasMore={feed.hasMore}
      label={label}
      now={Date.now()}
      onClearFilters={onClearFilters}
      onOpen={open}
      onReply={(threadKey) => setReplying((current) => current === threadKey ? null : threadKey)}
      onResolve={(threadKey, next) => void resolve(threadKey, next)}
      onShowOlder={feed.loadOlder}
      onToggleGroup={(id, isOpen) => setOpenGroups((current) => toggled(current, id, isOpen, openGroupsKey))}
      onToggleReplies={(threadKey, isOpen) => setExpanded((current) => toggled(current, threadKey, isOpen, expandedKey))}
      openGroups={openGroups}
      remaining={0}
      renderReplyComposer={(threadKey) => {
        const context = byThread.get(threadKey);
        return replying !== threadKey || context === undefined ? null : (
          <ReplyComposer context={context} onDone={() => setReplying(null)} onPosted={(local) => {
            feed.insertLocal(local);
            feed.reload();
            onChanged?.();
          }} principalId={principalId} />
        );
      }}
      {...(renderThumbnail === undefined ? {} : {
        renderThumbnail: (group: ActivityArtifactGroup) => {
          const chosen = thumbnailEntry(group, byEvent);
          return chosen === null ? null : renderThumbnail(chosen, group.artifactName);
        },
      })}
      stickyTop={stickyTop}
    />
  );
}
