import React from 'react';
import { Avatar } from './Avatar.jsx';
import { Button } from '../actions/Button.jsx';

/**
 * ArkCase IdentityBlock — a compact "who is this" summary: an optional avatar,
 * the person's name (14px semibold) and one detail line (email, role), with an
 * optional trailing link action such as "Change". `framed` sets it in the
 * secondary-surface box used on sign-in cards; unframed it heads an account
 * menu. Emails and ids take the data face via `detailMono`; roles stay in
 * Public Sans.
 */
export function IdentityBlock({
  name,
  detail,
  detailMono = false,
  avatar = false,
  actionLabel,
  onAction,
  framed = false,
  style,
  ...rest
}) {
  const avatarProps = avatar ? (typeof avatar === 'object' ? avatar : {}) : null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2, 10px)',
        minWidth: 0,
        ...(framed ? {
          justifyContent: 'space-between',
          padding: '10px 12px',
          background: 'var(--surface-secondary, #f8f9fa)',
          border: 'var(--border-width, 1px) solid var(--border-color, #dee2e6)',
          borderRadius: 'var(--radius-md, 5px)',
        } : null),
        ...style,
      }}
      {...rest}
    >
      {avatarProps ? (
        <Avatar name={name} initials={avatarProps.initials} size={avatarProps.size || 32} />
      ) : null}
      <span style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {name ? (
          <span style={{ fontSize: 'var(--font-size-sm, 14px)', fontWeight: 'var(--bs-font-weight-semibold, 600)', color: 'var(--text-body, #212529)', overflowWrap: 'anywhere' }}>
            {name}
          </span>
        ) : null}
        {detail ? (
          <span
            style={detailMono ? {
              fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
              fontSize: 'var(--font-size-sm, 14px)',
              color: 'var(--text-data, #495057)',
              overflowWrap: 'anywhere',
            } : {
              fontSize: 'var(--font-size-xs, 12px)',
              color: 'var(--text-secondary, #5a6268)',
              overflowWrap: 'anywhere',
            }}
          >
            {detail}
          </span>
        ) : null}
      </span>
      {actionLabel && onAction ? (
        <Button variant="link" size="sm" onClick={onAction} style={{ flex: 'none' }}>{actionLabel}</Button>
      ) : null}
    </div>
  );
}
