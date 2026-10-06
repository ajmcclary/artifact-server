import React from 'react';

/**
 * ArkCase PanelBudget — the one pin decision every docked panel shares.
 *
 * A route lists its panels in priority order; each panel that wants a pin is
 * admitted only while the width left over for the working pane stays above
 * the profile's floor. The pure functions are the App's `pinFloor`, `canPin`,
 * `tbLeftOf` / `tbAdmit` / `tbCould` folded into one place; `usePanelBudget`
 * memoises them and `PanelBudget` is the component twin a template composes,
 * handing the result to every `Panel` inside it through `panelBudgetContext`.
 */

const DEFAULT_FLOOR = 480; // the App's TB_MIN
const DEFAULT_WIDTH = 330;

/** The narrowest working pane a profile protects: tablet 320, laptop 360, else 480. */
export function pinFloor(profile, requested) {
  const want = requested || DEFAULT_FLOOR;
  if (profile === 'tablet') return Math.min(want, 320);
  if (profile === 'laptop') return Math.min(want, 360);
  return Math.min(want, 480);
}

/** One pure pin decision. A pointer of 'none' (mobile) can never pin. */
export function canPin(panelWidth, occupiedWidth, pointer, floor, viewportWidth, profile) {
  if (pointer === 'none') return false;
  return (viewportWidth || 0) - (occupiedWidth || 0) - (panelWidth || 0) >= pinFloor(profile, floor);
}

/**
 * Walk `order`, admitting each panel that wants a pin and still fits beside the
 * ones admitted before it. `seed` is the navigation column (0, 56 or its expanded
 * width). Returns the admissions, the width used, and `can(key, width, floor)` —
 * the same decision for a panel that is not pinned yet, taking no width.
 *
 * With `autoCollapse`, priority is recency instead of `order`: the keys in `recent`
 * (most recently pinned first) are admitted before the rest, so a panel just pinned
 * displaces an older one rather than being refused, and `can` asks only whether the
 * panel fits beside the seed. `leftOf` still follows `order`, the layout.
 */
export function admitPanels(config) {
  const { order = [], wants = {}, widths = {}, floors = {}, seed = 0, pointer = 'fine', viewportWidth = 0, profile = 'desktop', autoCollapse = false, recent = [] } = config || {};
  const admitted = {};
  const leftOf = {};
  const widthOf = (key) => (widths[key] != null ? widths[key] : DEFAULT_WIDTH);
  const priority = autoCollapse
    ? recent.filter((k) => order.indexOf(k) !== -1).concat(order.filter((k) => recent.indexOf(k) === -1))
    : order;
  let used = seed || 0;
  for (let i = 0; i < priority.length; i++) {
    const key = priority[i];
    const w = widthOf(key);
    const ok = !!wants[key] && canPin(w, used, pointer, floors[key], viewportWidth, profile);
    admitted[key] = ok;
    if (ok) used += w;
  }
  let left = seed || 0;
  for (let i = 0; i < order.length; i++) {
    leftOf[order[i]] = left;
    if (admitted[order[i]]) left += widthOf(order[i]);
  }
  const can = (key, width, floor) => {
    const occupied = autoCollapse ? seed || 0 : key != null && leftOf[key] !== undefined ? leftOf[key] : used;
    const w = width != null ? width : widthOf(key);
    return canPin(w, occupied, pointer, floor != null ? floor : floors[key], viewportWidth, profile);
  };
  return { admitted, used, leftOf, can };
}

function derivePointer(profile, coarsePointer, pointer) {
  if (pointer) return pointer;
  if (profile === 'mobile') return 'none';
  return coarsePointer ? 'coarse' : 'fine';
}

/**
 * `admitPanels` memoised over the config, plus the derived `pointer`. With `autoCollapse`
 * the hook keeps the pin recency and returns `touch(key)`: a `Panel` calls it when it is
 * pinned — by its own pin, by the host, or by mounting pinned after the first render — so
 * the newest pin wins the width. Panels present at the first render keep `order`.
 */
export function usePanelBudget(config) {
  const { order, wants, widths, floors, seed, viewportWidth, profile, coarsePointer, pointer: pointerProp, autoCollapse = false } = config || {};
  const pointer = derivePointer(profile, coarsePointer, pointerProp);
  const [recent, setRecent] = React.useState([]);
  const settled = React.useRef(false);
  /* Children's mount effects run before this one, so first-render pins do not reorder. */
  React.useEffect(() => { settled.current = true; }, []);
  const touch = React.useCallback((key, initial) => {
    if (initial && !settled.current) return;
    setRecent((list) => (list[0] === key ? list : [key].concat(list.filter((k) => k !== key))));
  }, []);
  return React.useMemo(
    () => ({
      ...admitPanels({ order, wants, widths, floors, seed, pointer, viewportWidth, profile, autoCollapse, recent }),
      pointer, viewportWidth, profile, autoCollapse, touch: autoCollapse ? touch : undefined,
    }),
    [order, wants, widths, floors, seed, pointer, viewportWidth, profile, autoCollapse, recent, touch],
  );
}

/* Created on first use, not at module scope — see DisplayProfile.jsx for why. */
let _panelBudgetContext = null;
export function panelBudgetContext() {
  return _panelBudgetContext || (_panelBudgetContext = React.createContext(null));
}

/**
 * The component twin of `usePanelBudget`: the same config as props, the result
 * provided to every `Panel` beneath it. A `Panel` with no explicit `canPin`
 * reads its admission from here by `id`.
 */
export function PanelBudget({ order, wants, widths, floors, seed, viewportWidth, profile, coarsePointer, pointer, autoCollapse, children }) {
  const value = usePanelBudget({ order, wants, widths, floors, seed, viewportWidth, profile, coarsePointer, pointer, autoCollapse });
  return React.createElement(panelBudgetContext().Provider, { value }, children);
}

/* The pure decision, reachable by a host that keeps its own state: a product's own
   budget family reads these, so `pinFloor`, `canPin` and the walk have one definition. */
PanelBudget.pinFloor = pinFloor;
PanelBudget.canPin = canPin;
PanelBudget.admitPanels = admitPanels;
PanelBudget.pointerFor = derivePointer;
