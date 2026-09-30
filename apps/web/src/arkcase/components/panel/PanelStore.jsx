import React from 'react';

/**
 * ArkCase PanelStore — a factory, not a component: the workstation's panel
 * store promoted. The App's `panel-resize.js` writes every persisted pin, width
 * and menu state through one `panelWrite`, under one key per host
 * (`arkcase.panels.v1`, `arkcase.portal.panels.v1`, `arkcase.<module>.v1`), so a
 * partial embedded in the App never collides with the App's own copy. This is
 * that store with the prototype methods replaced by an object, which is what
 * lets a template, a React consumer and an Angular `PanelSession` share it.
 *
 * `read` returns `{}` on any failure — private mode, quota, a hand-edited
 * record — and `write` returns whether the write landed and warns with the key,
 * so a host can keep its state and say so rather than announce a pin it lost.
 * The props of a `Panel` or a `SideNav` are still controlled by the host; this
 * only remembers them. Persistence stays the host's: a host opts in by calling
 * this. Exposed on the namespace because its name is capitalised.
 */
export function PanelStore({ key, storage } = {}) {
  if (!key) throw new Error('PanelStore needs a key — one per host, e.g. "ek.panels.v1"');
  const store = () => storage || (typeof window !== 'undefined' ? window.localStorage : null);
  const warn = (what, e) => {
    if (typeof console !== 'undefined') console.warn('PanelStore ' + key + ': ' + what + ' — ' + ((e && e.message) || e));
  };
  const read = () => {
    try {
      const s = store();
      const raw = s ? s.getItem(key) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      warn('could not read the panel store', e);
      return {};
    }
  };
  /* The one writer. Every persisted pin, width and menu-state change goes through here. */
  const write = (mutate) => {
    const s = read();
    try {
      mutate(s);
      const target = store();
      /* v8 ignore next */
      if (!target) throw new Error('no storage');
      target.setItem(key, JSON.stringify(s));
      return true;
    } catch (e) {
      warn('could not persist the panel store', e);
      return false;
    }
  };
  return {
    /** The storage key this host owns. */
    key,
    read,
    write,
    /** The stored pin for `id`, else `fallback` (false when omitted). A stored value must be a boolean to count. */
    pinned(id, fallback) {
      const stored = read()[id];
      return typeof stored === 'boolean' ? stored : !!fallback;
    },
    setPinned(id, value) {
      return write((s) => { s[id] = !!value; });
    },
    /** The stored width for `id` under `<id>.w`, else `fallback`. A stored value must be a finite positive number to count. */
    width(id, fallback) {
      const stored = read()[id + '.w'];
      return typeof stored === 'number' && isFinite(stored) && stored > 0 ? stored : fallback;
    },
    /** Store a width, or remove it with null — a reset, so the panel's default applies again. */
    setWidth(id, value) {
      return write((s) => {
        if (value == null) delete s[id + '.w'];
        else s[id + '.w'] = Math.round(Number(value));
      });
    },
    /** Any other host state that belongs with the panels — the menu pin, a chosen layout. */
    get(name, fallback) {
      const stored = read()[name];
      return stored === undefined ? fallback : stored;
    },
    set(name, value) {
      return write((s) => {
        if (value === undefined) delete s[name];
        else s[name] = value;
      });
    },
    /** Forget everything under this key. */
    clear() {
      try {
        const s = store();
        if (s) s.removeItem(key);
        return true;
      } catch (e) {
        warn('could not clear the panel store', e);
        return false;
      }
    },
  };
}
