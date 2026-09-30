import React from 'react';

export interface StatusPillProps {
  /** Status value — auto-mapped: active→green, closed→red, archived→blue, inactive→purple, pending→amber. */
  status?: 'Active' | 'Inactive' | 'Closed' | 'Archived' | 'Pending' | string;
  /** Override the color tone directly. `critical` is the only solid fill (#D83506 on white). */
  tone?: 'success' | 'danger' | 'warning' | 'primary' | 'secondary' | 'neutral' | 'critical';
  /** Override the display text (defaults to a Title-Cased status). */
  label?: string;
  /** Leading ArkCase icon class, e.g. "bi-lock-fill" for an indicator badge. */
  icon?: string;
  /** Computed value — draws a dashed border so a derived value reads as derived, not stored. @default false */
  computed?: boolean;
  /** Size step. `md` is the application pill (11px). `xs` is the worksheet-cell pill for WorksheetMock and Excel specimens (10px, 1px 7px — the Excel specimens' 9px raised to the 10px copy floor). `slide` is the pill at slide scale inside a 1280×720 SlideMock (18.67px = 14pt at pt×4/3, 5px 15px, radius 16px). @default "md" */
  size?: 'xs' | 'md' | 'slide';
  /** Tooltip — the icon/label's fuller meaning (e.g. "Computed"). */
  title?: string;
  /** Style overrides for the StatusPill root. */
  style?: React.CSSProperties;
}

/**
 * THE pill — one geometry for every status, priority, category and type chip:
 * 11px/600 uppercase, 2px 8px, radius 10px, soft tint. Solid fill (#D83506 on
 * white) is reserved for Critical.
 *
 * @startingPoint section="Data Display" subtitle="Soft status chips for grid cells" viewport="700x150"
 */
export function StatusPill(props: StatusPillProps): React.JSX.Element;
