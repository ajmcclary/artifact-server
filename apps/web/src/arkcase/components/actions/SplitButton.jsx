import React from 'react';
import { Button } from './Button.jsx';
import { Menu } from '../overlays/Menu.jsx';

/* Solid fills whose label is dark (see Button's lightish set) take a dark divider. */
const SPLIT_LIGHT_FILLS = { success: 1, warning: 1, light: 1 };

/**
 * ArkCase SplitButton — one primary action with a menu of related actions beside it: the
 * main Button runs the default command, and a joined chevron Button (`aria-haspopup="menu"`,
 * `aria-expanded`) opens a Menu hung off the chevron. Solid variants show a hairline divider
 * in the label ink between the two halves; outline variants share one border.
 *
 * The menu's open state is internal unless `menuOpen` is passed. It opens with the first
 * enabled item focused; choosing an item, Escape or Tab closes it, and focus returns to
 * the chevron when it was inside the menu.
 */
export function SplitButton({
  children,
  icon,
  onClick,
  menuItems = [],
  menuLabel = 'More actions',
  variant = 'primary',
  outline = false,
  size = 'sm',
  disabled = false,
  loading = false,
  menuDisabled = false,
  menuAlign = 'end',
  menuPlacement = 'bottom',
  menuWidth,
  menuOpen,
  onMenuOpenChange,
  style,
  ...rest
}) {
  if (typeof variant === 'string' && variant.indexOf('outline-') === 0) {
    outline = true;
    variant = variant.slice(8);
  }
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = menuOpen !== undefined ? !!menuOpen : internalOpen;
  const chevronRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const setOpen = (next) => {
    if (menuOpen === undefined) setInternalOpen(next);
    if (onMenuOpenChange) onMenuOpenChange(next);
  };
  const focusChevron = () => {
    const el = chevronRef.current && chevronRef.current.querySelector('button');
    if (el) el.focus();
  };
  const close = () => {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const inside = !!active && (active === document.body || (menuRef.current && menuRef.current.contains(active)));
    setOpen(false);
    if (inside) focusChevron();
  };
  const joinedMenuOff = menuDisabled || disabled;
  /* Focus the first enabled item once the anchored menu has been measured and shown. The
     menu is hidden for its first measuring frame, so focus waits a frame for it. */
  React.useEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    let tries = 0;
    const focusFirst = () => {
      const root = menuRef.current;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (!root || (active && root.contains(active))) return;
      const first = root.querySelector('[role^="menuitem"]:not([disabled]):not([aria-disabled="true"])');
      if (first) first.focus();
      if ((!first || document.activeElement !== first) && tries++ < 5) frame = requestAnimationFrame(focusFirst);
    };
    frame = requestAnimationFrame(focusFirst);
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const divider = outline
    ? null
    : SPLIT_LIGHT_FILLS[variant]
      ? 'color-mix(in srgb, var(--text-body, #212529) 35%, transparent)'
      : 'color-mix(in srgb, var(--text-on-primary, #ffffff) 75%, transparent)';

  return (
    <span
      data-split-button=""
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'stretch', flex: 'none', verticalAlign: 'middle', ...style }}
      {...rest}
    >
      <Button
        variant={variant}
        outline={outline}
        size={size}
        icon={icon}
        disabled={disabled}
        loading={loading}
        onClick={onClick}
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
      >
        {children}
      </Button>
      {divider && <span aria-hidden="true" data-split-divider="" style={{ width: 1, flex: 'none', background: divider, opacity: disabled ? 0.65 : 1 }} />}
      <span ref={chevronRef} style={{ display: 'inline-flex', marginLeft: outline ? -1 : 0 }}>
        <Button
          variant={variant}
          outline={outline}
          size={size}
          icon="bi-chevron-down"
          disabled={joinedMenuOff}
          hasPopup="menu"
          expanded={open}
          aria-label={menuLabel}
          title={menuLabel}
          onClick={() => setOpen(!open)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); }
          }}
          style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingLeft: '0.4rem', paddingRight: '0.4rem' }}
        />
      </span>
      {open && (
        <span ref={menuRef} style={{ display: 'contents' }}>
          <Menu
            open
            items={menuItems}
            onClose={close}
            align={menuAlign}
            placement={menuPlacement}
            label={menuLabel}
            width={menuWidth}
            anchor={chevronRef.current}
          />
        </span>
      )}
    </span>
  );
}
