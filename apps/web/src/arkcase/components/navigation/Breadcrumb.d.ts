import React from 'react';

export interface BreadcrumbItem {
  /** Crumb text. */
  label: React.ReactNode;
  /** Makes an ancestor crumb a link that calls this (the default navigation is prevented). */
  onClick?: () => void;
  /** Makes an ancestor crumb a native link to this destination. */
  href?: string;
  /** Draw the label in the data face (Source Code Pro) — for a crumb that is an identifier, a path or a run id, never a person's or organisation's name. @default false */
  mono?: boolean;
  /** A crumb the host renders itself — a `CrumbMenu` trigger, a heading. The trail places it and draws the separators; the node owns its own `aria-current`. */
  node?: React.ReactNode;
  /** In `controls`: this crumb shrinks (and its content truncates) before the others. @default false */
  shrink?: boolean;
}

export interface BreadcrumbProps {
  /** Module → record → section. The last item is the current place. Falsy entries are skipped. */
  items?: (BreadcrumbItem | string | null | false)[];
  /** Accessible name of the navigation landmark. @default "Breadcrumb" */
  label?: string;
  /** `text` is the 12px trail above a title; `controls` is a toolbar trail of host-rendered crumbs (`node`): 12px secondary chevrons, no shrinking except a `shrink` crumb. @default "text" */
  variant?: 'text' | 'controls';
  /** Style overrides for the Breadcrumb root. */
  style?: React.CSSProperties;
}

/** Module → record → section trail; `variant="controls"` places host-rendered crumbs such as `CrumbMenu` triggers. */
export function Breadcrumb(props: BreadcrumbProps): React.JSX.Element;
