// Pure state transitions used by the React grid controller.
export function nextSort(sort, field) {
  if (sort.field !== field) return { field, dir: 'asc' };
  if (sort.dir === 'asc') return { field, dir: 'desc' };
  return { field: null, dir: null };
}

export function toggleSelection(selected, key) {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function selectAll(sorted, rowKey, allChecked) {
  if (allChecked) return new Set();
  return new Set(sorted.map(rowKey));
}

/* Select-all over the rows in view: when every one of them is already selected they all leave
   the selection, otherwise they all join it. Selected rows outside the view (filtered out,
   capped, on another host page) keep their state either way. */
export function toggleAllIn(selected, keys, allChecked) {
  const next = new Set(selected);
  keys.forEach((key) => { if (allChecked) next.delete(key); else next.add(key); });
  return next;
}
