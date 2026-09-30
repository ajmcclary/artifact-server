import React from 'react';

export interface AccountButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'onClick' | 'role'> {
  /** The signed-in person's display name; drives the avatar initials and colour. */
  name: string;
  /** Subtitle under the name — the role or the account, e.g. "Administrator". */
  role?: string;
  /** Explicit avatar initials; derived from `name` when omitted. */
  initials?: string;
  /** Avatar photo URL; initials are drawn when omitted. */
  src?: string;
  /** Rail form: the avatar alone in a 36px circle, with the name and role as a fixed tooltip to the right. Ignored when `placement="bar"`. @default false */
  rail?: boolean;
  /** Where the button sits: `nav` is the navigation-column row (or rail circle); `bar` is the navy top bar — a leading `border-on-navy` divider, a 34px avatar, the name (13px, `text-on-navy`) over the role (11px, `text-on-navy-secondary`) and a trailing chevron-down, with `surface-navy-strong` on hover and while open. @default "nav" */
  placement?: 'nav' | 'bar';
  /** With `placement="bar"`: the avatar and chevron only; the name and role stay in the accessible name. @default false */
  compact?: boolean;
  /** Whether the menu it opens is open — sets `aria-expanded` and holds the hover fill. Omit when it opens nothing. */
  expanded?: boolean;
  /** Opens the account menu; the event's `currentTarget` is a good anchor for the menu or a DemoPanel. */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** `aria-haspopup` value; pass null for a plain button. @default "menu" */
  hasPopup?: 'menu' | 'dialog' | 'listbox' | 'true' | null;
  /** Accessible name override. @default "Account menu: {name}, {role}" */
  label?: string;
  /** Style overrides for the button. */
  style?: React.CSSProperties;
}

/** The signed-in person at the foot of the navigation, and the button that opens their account menu. */
export declare function AccountButton(props: AccountButtonProps): React.JSX.Element;
