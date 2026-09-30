import React from 'react';

// One registry per document within each runtime. Callback changes
// must not reorder open layers. DOM ancestry wins over effect registration order.
const documents = new WeakMap();
function registry(doc) {
  let state = documents.get(doc);
  if (!state) {
    state = { layers: [], locks: 0, overflow: '' };
    documents.set(doc, state);
  }
  return state;
}
function innermost(state) {
  return state.layers.filter(layer => layer.ref.current?.isConnected).reduce((top, layer) => {
    if (!top || top.ref.current.contains(layer.ref.current)) return layer;
    if (layer.ref.current.contains(top.ref.current)) return top;
    // Portalled siblings have no DOM ancestry; honor their actual stacking order.
    const rank = entry => {
      const root = entry.ref.current;
      const popover = root.querySelector('[popover]');
      if (popover?.matches(':popover-open')) return Infinity;
      return Number.parseInt(root.ownerDocument.defaultView.getComputedStyle(root).zIndex, 10) || 0;
    };
    if (rank(top) > rank(layer)) return top;
    return layer;
  }, null);
}
function dismiss(state, event, candidate) {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  const top = innermost(state);
  if (!top || (candidate && candidate !== top)) return false;
  // A non-dismissible top layer is a barrier; Escape never reaches its parent.
  event.preventDefault();
  event.stopPropagation();
  if (top.options.current.enabled) top.options.current.onDismiss?.();
  return true;
}
export function useEscapeLayer(open, ref, onDismiss, enabled = true) {
  const options = React.useRef({ onDismiss, enabled });
  options.current = { onDismiss, enabled };
  const layer = React.useRef({ ref, options });
  React.useLayoutEffect(() => {
    if (!open || !ref.current) return undefined;
    const doc = ref.current.ownerDocument;
    const state = registry(doc), entry = layer.current;
    state.layers.push(entry);
    // Root handlers normally consume Escape first. Keep document dispatches and
    // focus outside the layer working without installing one listener per layer.
    if (state.layers.length === 1) {
      state.onKey = event => dismiss(state, event);
      doc.addEventListener('keydown', state.onKey);
    }
    return () => {
      state.layers = state.layers.filter(item => item !== entry);
      if (!state.layers.length) doc.removeEventListener('keydown', state.onKey);
    };
  }, [open, ref]);
  return event => ref.current && dismiss(registry(ref.current.ownerDocument), event, layer.current);
}
export function lockScroll(doc) {
  const state = registry(doc);
  if (!state.locks++) { state.overflow = doc.body.style.overflow; doc.body.style.overflow = 'hidden'; }
  return () => { if (!--state.locks) doc.body.style.overflow = state.overflow; };
}
