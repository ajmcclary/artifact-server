/** Private palette for application navigation; section navigation keeps the light recipe. */
export const navyNavigationStyle = {
  '--ac-nav-surface': 'var(--surface-navy-strong, #0d4a6b)',
  '--ac-nav-text': 'var(--text-on-navy, #fff)',
  '--ac-nav-secondary': 'var(--text-on-navy-secondary, #c0d9e8)',
  '--ac-nav-divider': 'var(--border-on-navy, rgba(255,255,255,.18))',
  '--ac-nav-selected': 'color-mix(in srgb, var(--text-on-navy, #fff) 16%, var(--surface-navy-strong, #0d4a6b))',
  '--ac-nav-hover': 'color-mix(in srgb, var(--text-on-navy, #fff) 8%, var(--surface-navy-strong, #0d4a6b))',
  '--ac-nav-marker': 'var(--text-on-navy, #fff)',
  '--focus-outline': '2px solid var(--text-on-navy, #fff)',
};
