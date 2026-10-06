import React from 'react';

/**
 * ArkCase SlideOver — the panel that docks beside the board rather than over it.
 * An inspector, a library, a details pane: work the user does while still
 * reading what it applies to, so it takes width from the content instead of
 * covering it. Use Modal when the answer must come before anything else.
 *
 * `leading` sits before the title block — a Back button when the pane has drilled into one
 * item — and `titleMeta` sits inline right after the title text, a count badge that never
 * truncates while the title does. `width="100%"` fills the parent: inside a `Panel` the
 * sheet takes the pane's full height and leaves the edge rule to the pane. `fullscreen`
 * is the phone form: the pane covers the viewport (fixed, inset 0, at `zIndex`).
 * `actions` sits in the header before the close button — a pane-level command such as
 * Compare.
 */
export function SlideOver({ title, subtitle, leading, titleMeta, actions, onClose, closeLabel = 'Close', footer, width = 320, side = 'end', fullscreen = false, zIndex = 1040, style, bodyStyle, children, ...rest }) {
  const fill = width === '100%';
  const edge = fill || fullscreen ? null : side === 'start' ? { borderRight:'1px solid var(--border-color, #dee2e6)' } : { borderLeft:'1px solid var(--border-color, #dee2e6)' };
  const size = fullscreen
    ? { position:'fixed', inset:0, width:'auto', zIndex, boxSizing:'border-box' }
    : fill ? { width:'100%', height:'100%', minWidth:0, boxSizing:'border-box' } : { width };
  return (
    <aside
      aria-label={typeof title === 'string' ? title : 'Panel'}
      style={{ flex:'none', ...size, display:'flex', flexDirection:'column', minHeight:0, background:'var(--surface-card, #fff)', ...edge, ...style }}
      {...rest}
    >
      <div style={{ flex:'none', display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, padding:leading != null ? '10px 10px 10px 8px' : '10px 10px 10px 16px', borderBottom:'1px solid var(--border-color, #dee2e6)', background:'var(--surface-secondary, #f8f9fa)' }}>
        {leading != null && <div style={{ flex:'none', display:'flex', alignItems:'center' }}>{leading}</div>}
        <div style={{ flex:'1 1 auto', minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
            <div style={{ flex:'0 1 auto', minWidth:0, fontFamily:'var(--font-heading, "Source Serif 4", Georgia, serif)', fontSize:'var(--font-size-lg, 20px)', fontWeight:600, color:'var(--text-strong, #111827)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{title}</div>
            {titleMeta != null && <div style={{ flex:'none', display:'inline-flex', alignItems:'center' }}>{titleMeta}</div>}
          </div>
          {subtitle != null && <div style={{ fontSize:'var(--font-size-xs, 12px)', color:'var(--text-secondary, #5a6268)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{subtitle}</div>}
        </div>
        {actions != null && <div style={{ flex:'none', display:'flex', alignItems:'center', gap:4 }}>{actions}</div>}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            style={{ flex:'none', display:'inline-flex', alignItems:'center', justifyContent:'center', width:30, height:30, border:0, borderRadius:'var(--radius-md, 5px)', background:'transparent', color:'var(--text-emphasis, #374151)', cursor:'pointer' }}
          >
            <i aria-hidden="true" className="bi bi-x-lg" style={{ fontSize:14 }} />
          </button>
        )}
      </div>
      <div tabIndex={0} style={{ flex:'1 1 auto', minHeight:0, overflowY:'auto', padding:'14px 16px', display:'flex', flexDirection:'column', gap:12, outline:'none', ...bodyStyle }}>{children}</div>
      {footer && <div style={{ flex:'none', padding:'10px 16px', borderTop:'1px solid var(--border-color, #dee2e6)', background:'var(--surface-secondary, #f8f9fa)' }}>{footer}</div>}
    </aside>
  );
}
