import React from 'react';
import type { StatusPillProps } from './StatusPill';

export interface MetricCardProps {
  /** Caption above the value, e.g. "Claims Received". */
  label: string;
  /** Large primary figure, e.g. "248" or "94.8%". */
  value: string;
  /** Trend / context line below the value. */
  subtext?: string;
  /** @default "none" */
  /** Trend value and direction shown with the metric. */
  trend?: 'up' | 'down' | 'none';
  /** Color of the trend arrow. @default "secondary" */
  trendColor?: 'success' | 'danger' | 'warning' | 'info' | 'primary' | 'secondary';
  /** Tint + accent color. `navy` is the `surface-navy-subtle` wash with a navy rule. @default "info" */
  color?: 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info' | 'light' | 'navy';
  /** Show the 4px left accent rule (vs. full hairline border). @default true */
  borderStart?: boolean;
  /**
   * Render the big value in the data font (`var(--font-data)` + tabular-nums).
   * Set it for amounts, counts and durations: display-scale figures keep the
   * data font at every size so stacked metrics align and a total lines up with
   * the mono column it sums. Leave off for word values ("Medical Only").
   * Never switch the value to the serif display face — its figures are
   * proportional. @default false
   */
  dataFont?: boolean;
  /** Tinted tile with accent rule, or the plain card surface with hairline border and shadow. @default "tinted" */
  variant?: 'tinted' | 'surface';
  /** Leading `bi-*` studio icon class shown before the label, e.g. "bi-images". */
  icon?: string;
  /** StatusPill shown at the end of the label row. */
  status?: { tone: NonNullable<StatusPillProps['tone']>; label: string };
  /** Unit text after the value, e.g. "snapshots". */
  unit?: string;
  /** Change line in the data font beneath the subtext, e.g. "+3 since #481". */
  delta?: React.ReactNode;
  /** Semantic text tone of the delta line. @default "neutral" */
  deltaTone?: 'success' | 'danger' | 'warning' | 'neutral';
  /** Makes the whole tile a native button that calls this on activation. */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Toggle state of a clickable tile, exposed as aria-pressed with a selected border. */
  pressed?: boolean;
  /** `sm` is the compact strip tile — reserve, report and audit strips: 12px 14px padding, a one-line 13px caption (ellipsis, full text in its title) and a 20px/600 value. @default "md" */
  size?: 'sm' | 'md';
  /** `eyebrow` sets the caption as an 11px/600 uppercase label in the colour's text-safe ink (`text-link-hover` for primary and info, `text-navy`, or the pill foreground) — the benefit and report tiles. @default "default" */
  labelVariant?: 'default' | 'eyebrow';
  /** Style overrides for the MetricCard root. */
  style?: React.CSSProperties;
}

/**
 * Dashboard KPI tile — tinted background, left accent rule, trend indicator;
 * or a surface tile with icon, status pill, unit and delta that can act as a button.
 *
 * @startingPoint section="Data Display" subtitle="KPI metric tiles with trend" viewport="700x150"
 */
export function MetricCard(props: MetricCardProps): React.JSX.Element;
