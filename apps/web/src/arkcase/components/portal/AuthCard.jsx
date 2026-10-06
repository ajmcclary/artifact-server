import React from 'react';

/**
 * ArkCase AuthCard — the centred card sign-in, verification and registration all
 * sit in. One measure, one heading, one sentence of why, then the fields. The
 * links below the action are the two ways out: the visitor who forgot, and the
 * visitor who has no account yet. A `mark` (a status icon circle) and a `badge`
 * (a StatusPill) may stand above the title on outcome screens; `titleSize="lg"`
 * is the 25px heading of a full-page auth column, and `flush` drops the outer
 * padding when a layout (AuthLayout) already provides the stage.
 */
export function AuthCard({ title, subtitle, links, width = 380, mark, badge, titleSize = 'md', flush = false, style, children, ...rest }) {
  const large = titleSize === 'lg';
  const has = (node) => node != null && node !== false && node !== '';
  return (
    <div style={{ display:'flex', justifyContent:'center', padding: flush ? 0 : '40px 20px', ...style }} {...rest}>
      <div style={{ width:'100%', maxWidth:width, background:'var(--surface-card, #fff)', border:'1px solid var(--border-color, #dee2e6)', borderRadius:'var(--radius-md, 5px)', boxShadow:'var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04))', padding:24 }}>
        {has(mark) && <div style={{ display:'flex', marginBottom:14 }}>{mark}</div>}
        {has(badge) && <div style={{ display:'flex', marginBottom:10 }}>{badge}</div>}
        {title != null && <h2 style={{ fontFamily:'var(--font-heading, "Source Serif 4", Georgia, serif)', fontWeight:600, fontSize: large ? 25 : 22, ...(large ? { lineHeight:1.22, textWrap:'pretty' } : null), margin:'0 0 6px', color:'var(--text-strong, #111827)' }}>{title}</h2>}
        {subtitle != null && <p style={{ fontSize:'var(--font-size-sm, 14px)', color:'var(--text-secondary, #5a6268)', margin:'0 0 16px', textWrap:'pretty' }}>{subtitle}</p>}
        {children}
        {links && <div style={{ display:'flex', justifyContent:'space-between', gap:12, marginTop:14, fontSize:'var(--font-size-sm, 14px)' }}>{links}</div>}
      </div>
    </div>
  );
}
