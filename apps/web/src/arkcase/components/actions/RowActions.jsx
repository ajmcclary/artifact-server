import React from 'react';
import { IconButton } from './IconButton.jsx';
import { Menu } from '../overlays/Menu.jsx';

/**
 * ArkCase RowActions — the actions a list row keeps out of sight until the reader points at it
 * or tabs into it: quick IconButtons and a kebab whose `Menu` floats over the rows below rather
 * than pushing them down. The row stays the host's: RowActions wraps it and hands it the
 * actions node to place (a `LinkRow`'s `actions`, a row's trailing slot). `persistent` marks
 * (a Current pill) show at rest; `always` keeps everything visible, for touch, where there is
 * no hover. The actions stay in the tab order while hidden, so focus reveals them.
 */
export function RowActions({ items = [], menuLabel = 'More actions', menuWidth = 210, quick, persistent, always = false, children, style, ...rest }) {
  const [hot, setHot] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  const kebab = React.useRef(null);
  const shown = always || hot || menu;
  const list = (items || []).filter(Boolean);
  const actions = (
    <>
      {persistent}
      <span data-row-actions={shown ? 'shown' : 'hidden'} style={{ display: 'inline-flex', gap: 2, opacity: shown ? 1 : 0, transition: 'opacity .12s ease' }}>
        {quick}
        {list.length > 0 && (
          <span ref={kebab} style={{ display: 'inline-flex' }}>
            <IconButton icon="bi-three-dots-vertical" size="xs" ariaLabel={menuLabel} hasPopup="menu" expanded={menu}
              onClick={() => setMenu((m) => !m)} />
          </span>
        )}
      </span>
      {menu && <Menu open label={menuLabel} anchor={kebab.current} align="end" width={menuWidth} density="comfortable"
        onClose={() => setMenu(false)} items={list} />}
    </>
  );
  return (
    <div data-row-actions-host="" style={style} {...rest}
      onPointerEnter={() => setHot(true)} onPointerLeave={() => setHot(false)}
      onFocus={() => setHot(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setHot(false); }}>
      {typeof children === 'function' ? children(actions) : children}
    </div>
  );
}
