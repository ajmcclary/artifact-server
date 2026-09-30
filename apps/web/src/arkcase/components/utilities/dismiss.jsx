/**
 * ArkCase dismiss — the Escape-chain helper. A page that stacks temporary layers (a demo
 * panel over a menu over a popover over a modal over a search palette) lets each Escape close
 * only the innermost open one, never a draft, a pinned panel or the workspace layout behind
 * it. Promoted from the Artifacts App's hand-written `if (st.demoOpen) … else if (st.menu) …`
 * chain. No React, no DOM: the host lists its layers, innermost first.
 */

/**
 * Close the first open layer in `layers` (ordered innermost first) and return true; return
 * false when none is open, so the host can let the key through. Falsy entries are skipped,
 * so a host can write `cond && { open, close }` inline.
 */
export function dismissInnermost(layers) {
  if (!Array.isArray(layers)) return false;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer || !layer.open) continue;
    if (typeof layer.close === 'function') layer.close();
    return true;
  }
  return false;
}
