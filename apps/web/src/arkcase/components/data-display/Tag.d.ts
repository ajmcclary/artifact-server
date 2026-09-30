import React from 'react';

export interface TagProps extends Omit<React.HTMLAttributes<HTMLElement>, 'style' | 'children' | 'title' | 'onClick'> {
  /** The literal token the chip shows, e.g. a client name, tool id or keyword; for a toggle chip, its label. */
  children?: React.ReactNode;
  /** Data face at 11px for literal tokens; false switches to Public Sans at 12px for a plain word. @default true for a static tag; false for a toggle chip (`onClick`) or a tag with `meta` */
  mono?: boolean;
  /** Native tooltip, e.g. the full value when the host truncates or abbreviates it, or "Hide Hearing events" on a legend chip. */
  title?: string;
  /** Adds a trailing × button that calls this when pressed; the host removes the tag. On a toggle chip it is a sibling of the chip button, never nested. */
  onRemove?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Accessible name of the remove button. @default "Remove {children}" when children is text, else "Remove" */
  removeLabel?: string;
  /**
   * Fill of a static tag: `default` is the quiet hairline token chip; `primary` the tinted chip
   * (`tint-primary-selected`, `text-link-hover`) for an applied filter or a record tag; `navy` the
   * solid form-code chip (`surface-header`, `text-on-navy`, 12px/600, 4px radius); `success`,
   * `warning` and `danger` the pill pairs. Ignored by a toggle chip, whose state paints it. @default "default"
   */
  tone?: 'default' | 'primary' | 'navy' | 'success' | 'warning' | 'danger';
  /** `dashed` is the outline-only chip for an item that is provisional or folded into another (the Admin "merged" chip): transparent ground, 1px dashed border (`bs-gray-500` for the default tone, the tone's border otherwise) and `text-secondary` ink (the tone's ink for status tones). A toggle chip keeps its state fills and only dashes its border. @default "solid" */
  variant?: 'solid' | 'dashed';
  /** Makes the tag an action or toggle chip: a native button inside a 28px pill (24px at `size="sm"`), with a primary border and ink on hover. */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Toggle state of a chip with `onClick`; emits `aria-pressed` when defined. Pressed paints `tint-primary-selected`, a `bs-primary` border and 600 `text-link-hover` ink. */
  pressed?: boolean;
  /** Natively disables a toggle chip (dimmed, not focusable). @default false */
  disabled?: boolean;
  /** Leading `bi-*` studio icon class, e.g. "bi-funnel". */
  icon?: string;
  /** Trailing `bi-*` glyph at 12px and 60% opacity after the label and count, hinting what a press does, e.g. "bi-pencil" on a filter chip that opens its editor or "bi-chevron-down" on one that opens a menu. */
  iconRight?: string;
  /** Series colour of a legend chip — any CSS colour or `var(--…)`, e.g. an event type's colour. Draws a leading 8px dot in it; on a toggle chip, pressed derives the tint (8%) and border (25%) from it with `color-mix()` over `surface-card`, unpressed stays neutral (card fill, hairline, `text-secondary` ink, hollow dot). */
  color?: string;
  /** The same series colour as `color`, by its earlier name; `color` wins when both are set. */
  dot?: string;
  /** Count after the label in the data face (11px `text-secondary`), e.g. how many events a legend entry holds. */
  count?: React.ReactNode;
  /** Secondary 11px line under the label, e.g. "Dana Okonkwo · 08/12/2026"; the label steps to 13px/600 and the × to a 22px target. */
  meta?: React.ReactNode;
  /** Height of a toggle chip: `md` 28px, `sm` 24px. @default "md" */
  size?: 'sm' | 'md';
  /** Style overrides for the Tag root (the pill). */
  style?: React.CSSProperties;
}

/** Quiet hairline chip for a literal token; with `onClick` and `pressed`, the toggle or filter chip. */
export function Tag(props: TagProps): React.JSX.Element;
