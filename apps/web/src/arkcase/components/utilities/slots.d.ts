import React from 'react';

/** Children partitioned by the `slot` attribute of direct children: unslotted nodes stay in `children`. */
export interface SplitSlots {
  /** Direct children that carry no `slot` attribute, in order. */
  children: React.ReactNode[];
  /** Each named slot's element, or an array when several children name the same slot. */
  [slot: string]: React.ReactNode;
}

/**
 * Partition children by their `slot` attribute so a portable page, which can pass children but
 * not React nodes as props, can still fill a component's node props: `<div slot="actions">`.
 * Fragments are searched, whitespace-only text is dropped, and a `slot` written on a portable
 * `<x-import>` mount is read through the runtime's `div.sc-host-x` wrapper. A component's explicit
 * prop should win over its slot.
 */
export function splitSlots(children: React.ReactNode): SplitSlots;

/**
 * The children a layout component places one per cell or column: fragments (an `sc-for` loop, a keyed
 * list) are opened; whitespace-only text, null and booleans are dropped, so indented page markup never
 * becomes an extra cell.
 */
export function flattenChildren(children: React.ReactNode): React.ReactNode[];

/**
 * The `slot` name a child carries — on the element itself, or on a portable `<x-import>` mount
 * read through the runtime's `div.sc-host-x` wrapper — or `undefined`.
 */
export function slotOf(node: React.ReactNode): string | undefined;
