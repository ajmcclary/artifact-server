import React from 'react';

/**
 * ArkCase DisplayProfile — the one breakpoint scale the shell reads. Four named
 * profiles (mobile, tablet, laptop, desktop) replace ad-hoc width comparisons;
 * `barCompact` is the single app-bar presentation threshold that survives beside
 * them. The ladder is a plain object so a host with different breakpoints passes
 * its own — nothing here is hard-coded.
 *
 * `useDisplayProfile` is the hook for React consumers; `DisplayProfile` is its
 * component twin for templates, which only see capitalised exports. Both carry
 * the same `readProfile` logic.
 */
export const defaultLadder = {
  mobile: 768,
  compact: 900,
  laptop: 1100,
  desktop: 1440,
  widths: { mobile: 390, tablet: 900, laptop: 1280, desktop: 1600 },
};

/* Created on first use, not at module scope: the runtime evaluates the bundle once while
   the page is still parsing (before React has loaded) and once more when the helmet mounts,
   so nothing here may touch `React` until a component asks for it. */
let _displayProfileContext = null;
export function displayProfileContext() {
  return _displayProfileContext || (_displayProfileContext = React.createContext(null));
}

const PROFILES = ['mobile', 'tablet', 'laptop', 'desktop'];

function mergeLadder(ladder) {
  if (!ladder) return defaultLadder;
  return { ...defaultLadder, ...ladder, widths: { ...defaultLadder.widths, ...(ladder.widths || {}) } };
}

function normaliseForce(force) {
  if (!force) return null;
  const key = String(force).toLowerCase();
  if (key === 'auto' || PROFILES.indexOf(key) < 0) return null;
  return key;
}

/* One derivation for the hook and the component: a forced profile stands in for the
   viewport in every tier decision (the App's Display tweak), and `realWidth` keeps the
   window's own measurement beside it. */
function readProfile({ force, ladder, realWidth, coarsePointer, reduceMotion }) {
  const L = mergeLadder(ladder);
  const forcedKey = normaliseForce(force);
  const profile = forcedKey
    ? forcedKey
    : realWidth >= L.desktop ? 'desktop' : realWidth >= L.laptop ? 'laptop' : realWidth >= L.mobile ? 'tablet' : 'mobile';
  const width = forcedKey ? L.widths[forcedKey] : realWidth;
  const mobile = profile === 'mobile';
  return {
    profile,
    width,
    realWidth,
    forced: forcedKey ? forcedKey.charAt(0).toUpperCase() + forcedKey.slice(1) : null,
    narrow: mobile || profile === 'tablet',
    barCompact: mobile || width < L.compact,
    coarsePointer,
    reduceMotion,
    ladder: L,
  };
}

const hasWindow = () => typeof window !== 'undefined';
const media = (q) => (hasWindow() && window.matchMedia ? window.matchMedia(q) : null);
const matches = (q) => { const m = media(q); return !!(m && m.matches); };

export function useDisplayProfile({ force = null, ladder = defaultLadder } = {}) {
  const [realWidth, setRealWidth] = React.useState(() => (hasWindow() ? window.innerWidth : 1440));
  const [coarsePointer, setCoarse] = React.useState(() => matches('(pointer: coarse)'));
  const [reduceMotion, setReduce] = React.useState(() => matches('(prefers-reduced-motion: reduce)'));

  React.useEffect(() => {
    /* v8 ignore next */
    if (!hasWindow()) return undefined;
    const onResize = () => setRealWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    const subs = [
      ['(pointer: coarse)', setCoarse],
      ['(prefers-reduced-motion: reduce)', setReduce],
    ].map(([q, set]) => {
      const m = media(q);
      /* v8 ignore next */
      if (!m) return null;
      /* v8 ignore next */
      const on = (e) => set(!!e.matches);
      if (m.addEventListener) m.addEventListener('change', on);
      /* v8 ignore start */
      else if (m.addListener) m.addListener(on);
      /* v8 ignore stop */
      return () => {
        if (m.removeEventListener) m.removeEventListener('change', on);
        /* v8 ignore start */
        else if (m.removeListener) m.removeListener(on);
        /* v8 ignore stop */
      };
    });
    return () => { window.removeEventListener('resize', onResize); subs.forEach((off) => off && off()); };
  }, []);

  const L = mergeLadder(ladder);
  return React.useMemo(
    () => readProfile({ force, ladder: L, realWidth, coarsePointer, reduceMotion }),
    [force, L.mobile, L.compact, L.laptop, L.desktop, L.widths.mobile, L.widths.tablet, L.widths.laptop, L.widths.desktop, realWidth, coarsePointer, reduceMotion],
  );
}

/**
 * Component twin of `useDisplayProfile`: provides the value through
 * `displayProfileContext` and, unless `as` is null, renders a wrapper carrying
 * `data-ac-profile` so CSS can key on the profile the way the App's does.
 */
export function DisplayProfile({ force = null, ladder = defaultLadder, as = 'div', style, children, ...rest }) {
  const value = useDisplayProfile({ force, ladder });
  const provided = React.createElement(displayProfileContext().Provider, { value }, children);
  if (!as) return provided;
  return React.createElement(as, { 'data-ac-profile': value.profile, style, ...rest }, provided);
}

/* The reading and the ladder, reachable by a host that keeps its own state: a product's own
   display family reads them, so the two copies of the rule cannot drift. Statics,
   because the compiler exposes nothing but the capitalised export. */
DisplayProfile.read = readProfile;
DisplayProfile.ladder = defaultLadder;
