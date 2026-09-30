import React from 'react';

/**
 * ArkCase PreviewFrame — the sheet a review surface draws an artifact in: a card
 * with a slim navy title bar (a tone dot, the truncating title, a mono meta such
 * as the version) over the preview itself. `width` is the viewport preset the
 * reviewer chose — 1440, 834, 390 — or null to fit; the frame is centred and
 * never wider than its column. The body is `position: relative` so the host can
 * lay `AnnotationPin`s and a `PickLayer` over the content.
 *
 * `previewPresets(available)` returns the presets that fit the space the host
 * measured, so a narrow column never offers a width it cannot show.
 */

const DOT = {
  info: 'var(--bs-info, #0a7a90)',
  primary: 'var(--bs-primary, #0079a8)',
  success: 'var(--bs-success, #00b532)',
  warning: 'var(--bs-warning, #ff9a15)',
  danger: 'var(--bs-danger, #d83506)',
  neutral: 'var(--bs-gray-600, #6c757d)',
};

const DEFAULT_PREVIEW_PRESETS = [
  { key: 'Fit', px: null }, { key: '1440', px: 1440 }, { key: '834', px: 834 }, { key: '390', px: 390 },
];

export function previewPresets(available, presets = DEFAULT_PREVIEW_PRESETS, slack = 40) {
  const room = Number(available);
  return presets.filter((p) => p.px == null || !Number.isFinite(room) || p.px <= room + slack);
}

export function PreviewFrame({
  title, meta, dotTone = 'info', width = null, label, children, style, bodyStyle, ...rest
}) {
  return (
    <section
      aria-label={label || (typeof title === 'string' ? title : undefined)}
      data-preview-frame={width == null ? 'fit' : String(width)}
      style={{
        position: 'relative', boxSizing: 'border-box',
        width: width == null ? '100%' : width, maxWidth: '100%', margin: '0 auto',
        background: 'var(--surface-card, #fff)', color: 'var(--text-body, #212529)',
        border: '1px solid var(--border-color, #dee2e6)', borderRadius: 5, overflow: 'hidden',
        boxShadow: 'var(--shadow-card, 0 1px 3px rgba(7,54,82,.10))',
        ...style,
      }}
      {...rest}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', background: 'var(--surface-header, #073652)' }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 8, height: 8, borderRadius: '50%', background: DOT[dotTone] || DOT.info }} />
        <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 12, color: 'var(--text-on-navy, #fff)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {meta != null && meta !== '' && (
          <span style={{ flex: 'none', fontFamily: 'var(--font-data, monospace)', fontSize: 11, color: 'var(--text-on-navy-secondary, rgba(255,255,255,.72))' }}>{meta}</span>
        )}
      </div>
      <div data-preview-body="" style={{ position: 'relative', ...bodyStyle }}>
        {children}
      </div>
    </section>
  );
}
