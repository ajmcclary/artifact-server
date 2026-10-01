// Pure DataGrid value rules. Kept separate from React and the grid renderer.
const DATA_FONT_TYPES = new Set(['id', 'date', 'money', 'count', 'code', 'contact']);
/** Does this column render its values in the data font? */
export function usesDataFont(col) {
  if (col.dataFont != null) return !!col.dataFont;
  return DATA_FONT_TYPES.has(col.type);
}

/* Sorting reads the column's declared `type` — the same declaration the data font reads —
 * so a column sorts the way it is written rather than the way its characters happen to
 * collate. Every value fell through to localeCompare before this, which put 12/01/2025 after
 * 01/01/2026 on a date column and $1,200 before $12,000 before $980 on a money one: the
 * lexicographic order of the rendered string, on columns whose whole purpose is a magnitude.
 *
 * `sortValue(col, row)` is the escape hatch for a column whose sort key is not its displayed
 * value; `sortComparator(a, b)` overrides the type entirely.
 */
const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** A date-only value as a YYYYMMDD integer, in either of the two forms the products write. */
function dayNumber(v) {
  const s = String(v).trim();
  const m = MDY.exec(s);
  if (m) return +m[3] * 10000 + +m[1] * 100 + +m[2];
  const i = ISO.exec(s);
  if (i) return +i[1] * 10000 + +i[2] * 100 + +i[3];
  return NaN;
}

/** A formatted quantity as a number: currency symbols, thousands separators, %, and a
 *  parenthesised or leading-minus negative. */
function quantity(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-') || s.startsWith('−');
  const digits = s.replace(/[^0-9.]/g, '');
  if (!digits || !/\d/.test(digits)) return NaN;
  const n = parseFloat(digits);
  return Number.isNaN(n) ? NaN : negative ? -n : n;
}

/** The comparator for one column. Values that do not parse sort after those that do, so a
 *  stray em dash never reorders the rows around it. */
export function comparatorFor(col) {
  if (typeof col.sortComparator === 'function') return col.sortComparator;
  const numeric = (parse) => (a, b) => {
    const x = parse(a), y = parse(b);
    const xb = Number.isNaN(x), yb = Number.isNaN(y);
    if (xb && yb) return String(a).localeCompare(String(b));
    if (xb) return 1;
    if (yb) return -1;
    return x - y;
  };
  if (col.type === 'date') return numeric(dayNumber);
  /* `money` and `count` are the two declared types that carry a magnitude — `count` is the
   * one a percentage or a duration column is written as, and `quantity` strips the % or the
   * unit either way. Naming a type this file's vocabulary does not declare would be a branch
   * nothing can reach, so there isn't one. */
  if (col.type === 'money' || col.type === 'count') return numeric(quantity);
  return (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
}
export function filterRows(rows, columns, query) {
  if (!query.trim()) return rows;
  const q = query.toLowerCase();
  return rows.filter((row) => columns.some((column) => String(row[column.field] ?? '').toLowerCase().includes(q)));
}
export function sortRows(filtered, columns, sort) {
  if (!sort.field || !sort.dir) return filtered;
  const col = columns.find((column) => column.field === sort.field) || { field: sort.field };
  const value = typeof col.sortValue === 'function' ? col.sortValue : (row) => row[col.field];
  const cmp = comparatorFor(col);
  const arr = [...filtered];
  arr.sort((ra, rb) => {
    const av = value(ra), bv = value(rb);
    const ab = av == null || av === '', bb = bv == null || bv === '';
    if (ab && bb) return 0;
    if (ab) return 1;
    if (bb) return -1;
    // Invalid typed values are absent data, regardless of sort direction.
    // Reversing the comparator below must not move them above real values.
    if (['date', 'money', 'count'].includes(col.type) && typeof col.sortComparator !== 'function') {
      const invalid = col.type === 'date' ? (entry) => Number.isNaN(dayNumber(entry)) : (entry) => Number.isNaN(quantity(entry));
      const ai = invalid(av), bi = invalid(bv);
      if (ai !== bi) return ai ? 1 : -1;
    }
    return sort.dir === 'asc' ? cmp(av, bv) : -cmp(av, bv);
  });
  return arr;
}
export function orderColumns(columns) {
  return [...columns.filter((col) => col.pinned === 'left'),
    ...columns.filter((col) => !col.pinned),
    ...columns.filter((col) => col.pinned === 'right')];
}
