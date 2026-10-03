import React from 'react';

/** One level of a tab's stack. Hosts add whatever fields their screens need. */
export interface NavEntry {
  /** Stable key; generated when omitted. */
  key?: string;
  /** Document scroll position saved when the level was left; restored on return. */
  scrollY?: number;
  [field: string]: unknown;
}

export interface NavStackState {
  /** The current tab's id. */
  tab: string;
  /** Every tab's stack, root first. */
  stacks: Record<string, NavEntry[]>;
}

export interface NavStackOptions {
  /** One root entry per tab, keyed by tab id, in tab order. @default {} */
  roots?: Record<string, NavEntry>;
  /** Tab shown first. @default the first key of `roots` */
  initialTab?: string;
  /** Mirror pushes into browser history so ‹ Back, the system gesture and the browser agree. `false` keeps state in memory. @default true */
  history?: boolean;
  /** Called with the new state after every change. */
  onChange?: (state: NavStackState) => void;
}

export interface NavStackApi extends NavStackState {
  /** The current tab's stack. */
  stack: NavEntry[];
  /** The current screen. */
  top: NavEntry;
  /** The screen ‹ Back returns to, or null at a root. */
  parent: NavEntry | null;
  /** Levels in the current stack (1 at a root). */
  depth: number;
  /** Whether ‹ Back has somewhere to go. */
  canGoBack: boolean;
  /** Adds a level and a history entry; the new screen starts at the top. */
  push: (entry: NavEntry) => void;
  /** Returns one level, restoring that screen's scroll position. */
  pop: () => void;
  /** Returns to the level at `index` (0 is the tab's root). */
  popTo: (index: number) => void;
  /** Shows another tab with its stack intact; the current tab again returns to its root, or scrolls a root to the top. */
  switchTab: (tab: string) => void;
  /** Merges fields into the current level without a history entry — a section change, say. */
  update: (patch: Partial<NavEntry>) => void;
}

/** The phone's navigation model: a stack per tab, kept in step with browser history and scroll position. */
export function useNavStack(options?: NavStackOptions): NavStackApi;

export interface NavStackProps extends NavStackOptions {
  /** Renders the screen from the stack. */
  children?: (nav: NavStackApi) => React.ReactNode;
}

/** The component twin of `useNavStack` for portable templates, which see only capitalised exports. */
export function NavStack(props: NavStackProps): React.JSX.Element | null;
