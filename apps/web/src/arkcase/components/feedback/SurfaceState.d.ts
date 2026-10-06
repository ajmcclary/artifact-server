import React from 'react';

export interface SurfaceStateRestriction {
  /** The unit that holds the access, named in the copy. */
  unit: string;
  /** Called when the reader activates Request Access. */
  onRequest?: () => void;
  /** Replaces the "Restricted for your role" title, e.g. "Legal Review is restricted". */
  title?: string;
  /** Replaces the sentence naming `unit`, for a product's own restriction copy. */
  body?: string;
}

export interface SurfaceStateProps {
  /** @default "ready" */
  /** Current loading, empty, failed, or restricted state. */
  phase?: 'ready' | 'loading' | 'failed';
  /** Rows the surface holds. With phase "ready" and a count above 0, renders nothing. */
  count?: number;
  /** Plural noun for the copy — "cases", "investigations", "documents". @default "records" */
  noun?: string;
  /** True when filters are applied — switches the empty copy to the filtered wording. */
  filtered?: boolean;
  /** Present when the signed-in role may not see these records. */
  restricted?: SurfaceStateRestriction;
  /** Skeleton row count while loading. @default 5 */
  skeleton?: number;
  /** Icon used by the empty state. */
  emptyIcon?: string;
  /** Heading used by the empty state. */
  emptyTitle?: string;
  /** Explanatory sentence used by the empty state; the whole message when `density` is `inline`. */
  emptyBody?: string;
  /** Visible label of the state action. */
  actionLabel?: string;
  /** Icon placed beside the state action label. */
  actionIcon?: string;
  /** Called when the primary action is activated. */
  onAction?: () => void;
  /** Called when the user retries the failed operation. */
  onRetry?: () => void;
  /** Called when the user clears the current filter or selection. */
  onClear?: () => void;
  /** Explanation shown for a filtered-empty result. */
  filterBody?: string;
  /** `block` is the centred hero state; `inline` is one muted line with an optional leading icon and a link-weight action. @default "block" */
  density?: 'block' | 'inline';
  /** `dashed` draws the state in a dashed, rounded box on the card surface. @default "plain" */
  variant?: 'plain' | 'dashed';
  /** Renders the block title as a heading of this level (`h1`–`h6`) instead of a `div` — e.g. 1 when the state is the whole page, such as an unknown route. Visual size is unchanged. Ignored by `inline`. */
  titleLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** A second action beside the primary one: an outline secondary button (a link-weight button inline). */
  secondaryAction?: { label: string; icon?: string; onClick: () => void };
  /** Extra attributes for the primary action's button, e.g. `{ 'data-route': '/runs' }`. */
  actionProps?: Record<string, unknown>;
  /** Block states: a 13px secondary footnote under the body, e.g. "Signed in as Case Manager" on a restricted page. Not drawn by `inline`. */
  meta?: React.ReactNode;
  /** `bi-*` glyph before `meta`, e.g. "bi-person-badge". Decorative. */
  metaIcon?: string;
  /** Replaces the failed title "Could not load {noun}", e.g. "Report server did not respond". */
  failedTitle?: string;
  /** Replaces the failed sentence about the case service, e.g. "Nothing was generated. Try again." */
  failedBody?: string;
  /** Loading presentation: `skeleton` rows while a list fills, or `spinner` — a busy ring over a title and body — for a job the reader started (generating a report). Inline loading gains a 14px ring. @default "skeleton" */
  loadingStyle?: 'skeleton' | 'spinner';
  /** Spinner loading title (and the inline loading line). @default "Loading {noun}" */
  loadingTitle?: string;
  /** Spinner loading sentence under the title, e.g. "Contacting the Pentaho report server." */
  loadingBody?: string;
  /** `warning` draws the `dashed` box in the warning hairline and the empty icon in warning, for a slot waiting on the reader ("Not yet scheduled"). @default "default" */
  tone?: 'default' | 'warning';
  /** The ground the state sits on. `dark` is the document viewer's gray-800 page well: a `text-on-navy` title, `text-on-navy-secondary` body, meta and inline line, the failed and filtered glyphs in `bs-warning`, a solid primary action and an on-navy outline secondary action (inline actions use the `navy` button), `border-on-navy` skeleton bars and a light dashed box. The host paints the dark ground; the state stays transparent. @default "light" */
  surface?: 'light' | 'dark';
  /** Style overrides for the SurfaceState root. */
  style?: React.CSSProperties;
}

/** Empty, loading, failed and restricted states for any list, grid or panel. */
export function SurfaceState(props: SurfaceStateProps): React.JSX.Element | null;
