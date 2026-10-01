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
}

export interface BreadcrumbProps {
  /** Module → record → section. The last item is the current place. */
  items?: (BreadcrumbItem | string)[];
  /** Style overrides for the Breadcrumb root. */
  style?: React.CSSProperties;
}

/** Module → record → section trail. */
export function Breadcrumb(props: BreadcrumbProps): React.JSX.Element;
