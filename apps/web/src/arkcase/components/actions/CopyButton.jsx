import React from 'react';
import { Button } from './Button.jsx';
import { IconButton } from './IconButton.jsx';
import { Tooltip } from '../feedback/Tooltip.jsx';

/**
 * ArkCase CopyButton — copy-to-clipboard with in-place confirmation.
 * The button swaps its icon and label to the copied state for a short hold,
 * then swaps back; the host performs the clipboard write in `onCopy` and
 * announces through the shell's live region in `onAnnounce`. With no children
 * it renders an icon-only ghost button (row and toolbar copies); with children
 * it renders a labelled Button (review-link and public-link copies).
 * The confirmation is state, never a toast: copying changes nothing on the
 * record, so there is nothing a transient confirmation needs to carry.
 */
export function CopyButton({
  icon = 'bi-clipboard',
  copiedIcon = 'bi-check2',
  size = 'sm',
  variant = 'ghost',
  placement = 'top',
  wide = false,
  copiedLabel,
  copied = undefined,
  holdMs = 2000,
  disabled = false,
  onCopy,
  onAnnounce,
  children,
  style,
  ...rest
}) {
  const [inner, setInner] = React.useState(false);
  const timer = React.useRef(null);
  const isCopied = copied !== undefined ? !!copied : inner;
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const label = React.Children.count(children) > 0
    ? String(React.Children.toArray(children).map((c) => (typeof c === 'string' || typeof c === 'number') ? c : '').join('')).trim()
    : '';
  const shown = isCopied && copiedLabel ? copiedLabel : label;
  const click = (e) => {
    if (disabled) return;
    if (onCopy) onCopy(e);
    if (onAnnounce) onAnnounce(copiedLabel || (label ? label + ' copied' : 'Copied to the clipboard'));
    if (copied === undefined) {
      setInner(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setInner(false), holdMs);
    }
  };
  const tip = isCopied ? (copiedLabel || (label ? label + ' copied' : 'Copied')) : (label || rest['aria-label'] || 'Copy');
  const btn = React.Children.count(children) > 0
    ? (
      <Button
        variant={variant === 'ghost' ? 'secondary' : variant === 'outline' ? 'primary' : variant}
        outline={variant !== 'link'}
        size={size}
        icon={isCopied ? copiedIcon : icon}
        disabled={disabled}
        onClick={click}
        aria-label={label ? undefined : tip}
        style={style}
        {...rest}
      >
        {shown || children}
      </Button>
    )
    : (
      <IconButton
        icon={isCopied ? copiedIcon : icon}
        variant={variant === 'link' ? 'ghost' : variant}
        size={size}
        ariaLabel={tip}
        disabled={disabled}
        onClick={click}
        style={style}
        {...rest}
      />
    );
  return (
    <Tooltip label={tip} placement={placement} wide={wide}>
      {btn}
    </Tooltip>
  );
}
