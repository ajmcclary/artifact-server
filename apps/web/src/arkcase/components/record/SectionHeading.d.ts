import React from 'react';

export interface SectionHeadingProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'children' | 'title'> {
  /** Heading level of the title element. @default 4; 1 for `size="lg"`, 2 for `size="xl"` */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  /** `md` (alias `default`) 20px, `sm` 18px for a section inside a section, `lg` the 22px page title, `xl` the 26px serif step title under an eyebrow. @default "md" */
  size?: 'sm' | 'md' | 'default' | 'lg' | 'xl';
  /** Visible title for the SectionHeading — the only text inside the heading element. */
  title: React.ReactNode;
  /** `data` sets the title in the data face — tabular figures, 600, `text-navy` — for a heading that is a record identifier (the Portal claim header's claim number). @default "display" */
  titleFace?: 'display' | 'data';
  /** A node directly after the title, before the count chip and meta — typically a StatusPill ("Active", "Hearing Requested"). Rendered outside the heading element, so the heading's name stays the title. */
  badge?: React.ReactNode;
  /** Uppercase 11px navy label above the title — "Step 3", "Run workspace" — or a node such as a `Breadcrumb`. Rendered outside the heading element: text in a `p`, a node in a `div`. */
  eyebrow?: React.ReactNode;
  /** Muted 13px line under the title — the page's one-sentence description. Distinct from the inline `meta`. */
  subtitle?: React.ReactNode;
  /** The count chip — "12 payments". */
  count?: React.ReactNode;
  /** Semantic color treatment of the count. @default "primary" */
  countTone?: 'primary' | 'info';
  /** The reading rule beside the title, 13px secondary. */
  meta?: React.ReactNode;
  /** Container width in px below which the actions stack under the title. The heading wraps itself in a query container. `null` or 0 disables. @default 720 for `lg`/`xl`, none otherwise */
  stackBelow?: number | null;
  /** The section's actions, at the end of the row; they wrap. */
  children?: React.ReactNode;
  /** Style overrides for the SectionHeading root (the query-container wrapper when stacking is on). */
  style?: React.CSSProperties;
}

/**
 * The row a record section opens on: heading, count chip, meta, actions at the
 * end. Heads a run of content; `RecordPanel` boxes one.
 */
export function SectionHeading(props: SectionHeadingProps): React.JSX.Element;
