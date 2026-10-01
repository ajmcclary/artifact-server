import React from 'react';

export interface MentionComposerPerson {
  /** Display name, inserted after "@" and matched on the start of any of its words. */
  name: string;
  /** A second fact in the list, e.g. "Administrator" or "Agent". */
  detail?: string;
  /** `bi-*` studio icon class for an avatar without a face, e.g. an agent's. */
  icon?: string;
}

export interface MentionComposerContext {
  /** `bi-*` studio icon class leading the line, e.g. "bi-reply". */
  icon?: string;
  /** What is being written: "Replying to Dana Okonkwo · #1". Truncates to one line. */
  text: React.ReactNode;
  /** An × at the line's end that cancels it, with its accessible name. */
  cancel?: { label: string; onClick: () => void };
}

export interface MentionComposerProps {
  /** Controlled draft; the host owns it and clears it after a post. */
  value?: string;
  /** Called with the new draft string on every edit and mention insert. */
  onChange?: (value: string) => void;
  /** Called with the trimmed draft on Cmd/Ctrl+Enter or the send button; never while blank. */
  onSubmit?: (value: string) => void;
  /** Accessible name of the field. */
  label: string;
  /** Hint in the empty field, e.g. "Comment on v7 · @ to mention". */
  placeholder?: string;
  /** Accessible name and tooltip of the send button. @default "Post comment" */
  submitLabel?: string;
  /** Who can be mentioned. */
  people?: MentionComposerPerson[];
  /** The line above the box saying what is being written: a node, or `{ icon, text, cancel }`. */
  context?: React.ReactNode | MentionComposerContext;
  /** Host tools in the box's tool row before the @ button, e.g. "Place on the artifact". */
  tools?: React.ReactNode;
  /** Escape in the field (with the people list closed) — cancel a reply or a pin placement. */
  onEscape?: () => void;
  /** Lines the field starts at. @default 2 */
  rows?: number;
  /** Lines the field grows to before it scrolls. @default 6 */
  maxRows?: number;
  /** Focus the field on mount. @default false */
  autoFocus?: boolean;
  /** Mentions inserted and list matches are spoken here. */
  onAnnounce?: (text: string) => void;
  /** Style overrides for the composer root. */
  style?: React.CSSProperties;
}

/**
 * The docked comment input with @mentions: the prompt CommentComposer, a people list that opens
 * above the box on "@" (↑↓ move, Enter or Tab inserts, Escape closes), a context line above the
 * box and a "will be notified" line under it.
 *
 * @startingPoint section="Forms" subtitle="Docked comment input with @mentions" viewport="420x260"
 */
export function MentionComposer(props: MentionComposerProps): React.JSX.Element;
