import React from 'react';

/** One comment, or one reply inside a thread. */
export interface CommentItem {
  /** Stable id passed back to `onReply`, `onResolve` and `renderReplyComposer`. */
  id: string;
  /** Person who wrote the comment — drives the avatar and the "Comment by …" name; stays in the sans. */
  author: string;
  /** When it was written, already formatted (e.g. `fmt.clock` or "2h ago"); rendered in the data face. */
  time?: React.ReactNode;
  /** The comment body. */
  text: React.ReactNode;
  /** One level of replies, indented behind a 2px rule; replies do not nest further. */
  replies?: CommentItem[];
  /** Resolved threads are muted onto the secondary surface with a Resolved pill (top-level only). */
  resolved?: boolean;
  /** Leading marker before the avatar, e.g. a numbered pin badge. */
  badge?: React.ReactNode;
  /** One-line summary shown under a collapsed thread in a selectable list, e.g. "Replied by Claude · 11:20". */
  activity?: React.ReactNode;
}

export interface CommentThreadProps {
  /** Threads in display order; an empty list shows `emptyMessage`. */
  comments?: CommentItem[];
  /** Shows a ghost "Reply" action on each thread; called with the thread id. */
  onReply?: (id: string) => void;
  /** Shows a ghost "Resolve" / "Reopen" action; called with the thread id and the requested resolved state. */
  onResolve?: (id: string, next: boolean) => void;
  /** `comfortable` = 24px avatars and 14px copy (side panel); `compact` = 20px avatars and 13px copy (inspector). @default "comfortable" */
  density?: 'comfortable' | 'compact';
  /** Slot under a thread's replies, e.g. a CommentComposer for the thread being replied to; return null for the others. */
  renderReplyComposer?: (id: string) => React.ReactNode;
  /** Extra actions after Reply / Resolve on a thread (e.g. "Send to agent"); return null for none. In a selectable list only the selected thread shows actions. */
  renderActions?: (id: string) => React.ReactNode;
  /** Id of the open thread in a selectable list; the others collapse to a two-line summary. */
  selectedId?: string | null;
  /** Makes the list selectable: each thread summary is a toggle button reporting its id (the host decides whether a second press collapses it). */
  onSelect?: (id: string) => void;
  /** Text shown when there are no comments. @default "No comments yet." */
  emptyMessage?: string;
  /** Accessible name for the thread list, e.g. "Comments on Build 482". */
  'aria-label'?: string;
  /** Style overrides for the list root. */
  style?: React.CSSProperties;
}

/**
 * Comment threads with replies and optional Reply / Resolve actions — a list of articles named "Comment by <author>".
 */
export function CommentThread(props: CommentThreadProps): React.JSX.Element;
