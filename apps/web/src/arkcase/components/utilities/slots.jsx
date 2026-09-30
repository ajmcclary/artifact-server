import React from 'react';

/**
 * ArkCase slots — named content through children. A portable page (the DC template runtime)
 * can hand a component children but not React nodes as props, so a component whose API takes
 * a node prop (`actions`, `lead`, `header`) also reads it from a direct child carrying the
 * HTML-native `slot` attribute: `<div slot="actions">…</div>`. The slotted element renders as
 * given, attribute and all; a component's explicit prop wins over its slot. Fragments are
 * looked into, so a slot inside a keyed list still lands; anything else stays in `children`.
 */
/* The portable runtime mounts each `<x-import>` inside a `div.sc-host-x` (display: contents),
   so a `slot` written on the mount lands one level down, on the component. Read it through. */
export function slotOf(node) {
  if (!React.isValidElement(node) || !node.props) return undefined;
  if (typeof node.props.slot === 'string') return node.props.slot;
  if (node.type === 'div' && node.props.className === 'sc-host-x') {
    const inner = React.Children.toArray(node.props.children);
    if (inner.length === 1 && React.isValidElement(inner[0]) && inner[0].props && typeof inner[0].props.slot === 'string') return inner[0].props.slot;
  }
  return undefined;
}

function isBlankText(node) {
  return node == null || typeof node === 'boolean' || (typeof node === 'string' && node.trim() === '');
}

/**
 * The children a layout component places one per cell or column: fragments (an `sc-for` loop,
 * a keyed list) are opened, and whitespace text, null and booleans are dropped, so indented
 * page markup never becomes an empty extra cell.
 */
export function flattenChildren(children) {
  const out = [];
  const visit = (node) => {
    if (React.isValidElement(node) && node.type === React.Fragment) { React.Children.toArray(node.props.children).forEach(visit); return; }
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (isBlankText(node)) return;
    out.push(node);
  };
  React.Children.toArray(children).forEach(visit);
  return out;
}

export function splitSlots(children) {
  const out = { children: [] };
  /* Children.toArray keys every node, so the unslotted remainder renders as a list without
     key warnings; a fragment is opened and its children keyed the same way. */
  const visit = (node) => {
    if (React.isValidElement(node) && node.type === React.Fragment) { React.Children.toArray(node.props.children).forEach(visit); return; }
    // Indentation between a portable page's child tags arrives as whitespace text: not content.
    if (isBlankText(node)) return;
    const name = slotOf(node);
    if (typeof name === 'string' && name && name !== 'children') {
      out[name] = out[name] === undefined ? node : [].concat(out[name], node);
    } else {
      out.children.push(node);
    }
  };
  React.Children.toArray(children).forEach(visit);
  return out;
}
