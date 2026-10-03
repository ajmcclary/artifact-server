import React from 'react';

const hasWindow = () => typeof window !== 'undefined';
const scrollY = () => (hasWindow() ? window.scrollY || document.documentElement.scrollTop || 0 : 0);
const MARK = 'akNav';

/**
 * The phone's navigation model as a hook: one stack per tab. `push` adds a
 * level (a record, a detail) and a browser history entry, so ‹ Back, the
 * system back gesture and the browser's Back all pop the same level. Switching
 * tabs keeps every stack where it was; choosing the active tab again returns it
 * to its root. Each level remembers the document's scroll position and gets it
 * back on the way back. `history: false` keeps everything in memory (previews,
 * embedded frames).
 */
export function useNavStack({ roots = {}, initialTab, history = true, onChange } = {}) {
  const tabIds = Object.keys(roots);
  const [state, setState] = React.useState(() => {
    const stacks = {};
    tabIds.forEach((id) => { stacks[id] = [{ ...roots[id], key: roots[id].key || id }]; });
    return { tab: initialTab && stacks[initialTab] ? initialTab : tabIds[0], stacks };
  });
  const ref = React.useRef(state);
  ref.current = state;
  const pendingScroll = React.useRef(null);
  const seq = React.useRef(0);
  const useHistory = history && hasWindow() && window.history && typeof window.history.pushState === 'function';

  /* Saves the current scroll position on the level being left. */
  const withSavedScroll = (s) => {
    const st = s.stacks[s.tab].slice();
    st[st.length - 1] = { ...st[st.length - 1], scrollY: scrollY() };
    return { ...s, stacks: { ...s.stacks, [s.tab]: st } };
  };
  const commit = (next, y) => {
    pendingScroll.current = y;
    ref.current = next;
    setState(next);
    if (onChange) onChange(next);
  };
  const trim = (s, tab, depth) => {
    const st = s.stacks[tab];
    if (!st || depth >= st.length) return { ...s, tab };
    const ns = st.slice(0, Math.max(1, depth));
    return { tab, stacks: { ...s.stacks, [tab]: ns } };
  };

  React.useLayoutEffect(() => {
    if (pendingScroll.current == null || !hasWindow()) return;
    const y = pendingScroll.current;
    pendingScroll.current = null;
    window.scrollTo(0, y);
    /* Content that renders a frame late (a lazy section) gets one more chance. */
    const raf = window.requestAnimationFrame ? window.requestAnimationFrame(() => window.scrollTo(0, y)) : null;
    return () => { if (raf != null && window.cancelAnimationFrame) window.cancelAnimationFrame(raf); };
  });

  React.useEffect(() => {
    if (!useHistory) return undefined;
    const s = ref.current;
    window.history.replaceState({ ...(window.history.state || {}), [MARK]: { tab: s.tab, depth: s.stacks[s.tab].length } }, '');
    const onPop = (e) => {
      const mark = e.state && e.state[MARK];
      if (!mark) return;
      const cur = withSavedScroll(ref.current);
      const next = trim(cur, mark.tab, mark.depth);
      const st = next.stacks[next.tab];
      commit(next, st[st.length - 1].scrollY || 0);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [useHistory]);

  const api = React.useMemo(() => {
    const push = (entry) => {
      const cur = withSavedScroll(ref.current);
      const st = [...cur.stacks[cur.tab], { ...entry, key: entry.key || `${cur.tab}-${++seq.current}`, scrollY: 0 }];
      const next = { ...cur, stacks: { ...cur.stacks, [cur.tab]: st } };
      if (useHistory) window.history.pushState({ [MARK]: { tab: cur.tab, depth: st.length } }, '');
      commit(next, 0);
    };
    const popTo = (index) => {
      const cur = ref.current;
      const st = cur.stacks[cur.tab];
      const depth = Math.max(1, Math.min(st.length, index + 1));
      const steps = st.length - depth;
      if (steps <= 0) return;
      if (useHistory) { window.history.go(-steps); return; }
      const next = trim(withSavedScroll(cur), cur.tab, depth);
      commit(next, next.stacks[cur.tab][depth - 1].scrollY || 0);
    };
    const pop = () => popTo(ref.current.stacks[ref.current.tab].length - 2);
    const switchTab = (tab) => {
      const cur = ref.current;
      if (!cur.stacks[tab]) return;
      if (tab === cur.tab) {
        if (cur.stacks[tab].length > 1) popTo(0);
        else if (hasWindow()) window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const saved = withSavedScroll(cur);
      const next = { ...saved, tab };
      const st = next.stacks[tab];
      if (useHistory) window.history.replaceState({ [MARK]: { tab, depth: st.length } }, '');
      commit(next, st[st.length - 1].scrollY || 0);
    };
    const update = (patch) => {
      const cur = ref.current;
      const st = cur.stacks[cur.tab].slice();
      st[st.length - 1] = { ...st[st.length - 1], ...patch };
      const next = { ...cur, stacks: { ...cur.stacks, [cur.tab]: st } };
      ref.current = next;
      setState(next);
      if (onChange) onChange(next);
    };
    return { push, pop, popTo, switchTab, update };
  }, [useHistory]);

  const stack = state.stacks[state.tab];
  return {
    tab: state.tab,
    stacks: state.stacks,
    stack,
    top: stack[stack.length - 1],
    parent: stack.length > 1 ? stack[stack.length - 2] : null,
    depth: stack.length,
    canGoBack: stack.length > 1,
    ...api,
  };
}

/** The component twin of `useNavStack` for portable templates: `children` is a function of the stack. */
export function NavStack({ roots, initialTab, history = true, onChange, children }) {
  const nav = useNavStack({ roots, initialTab, history, onChange });
  return typeof children === 'function' ? children(nav) : null;
}
