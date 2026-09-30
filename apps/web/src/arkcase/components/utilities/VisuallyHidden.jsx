import React from 'react';

/** The standard clip pattern: removed from view, kept in the accessibility tree. */
export const visuallyHiddenStyle = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

/**
 * ArkCase VisuallyHidden — text for assistive technology only: a live-region
 * message, the name of an icon-only control, context a sighted reader gets from
 * layout. With `focusable`, it reappears while it or a descendant has focus
 * (skip links).
 */
export function VisuallyHidden({ as = 'span', focusable = false, children, style, onFocus, onBlur, ...rest }) {
  const Tag = as;
  const [focused, setFocused] = React.useState(false);
  const hidden = !(focusable && focused);
  return (
    <Tag
      style={hidden ? { ...style, ...visuallyHiddenStyle } : style}
      onFocus={focusable ? (e) => { setFocused(true); onFocus?.(e); } : onFocus}
      onBlur={focusable ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); onBlur?.(e); } : onBlur}
      {...rest}
    >
      {children}
    </Tag>
  );
}
