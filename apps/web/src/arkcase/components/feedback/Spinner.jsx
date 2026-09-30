import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { VisuallyHidden } from '../utilities/VisuallyHidden.jsx';

/* Inject the rotation keyframe and the reduced-motion slowdown once. The animation
   lives in the sheet (not inline) so the media query can slow it. */
function ensureSpinnerKeyframes() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-spinner-kf')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-spinner-kf';
  s.textContent =
    '@keyframes ak-spinner{to{transform:rotate(360deg)}}' +
    '[data-ak-spinner]{animation:ak-spinner .8s linear infinite}' +
    '@media (prefers-reduced-motion:reduce){[data-ak-spinner]{animation-duration:2.4s}}';
  akStyleDocument.head.appendChild(s);
}

/**
 * ArkCase Spinner — an indeterminate busy ring for a wait with no known end
 * (a sign-in hand-off, a callback). Hairline ring with a primary arc, 0.8s per
 * turn, slowed to 2.4s under reduced motion rather than stopped, so the page
 * never looks frozen. With a `label` it is a polite status; without one it is
 * decorative and the surrounding text carries the meaning.
 */
export function Spinner({ size = 22, label, style, ...rest }) {
  React.useEffect(ensureSpinnerKeyframes, []);
  const ring = (
    <span
      data-ak-spinner=""
      aria-hidden="true"
      style={{
        display: 'inline-block',
        flex: 'none',
        width: size,
        height: size,
        boxSizing: 'border-box',
        borderRadius: '50%',
        border: '2px solid var(--border-color, #dee2e6)',
        borderTopColor: 'var(--bs-primary, #0079a8)',
      }}
    />
  );
  return (
    <span
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : 'true'}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', ...style }}
      {...rest}
    >
      {ring}
      {label ? <VisuallyHidden>{label}</VisuallyHidden> : null}
    </span>
  );
}
