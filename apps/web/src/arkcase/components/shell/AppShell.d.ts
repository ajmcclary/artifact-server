import React from 'react';
import { DisplayLadder, DisplayProfileForce } from './DisplayProfile';

export type AppShellChrome = 'left' | 'top';

export interface AppShellProps {
  /**
   * `left` gives the navigation column the full viewport height and omits the
   * top bar/module strip; `top` renders the traditional bar and optional strip
   * above the navigation/content row. @default "left"
   */
  chrome?: AppShellChrome;
  /** Pin the display profile, as the App's Display tweak does. @default null */
  force?: DisplayProfileForce | string | null;
  /** Breakpoint ladder; the ArkCase default ladder (768 / 900 / 1100 / 1440) when omitted. */
  ladder?: DisplayLadder;
  /** The app bar — a `TopNav`; rendered only when `chrome="top"`. */
  bar?: React.ReactNode;
  /** The module strip under the bar; rendered only when `chrome="top"`. */
  strip?: React.ReactNode;
  /** The side navigation — a `SideNav` in rail, expanded or peek mode. Omitted on `mobile`. */
  nav?: React.ReactNode;
  /** The phone navigation — a `MobileNavDrawer`. Rendered only on `mobile`. */
  drawer?: React.ReactNode;
  /**
   * The phone's top bar — a `MobileAppBar`. Rendered only on `mobile`; with it (or `tabBar`) the
   * frame switches to document scroll and `main` pads past the fixed bars.
   */
  appBar?: React.ReactNode;
  /** The phone's bottom navigation — a `MobileTabBar`. Rendered only on `mobile`; see `appBar`. */
  tabBar?: React.ReactNode;
  /** The end-side panel — a `Panel` or `SlideOver`. */
  aside?: React.ReactNode;
  /** A status row under the content. */
  status?: React.ReactNode;
  /** Text for the polite live region. */
  announce?: React.ReactNode;
  /** Text for the assertive live region. */
  alert?: React.ReactNode;
  /** `id` of the `<main>` the skip link targets. @default "ak-main" */
  mainId?: string;
  /** @default "Skip to main content" */
  /** Accessible label of the skip link to main content. */
  skipLabel?: string;
  /** Merged onto `<main>`. */
  mainStyle?: React.CSSProperties;
  /**
   * When `force` pins a profile whose ladder width (`ladder.widths`) is narrower than the real
   * window, draw the shell as a centred column at that width, with `shadow-lg` and hairline
   * side borders, and set the phone `drawer` element's `style.left` so the drawer opens inside
   * the column (a `style.left` the host already set wins). Opt-in, because some hosts frame the
   * shell themselves; `style` still merges last. Re-measured on window resize. @default false
   */
  frame?: boolean;
  /** Merged onto the root. */
  style?: React.CSSProperties;
  /** Working content rendered inside the main landmark. */
  children?: React.ReactNode;
}

/**
 * The frame every workstation screen sits in: a DisplayProfile root with
 * `data-ac-profile`, one of two chrome arrangements, the nav + main + aside
 * row, the status row, the drawer on mobile, and the two live regions every
 * announcing control hands its text to. Left navigation is the default;
 * `chrome="top"` restores the traditional bar and optional module strip. On a
 * phone, `appBar` and `tabBar` replace the drawer launcher with document scroll.
 *
 * @startingPoint section="Shell" subtitle="App frame: bar, strip, nav, main, aside, status" viewport="1280x720"
 */
export function AppShell(props: AppShellProps): React.JSX.Element;
