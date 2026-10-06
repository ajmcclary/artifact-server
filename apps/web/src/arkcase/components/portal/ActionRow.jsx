import React from 'react';

/**
 * ArkCase ActionRow — the portal's list row. A lead mark, two lines of what it
 * is, the state it is in, and the one or two things the visitor may do about it.
 * Documents, submissions, conferences, decisions and drafts are all this row;
 * only the lead changes: an icon, or a date block when the row is an event.
 */
export function ActionRow({ icon, date, title, meta, note, noteTone = 'default', status, children, last = false, style, ...rest }) {
  const noteColor = noteTone === 'overdue' ? 'var(--text-overdue, #991b1b)' : noteTone === 'due-soon' ? 'var(--text-due-soon, #92400e)' : 'var(--text-secondary, #5a6268)';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', borderBottom: last ? 'none' : '1px solid var(--surface-tertiary, #e9ecef)', flexWrap:'wrap', ...style }} {...rest}>
      {date && (
        <div style={{ flex:'none', width:52, textAlign:'center', background:'var(--surface-navy-subtle, #eaf1f6)', borderRadius:'var(--radius-md, 5px)', padding:'6px 4px' }}>
          <div style={{ fontSize:'var(--font-size-label, 11px)', letterSpacing:'.025em', textTransform:'uppercase', color:'var(--text-link-on-tint, #00688f)' }}>{date.month}</div>
          <div style={{ fontFamily:'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontVariantNumeric:'var(--font-numeric-feature, tabular-nums)', fontSize:18, fontWeight:600, color:'var(--text-navy, #073652)' }}>{date.day}</div>
        </div>
      )}
      {!date && icon && <i aria-hidden="true" className={'bi ' + icon} style={{ fontSize:18, color:'var(--bs-primary, #0079a8)' }} />}
      <div style={{ flex:1, minWidth:200 }}>
        <div style={{ fontSize:'var(--font-size-sm, 14px)', fontWeight:500, color:'var(--text-body, #212529)' }}>{title}</div>
        {meta != null && <div style={{ fontSize:'var(--font-size-sm, 14px)', color:'var(--text-secondary, #5a6268)' }}>{meta}</div>}
        {note != null && <div style={{ fontSize:'var(--font-size-sm, 14px)', color:noteColor, marginTop:4, maxWidth:'52em', textWrap:'pretty' }}>{note}</div>}
      </div>
      {status}
      {children}
    </div>
  );
}
