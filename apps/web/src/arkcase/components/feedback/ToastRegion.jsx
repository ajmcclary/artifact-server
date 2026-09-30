import React from 'react';
import { Toast } from './Toast.jsx';
import { LiveRegion } from '../utilities/announcer.jsx';

const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end' };
const TOAST_ITEM_KEYS = { id: 1, message: 1, leaving: 1, onClose: 1 };

/* "bottom-start" → { edge: 'bottom', align: 'start' }; anything unknown is bottom-start. */
function toastPlacement(placement) {
  const [edge, align] = String(placement || '').split('-');
  return {
    edge: edge === 'top' ? 'top' : 'bottom',
    align: ALIGN[align] ? align : 'start',
  };
}

/* What a region says for one toast: its title and its message as one sentence pair. */
function toastSpeech(t) {
  if (!t) return '';
  const parts = [t.title, t.message].filter((x) => typeof x === 'string' && x.trim() !== '');
  return parts.join('. ');
}

/**
 * ArkCase ToastRegion — the fixed viewport the transient toasts float in: pinned to a
 * corner or the bottom centre, clear of a navigation rail (`offsetStart`), stacking what
 * the host hands it with the newest nearest the edge. It owns the polite and assertive
 * live regions (so its toasts do not also announce), the enter and exit motion (off under
 * reduced motion), and reports hover and focus so the host can pause its timers. The host
 * owns the queue, the timers and the `leaving` flag.
 */
export function ToastRegion({
  toasts, children, placement = 'bottom-start', offset, offsetStart = 0, layout = 'snackbar',
  onDismiss, dismissLabel = 'Dismiss notification', onPause, onResume, announce = true,
  zIndex = 1059, style, ...rest
}) {
  const { edge, align } = toastPlacement(placement);
  const o = typeof offset === 'number' ? { x: offset, y: offset } : offset || {};
  const x = o.x != null ? o.x : 20;
  const y = o.y != null ? o.y : 18;
  const list = Array.isArray(toasts) ? toasts.filter(Boolean) : [];
  const ordered = edge === 'top' ? list.slice().reverse() : list;

  /* The newest toast that is not on its way out is the one the regions speak. */
  const current = list.filter((t) => !t.leaving).slice(-1)[0];
  const urgent = current && (current.variant === 'danger' || current.variant === 'warning');
  const speech = toastSpeech(current);

  const paused = React.useRef(false);
  const pause = () => { if (!paused.current) { paused.current = true; if (onPause) onPause(); } };
  const resume = () => { if (paused.current) { paused.current = false; if (onResume) onResume(); } };
  const onBlur = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    resume();
  };

  const hasContent = ordered.length > 0 || React.Children.count(children) > 0;
  /* The regions stay mounted while the host drives `toasts`, so a new message lands in a
     live region that already exists. Hand-placed children announce for themselves. */
  const speaks = announce && Array.isArray(toasts);
  /* An emptied stack cannot report the pointer leaving; the next toast starts unpaused. */
  React.useEffect(() => { if (!hasContent) paused.current = false; }, [hasContent]);

  return (
    <div
      data-ak-toast-region=""
      style={{
        position: 'fixed', zIndex,
        insetInlineStart: offsetStart, insetInlineEnd: 0,
        [edge]: 0,
        display: 'flex', flexDirection: 'column', alignItems: ALIGN[align], gap: 8,
        padding: edge === 'top' ? `${y}px ${x}px 0` : `0 ${x}px ${y}px`,
        pointerEvents: 'none',
        ...style,
      }}
      {...rest}
    >
      {speaks ? (
        <React.Fragment>
          <LiveRegion politeness="polite" message={current && !urgent ? speech : ''} />
          <LiveRegion politeness="assertive" message={current && urgent ? speech : ''} />
        </React.Fragment>
      ) : null}
      {hasContent && (
        <div
          onMouseEnter={pause}
          onMouseLeave={resume}
          onFocus={pause}
          onBlur={onBlur}
          style={{ display: 'flex', flexDirection: 'column', alignItems: ALIGN[align], gap: 8, maxWidth: '100%', pointerEvents: 'auto' }}
        >
          {ordered.map((t, i) => {
            const own = {};
            Object.keys(t).forEach((k) => { if (!TOAST_ITEM_KEYS[k]) own[k] = t[k]; });
            const close = t.onClose || (onDismiss ? () => onDismiss(t.id) : undefined);
            return (
              <Toast
                key={t.id != null ? t.id : i}
                layout={layout}
                dismissLabel={dismissLabel}
                live={speaks ? 'off' : undefined}
                animated
                edge={edge}
                {...own}
                leaving={!!t.leaving}
                onClose={close}
              >
                {t.message}
              </Toast>
            );
          })}
          {children}
        </div>
      )}
    </div>
  );
}
