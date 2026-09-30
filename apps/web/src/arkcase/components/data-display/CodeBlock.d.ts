import React from 'react';

/** Copy control options for CodeBlock. */
export interface CodeBlockCopy {
  /** Accessible name and tooltip of the copy button. @default "Copy" */
  label?: string;
  /** The host's clipboard write, called on activation. */
  onCopy: (e: React.MouseEvent) => void;
  /** Tooltip and announcement while the copied state holds, e.g. "Command copied". */
  copiedLabel?: string;
  /** Receives the confirmation text; hand it the shell's live region. */
  onAnnounce?: (text: string) => void;
}

export interface CodeBlockProps extends Omit<React.HTMLAttributes<HTMLPreElement>, 'style' | 'children'> {
  /** The code, markup or output to show verbatim; whitespace is preserved. A string is the usual case; nodes are accepted too, so annotation markup survives — `<b>` for what to type and `<i>` for commentary in the `annotated` variant. With `copy`, a node tree is read for line breaks (text `\n` or `<br>`) to align the button. */
  children?: React.ReactNode;
  /** `neutral` is code on the panel-cap ground; `danger` is error output on the danger pill tint;
   *  `navy` is a command well on `surface-header` with `text-on-navy` (commands, endpoint URLs).
   *  @default 'neutral' */
  tone?: 'neutral' | 'danger' | 'navy';
  /** `annotated` is the document specimen block of the Template Practices pages: square, a 2px `bs-primary` left rule on the stripe ground, body ink at 11.5px, never split across a printed page; `<b>`/`<strong>` inside draw in `text-link-on-tint` 600 and `<i>`/`<em>` in `text-secondary`, upright. It replaces `tone`'s colours.
   *  @default 'default' */
  variant?: 'default' | 'annotated';
  /** Soft-wrap long lines (pre-wrap). When false, lines keep their length and the block scrolls horizontally.
   *  @default true */
  wrap?: boolean;
  /** Accessible name. Makes the block a named region, and a tab stop whenever it can scroll. Required when `wrap` is false or `maxHeight` is set. */
  label?: string;
  /** Cap the block's height (CSS length or px); taller content scrolls vertically. */
  maxHeight?: number | string;
  /** Docks the shared icon-only CopyButton at the block's end (vertically centred for single-line content). The host performs the clipboard write. */
  copy?: CodeBlockCopy;
  /** Style overrides (applied to the outer box when `copy` is set), e.g. `borderTop` and `borderRadius: 0` when the block docks under a preview. */
  style?: React.CSSProperties;
}

/** Block of preformatted code or command output in the data face. */
export function CodeBlock(props: CodeBlockProps): React.JSX.Element;
