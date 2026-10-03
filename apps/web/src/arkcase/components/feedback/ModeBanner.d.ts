import React from 'react';

/** The single way out of the mode. */
export interface ModeBannerAction {
  /** Visible button text; include the shortcut the host handles, e.g. "Cancel (Esc)". */
  label: string;
  /** Called when the action is activated; the host leaves the mode. */
  onClick: (e: React.MouseEvent) => void;
  /** Optional leading `bi-*` icon class, e.g. "bi-arrow-left". */
  icon?: string;
}

export interface ModeBannerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'children' | 'role' | 'title'> {
  /** `floating` is a navy pill absolutely centred 14px above the bottom of its positioned parent; `bar` is a full-width navy strip; `card` is a light card ruled in primary (`shadow-sm`, 5px radius) for a mode that edits the page in place, e.g. a dashboard in configuration. @default 'floating' */
  variant?: 'floating' | 'bar' | 'card';
  /** Leading `bi-*` icon class, e.g. "bi-crosshair"; rendered tonal on navy, or in a 28px primary-tint disc on `card`. */
  icon?: string;
  /** `card`: the mode's name in 14px 600 above the message, e.g. "Configuration Mode". On `floating` and `bar` a string is kept as the native `title` attribute, as before. */
  title?: React.ReactNode;
  /** The message naming the mode, e.g. "Click a point in the artifact"; on `card` the 13px secondary hint under `title`. */
  children?: React.ReactNode;
  /** Secondary data text (host, version id) in the data face and `text-on-navy-secondary`. */
  meta?: React.ReactNode;
  /** Exit action: a small outlined-on-navy pill (floating) or a primary sm Button (bar, card). */
  action?: ModeBannerAction;
  /** `card` only: the mode's own controls (a Columns picker, a clamp note), inline after the title block; they wrap beneath it on narrow widths. */
  controls?: React.ReactNode;
  /** `card` only: trailing buttons pushed to the end (Inspector, Add Widget), rendered before `action`. */
  actions?: React.ReactNode;
  /** ARIA role of the banner; `status` announces the mode politely when it appears. @default 'status' */
  role?: string;
  /** Style overrides for the ModeBanner root. */
  style?: React.CSSProperties;
}

/** Banner announcing a temporary mode, with its exit action: a navy pill or strip, or a light primary-ruled card. */
export function ModeBanner(props: ModeBannerProps): React.JSX.Element;
