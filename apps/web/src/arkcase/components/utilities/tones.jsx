/**
 * ArkCase tones — one registry from a semantic tone to the tokens that paint it, so a host
 * stops writing its own `{ success: '#15803d', … }` map. Every value is a `var(--token,
 * #fallback)` string built only from tokens that exist in tokens.json, with the Default
 * theme value as the literal fallback, and the choices match StatusPill (pill pair), Alert
 * and StateStrip (solid accent) and the date tones (`text-overdue`, `text-due-soon`).
 *
 * Text-safe members: `text` (on card, body, canvas and secondary surfaces), `pillFg` on
 * `pillBg`, `ink` on `fill`. Non-text only: `fill`, `line`, `icon` — the success and warning
 * accents fall below 3:1 on white, so they never carry meaning on their own.
 */

const v = (name, fallback) => `var(--${name}, ${fallback})`;

/** Every supported tone, in StatusPill order plus `critical`. */
export const TONES = ['primary', 'success', 'warning', 'danger', 'neutral', 'secondary', 'critical'];

const WHITE = v('text-on-primary', '#ffffff');

const REGISTRY = {
  primary: {
    fill: v('bs-primary', '#0079a8'), ink: WHITE,
    pillBg: v('pill-primary-bg', '#e0f2fe'), pillFg: v('pill-primary-fg', '#0369a1'),
    line: v('bs-primary', '#0079a8'), text: v('pill-primary-fg', '#0369a1'), icon: v('bs-primary', '#0079a8'),
  },
  success: {
    fill: v('bs-success', '#00b532'), ink: v('text-on-success', '#212529'),
    pillBg: v('pill-success-bg', '#dcfce7'), pillFg: v('pill-success-fg', '#15803d'),
    line: v('bs-success', '#00b532'), text: v('pill-success-fg', '#15803d'), icon: v('bs-success', '#00b532'),
  },
  warning: {
    fill: v('bs-warning', '#ff9a15'), ink: v('text-on-warning', '#212529'),
    pillBg: v('pill-warning-bg', '#fef3c7'), pillFg: v('pill-warning-fg', '#92400e'),
    line: v('bs-warning', '#ff9a15'), text: v('text-due-soon', '#92400e'), icon: v('bs-warning', '#ff9a15'),
  },
  danger: {
    fill: v('bs-danger', '#d83506'), ink: WHITE,
    pillBg: v('pill-danger-bg', '#fee2e2'), pillFg: v('pill-danger-fg', '#991b1b'),
    line: v('bs-danger', '#d83506'), text: v('text-overdue', '#991b1b'), icon: v('bs-danger', '#d83506'),
  },
  neutral: {
    fill: v('bs-gray-600', '#6c757d'), ink: WHITE,
    pillBg: v('pill-neutral-bg', '#e9ecef'), pillFg: v('pill-neutral-fg', '#495057'),
    line: v('bs-gray-600', '#6c757d'), text: v('text-secondary', '#5a6268'), icon: v('text-secondary', '#5a6268'),
  },
  secondary: {
    fill: v('bs-purple-muted', '#7f5fa3'), ink: WHITE,
    pillBg: v('pill-secondary-bg', '#f3e8ff'), pillFg: v('pill-secondary-fg', '#6b21a8'),
    line: v('bs-purple', '#9f44e0'), text: v('pill-secondary-fg', '#6b21a8'), icon: v('bs-purple', '#9f44e0'),
  },
  critical: {
    fill: v('pill-critical-bg', '#d83506'), ink: v('pill-critical-fg', '#ffffff'),
    pillBg: v('pill-critical-bg', '#d83506'), pillFg: v('pill-critical-fg', '#ffffff'),
    line: v('bs-danger', '#d83506'), text: v('text-overdue', '#991b1b'), icon: v('bs-danger', '#d83506'),
  },
};

/** The token set for a tone. Unknown or missing tones resolve to `neutral`. Returns a fresh object. */
export function toneTokens(tone) {
  return { ...(REGISTRY[tone] || REGISTRY.neutral) };
}

const ICONS = {
  primary: 'bi-info-circle-fill',
  success: 'bi-check-circle-fill',
  warning: 'bi-exclamation-triangle-fill',
  danger: 'bi-x-circle-fill',
  neutral: 'bi-dash-circle',
  secondary: 'bi-dash-circle',
  critical: 'bi-exclamation-octagon-fill',
};

/** The default status glyph class for a tone (`bi-*`, without the leading `bi`); unknown → the neutral glyph. */
export function toneIcon(tone) {
  return ICONS[tone] || ICONS.neutral;
}
