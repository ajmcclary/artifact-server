import React from 'react';
import { Avatar } from '../data-display/Avatar.jsx';
import { Tooltip } from '../feedback/Tooltip.jsx';

/**
 * ArkCase AccountButton — the signed-in person at the foot of the navigation
 * column, and the control that opens their account menu. Expanded, it is a row:
 * a 28px avatar, the name (truncating) over the role, and a trailing kebab. On
 * the rail it is the avatar alone in a 36px circle, and the name and role move
 * to its accessible name and a tooltip to the right that escapes the rail.
 *
 * `placement="bar"` is the same control on the navy top bar: a leading on-navy divider,
 * a 34px avatar, the name over the role in on-navy inks and a trailing chevron-down;
 * `compact` keeps only the avatar and chevron.
 *
 * The button owns only its hover; the menu it opens, and whether it is open,
 * belong to the host.
 */
export function AccountButton({
  name, role, initials, src, rail = false, placement = 'nav', compact = false, expanded, onClick, hasPopup = 'menu', label, style, ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const accessibleName = label || ('Account menu: ' + [name, role].filter(Boolean).join(', '));
  if (placement === 'bar') {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-haspopup={hasPopup || undefined}
        aria-expanded={expanded == null ? undefined : !!expanded}
        aria-label={accessibleName}
        data-account-button={compact ? 'bar-compact' : 'bar'}
        data-icon-tone="current"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: compact ? 6 : 10, flex: 'none',
          minHeight: 38, boxSizing: 'border-box',
          padding: compact ? '2px 6px 2px 16px' : '2px 8px 2px 16px',
          border: 0, borderLeft: '1px solid var(--border-on-navy, rgba(255,255,255,.18))',
          borderRadius: '0 var(--radius-md, 5px) var(--radius-md, 5px) 0',
          background: hover || expanded ? 'var(--surface-navy-strong, #0d4a6b)' : 'transparent',
          color: 'var(--text-on-navy, #ffffff)',
          cursor: 'pointer', font: 'inherit', textAlign: 'left',
          transition: 'background-color .15s ease',
          ...style,
        }}
        {...rest}
      >
        <span aria-hidden="true" style={{ display: 'inline-flex', flex: 'none' }}>
          <Avatar name={name} initials={initials} src={src} size={34} />
        </span>
        {!compact && (
          <span style={{ minWidth: 0, lineHeight: 1.2 }}>
            <span style={{ display: 'block', fontSize: 13, color: 'var(--text-on-navy, #ffffff)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
            {role != null && role !== '' && (
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-on-navy-secondary, rgba(255,255,255,.72))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{role}</span>
            )}
          </span>
        )}
        <i aria-hidden="true" className="bi bi-chevron-down" style={{ flex: 'none', fontSize: 11, marginLeft: 2, color: 'var(--text-on-navy-secondary, rgba(255,255,255,.72))' }} />
      </button>
    );
  }
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup={hasPopup || undefined}
      aria-expanded={expanded == null ? undefined : !!expanded}
      aria-label={accessibleName}
      data-account-button={rail ? 'rail' : 'expanded'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', border: 0, cursor: 'pointer', font: 'inherit',
        background: hover || expanded ? 'var(--tint-primary-hover, rgba(0,121,168,.05))' : 'transparent',
        color: 'var(--text-body, #212529)',
        transition: 'background-color .15s ease',
        ...(rail
          ? { justifyContent: 'center', width: 36, height: 36, borderRadius: '50%', padding: 0 }
          : { gap: 10, width: '100%', borderRadius: 'var(--radius-md, 5px)', padding: '6px 4px', textAlign: 'left' }),
        ...style,
      }}
      {...rest}
    >
      <span aria-hidden="true" style={{ display: 'inline-flex', flex: 'none' }}>
        <Avatar name={name} initials={initials} src={src} size={28} />
      </span>
      {!rail && (
        <span style={{ flex: '1 1 auto', minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
          {role != null && role !== '' && (
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{role}</span>
          )}
        </span>
      )}
      {!rail && (
        <i aria-hidden="true" className="bi bi-three-dots-vertical" style={{ flex: 'none', fontSize: 13, color: 'var(--text-secondary, #5a6268)' }} />
      )}
    </button>
  );
  if (!rail) return button;
  return (
    <Tooltip label={[name, role].filter(Boolean).join(' · ')} placement="right" fixed>
      {button}
    </Tooltip>
  );
}
