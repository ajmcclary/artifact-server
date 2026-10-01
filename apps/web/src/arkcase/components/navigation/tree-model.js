/**
 * ArkCase tree model — the pure arithmetic behind TreeView, promoted from the Designer
 * Storybook prototype's `walk` / `visible` / `leaves` / `expandAllTree`. A tree is plain
 * `{ id, label, children?, section? }` nodes; nothing here touches the DOM or React, so the
 * rows a TreeView renders can be computed and tested in isolation.
 *
 * Filtering: with a `query` (case-insensitive substring of the label) and/or a `filter`
 * predicate, a node matches when it passes both. Ancestors of a match are shown and forced
 * open (`forced: true`, so Left does not collapse them); a matching branch shows its whole
 * subtree under the ordinary expanded state. Levels are 1-based as `aria-level` wants; `depth`
 * is the indent step and does not count section headers.
 */

const kids = (n) => (n && Array.isArray(n.children) ? n.children : []);

/** True when the node has at least one child. */
export function isBranch(node) {
  return kids(node).length > 0;
}

/** Every branch id (sections included), depth-first — the input to "expand all". */
export function allBranchIds(nodes) {
  const out = [];
  const walk = (list) => (list || []).forEach((n) => { if (isBranch(n)) { out.push(n.id); walk(kids(n)); } });
  walk(nodes);
  return out;
}

/** The number of leaves (nodes without children) for which `predicate` holds; all leaves by default. */
export function countLeaves(nodes, predicate) {
  let total = 0;
  const walk = (list) => (list || []).forEach((n) => {
    if (isBranch(n)) walk(kids(n));
    else if (!predicate || predicate(n)) total++;
  });
  walk(nodes);
  return total;
}

/** Ids from the root down to the node's parent, or null when the id is absent. */
export function ancestorIds(nodes, id) {
  const find = (list, trail) => {
    for (const n of list || []) {
      if (n.id === id) return trail;
      const hit = find(kids(n), trail.concat(n.id));
      if (hit) return hit;
    }
    return null;
  };
  return find(nodes, []);
}

/**
 * The visible rows, in order: `{ id, node, label, level, depth, parentId, hasChildren, open,
 * forced, section, posinset, setsize }`.
 */
export function flattenTree(nodes, options) {
  const { expanded = [], query = '', filter } = options || {};
  const open = new Set(expanded);
  const q = String(query || '').trim().toLowerCase();
  const filtering = !!q || typeof filter === 'function';
  const matches = (n) => (!q || String(n.label || '').toLowerCase().includes(q)) && (typeof filter !== 'function' || !!filter(n));
  const memo = new Map();
  const hasMatch = (n) => {
    if (memo.has(n)) return memo.get(n);
    const hit = matches(n) || kids(n).some(hasMatch);
    memo.set(n, hit);
    return hit;
  };
  const rows = [];
  const walk = (list, level, depth, parentId, inMatch) => {
    const shown = (list || []).filter((n) => !filtering || inMatch || hasMatch(n));
    shown.forEach((n, i) => {
      const branch = isBranch(n);
      const selfMatch = filtering && !inMatch && matches(n);
      const forced = filtering && !inMatch && branch && kids(n).some(hasMatch);
      const isOpen = branch && (forced || open.has(n.id));
      rows.push({
        id: n.id, node: n, label: n.label, level, depth, parentId,
        hasChildren: branch, open: isOpen, forced, section: !!n.section,
        posinset: i + 1, setsize: shown.length,
      });
      if (isOpen) walk(kids(n), level + 1, n.section ? depth : depth + 1, n.id, inMatch || selfMatch);
    });
  };
  walk(nodes, 1, 0, null, false);
  return rows;
}
