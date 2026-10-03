import React from 'react';

/** Pill tones for a row's trailing badge (the `pill-<tone>-bg` / `pill-<tone>-fg` pairs). */
export type TreeBadgeTone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

export interface TreeBadge {
  /** Visible value in the data face, usually a count. */
  value?: React.ReactNode;
  /** Pill colour pair. @default "primary" */
  tone?: TreeBadgeTone;
  /** Optional `bi-*` icon before the value. */
  icon?: string;
  /** Spoken meaning (e.g. "3 open findings"); read instead of the bare value and shown as its tooltip. */
  label?: string;
}

/** Ink tones for a row's status markers (text-safe tokens: `text-secondary`, `text-info-on-tint`, `pill-warning-fg`, `pill-danger-fg`, `text-link`). */
export type TreeMarkerTone = 'neutral' | 'info' | 'warning' | 'danger' | 'primary';

/** A small status glyph after a row's label, e.g. `{ icon: 'bi-lock', label: 'Required' }`. */
export interface TreeMarker {
  /** `bi-*` icon drawn at 11px. */
  icon: string;
  /** Meaning of the glyph; shown as its tooltip and spoken in the row's description. */
  label: string;
  /** Glyph ink; selected rows use the row ink instead. @default "neutral" */
  tone?: TreeMarkerTone;
}

export interface TreeNode {
  /** Unique, stable id; used by `expanded`, `selected` and the callbacks. */
  id: string;
  /** Row text; also the typeahead and `query` target. */
  label: string;
  /** Optional `bi-*` icon shown after the chevron. */
  icon?: string;
  /** Icon colour for an unselected row (makes the icon tonal); selected rows use the row ink. */
  iconColor?: string;
  /** Child nodes; a node with children is a branch and gets a chevron and `aria-expanded`. */
  children?: TreeNode[];
  /** Render as a sticky uppercase section header (level 1, collapsible, not selectable). @default false */
  section?: boolean;
  /** Trailing count pill. */
  badge?: TreeBadge;
  /** Status glyphs after the label and before `meta`; each has a tooltip and is spoken in the row's description, not its name. */
  markers?: TreeMarker[];
  /** Trailing 11px data-face text in `text-secondary` (e.g. a kind or bound key), ellipsized at the tree's `metaWidth`; spoken in the row's description, not its name. */
  meta?: React.ReactNode;
  /** The row a host is moving by keyboard: a dashed `bs-primary` inset outline on the selected tint (instead of the solid selected fill), and ", moving" appended to its description. @default false */
  picked?: boolean;
  /** Announced as disabled (`aria-disabled`) and cannot be selected; stays focusable. @default false */
  disabled?: boolean;
}

/** One visible row, as `flattenTree` computes it. */
export interface TreeRow {
  /** The node's id. */
  id: string;
  /** The source node. */
  node: TreeNode;
  /** The node's label. */
  label: string;
  /** 1-based nesting level (`aria-level`). */
  level: number;
  /** Indent steps; section headers do not add one. */
  depth: number;
  /** Id of the parent row, or null at the root. */
  parentId: string | null;
  /** The node has children. */
  hasChildren: boolean;
  /** The branch is shown open (expanded, or forced by a filter). */
  open: boolean;
  /** Opened by a filter because a descendant matches; Left does not collapse it. */
  forced: boolean;
  /** The node is a section header. */
  section: boolean;
  /** 1-based position among its visible siblings (`aria-posinset`). */
  posinset: number;
  /** Number of visible siblings (`aria-setsize`). */
  setsize: number;
}

/** Inputs to `flattenTree`. */
export interface FlattenTreeOptions {
  /** Ids of the expanded branches. @default [] */
  expanded?: string[];
  /** Case-insensitive label substring; ancestors of matches are forced open. @default "" */
  query?: string;
  /** Extra predicate a node must pass to match. */
  filter?: (node: TreeNode) => boolean;
}

export interface TreeViewProps {
  /** The tree data. */
  nodes?: TreeNode[];
  /** Accessible name of the tree (`aria-label`). */
  label?: string;
  /** Controlled ids of the expanded branches and sections; omit for internal state. */
  expanded?: string[];
  /** Initially expanded ids when `expanded` is uncontrolled. @default [] */
  defaultExpanded?: string[];
  /** Called with the next expanded ids when a branch is toggled or `*` expands siblings. */
  onExpandedChange?: (ids: string[]) => void;
  /** Controlled id of the selected row; omit for internal state. */
  selected?: string | null;
  /** Called with the node when a row is selected by click, Enter or Space. */
  onSelect?: (node: TreeNode) => void;
  /** Enter, Space and a click select a branch instead of toggling it; Right/Left and a click on its chevron still expand and collapse. @default false */
  selectBranches?: boolean;
  /** Label filter text; matching rows and their ancestors are shown. @default "" */
  query?: string;
  /** Predicate a node must also pass to match (e.g. a type filter). */
  filter?: (node: TreeNode) => boolean;
  /** Message shown instead of the tree when nothing matches. @default "No items match." */
  emptyMessage?: React.ReactNode;
  /** Called on Shift+F10 or the ContextMenu key with the focused node and its row rectangle; rows then announce `aria-haspopup="menu"`. */
  onContextMenu?: (node: TreeNode, rect: DOMRect) => void;
  /** When given, rows show a hover/focus "…" button that calls this with the node and the button rectangle. */
  onMore?: (node: TreeNode, rect: DOMRect) => void;
  /** Tooltip for the "…" button. @default (node) => `More actions for ${node.label}` */
  moreLabel?: (node: TreeNode) => string;
  /** Called for every keydown inside the tree before the built-in handling, with the focused row (null when focus is not in a row). Call `event.preventDefault()` to skip the built-in handling, e.g. for a keyboard "pick up and move" mode. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>, row: TreeRow | null) => void;
  /** Maximum width in px of a row's trailing `meta` text before it ellipsizes. @default 90 */
  metaWidth?: number;
  /** Ref to the `role="tree"` element, so a host search box can move focus into it (null while the empty message shows). */
  treeRef?: React.Ref<HTMLDivElement>;
  /** Style overrides for the scrolling container (set its height or flex here). */
  style?: React.CSSProperties;
}

/** A data-driven, single-select WAI-ARIA tree with sections, badges, status markers, filtering, row actions and host key handling. */
export function TreeView(props: TreeViewProps): React.JSX.Element;

/** The visible rows for `nodes` under the expanded ids and filters, in display order. */
export function flattenTree(nodes: TreeNode[], options?: FlattenTreeOptions): TreeRow[];

/** Every branch id (sections included), depth-first — the input to "expand all". */
export function allBranchIds(nodes: TreeNode[]): string[];

/** The number of leaves for which `predicate` holds; all leaves when omitted. */
export function countLeaves(nodes: TreeNode[], predicate?: (node: TreeNode) => boolean): number;

/** Ids from the root down to the node's parent (to reveal a row), or null when absent. */
export function ancestorIds(nodes: TreeNode[], id: string): string[] | null;
