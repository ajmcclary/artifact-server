import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { CopyButton } from '../actions/CopyButton.jsx';

/* The annotated variant is the Practices pages' `pre`: code with <b> marking what to type
   (accent on tint) and <i> marking commentary (secondary, upright). Inline styles cannot
   reach those descendants, so one scoped sheet does, keyed on the variant attribute. */
const ANNOTATED_STYLE_ID = 'ak-codeblock-annotated-css';
const ANNOTATED_CSS = [
  '[data-code-block="annotated"] b,[data-code-block="annotated"] strong{color:var(--text-link-on-tint,#00688f);font-weight:600}',
  '[data-code-block="annotated"] i,[data-code-block="annotated"] em{color:var(--text-secondary,#5a6268);font-style:normal}',
].join('\n');
function ensureAnnotatedStyles() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById(ANNOTATED_STYLE_ID)) return;
  const s = akStyleDocument.createElement('style');
  s.id = ANNOTATED_STYLE_ID;
  s.textContent = ANNOTATED_CSS;
  akStyleDocument.head.appendChild(s);
}

/* The text of a node tree, to tell a one-line block from a multi-line one. */
function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) return node.type === 'br' ? '\n' : textOf(node.props.children);
  return '';
}

const TONES = {
  neutral: { color: 'var(--text-data, #495057)', background: 'var(--surface-secondary, #f8f9fa)' },
  danger: { color: 'var(--pill-danger-fg, #991b1b)', background: 'var(--pill-danger-bg, #fee2e2)' },
  navy: { color: 'var(--text-on-navy, #ffffff)', background: 'var(--surface-header, #073652)' },
};

/**
 * ArkCase CodeBlock — preformatted code, markup or command output in the data
 * face on the panel-cap ground. `tone="danger"` is error output on the danger
 * pill tint; `tone="navy"` is a command well on the app-bar navy (a command to
 * paste, an endpoint URL). A block that scrolls (`wrap={false}` or a
 * `maxHeight`) and has a `label` becomes a focusable region so keyboard users
 * can scroll it. `copy` docks the shared CopyButton at the block's end.
 */
export function CodeBlock({ children, tone = 'neutral', variant = 'default', wrap = true, label, maxHeight, copy, style, ...rest }) {
  const annotated = variant === 'annotated';
  (React.useInsertionEffect || React.useLayoutEffect)(() => { if (annotated) ensureAnnotatedStyles(); }, [annotated]);
  const colors = annotated
    ? { color: 'var(--text-body, #212529)', background: 'var(--surface-secondary, #f8f9fa)' }
    : TONES[tone] || TONES.neutral;
  const scrollable = !wrap || maxHeight != null;
  const regionProps = label
    ? { role: 'region', 'aria-label': label, ...(scrollable ? { tabIndex: 0 } : null) }
    : null;
  const box = annotated
    ? {
      borderRadius: 0,
      borderLeft: '2px solid var(--bs-primary, #0079a8)',
      background: colors.background,
      color: colors.color,
      breakInside: 'avoid',
    }
    : {
      borderRadius: 'var(--radius-md, 5px)',
      background: colors.background,
      color: colors.color,
    };
  const pre = (
    <pre
      {...regionProps}
      data-code-block={annotated ? 'annotated' : undefined}
      style={{
        margin: 0,
        padding: annotated ? '10px 14px' : 'var(--space-input-padding-x, 10px) var(--space-3, 12px)',
        boxSizing: 'border-box',
        maxWidth: '100%',
        maxHeight,
        overflow: scrollable ? 'auto' : 'visible',
        ...(copy ? { flex: '1 1 auto', minWidth: 0, background: 'transparent', color: 'inherit' } : box),
        fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
        fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
        /* Annotated is a print specimen: guide.css sets its pre at 11.5px. */
        fontSize: annotated ? '11.5px' : 'var(--font-size-dense, 13px)',
        lineHeight: annotated ? 1.5 : 'var(--line-height-normal, 1.5)',
        whiteSpace: wrap ? 'pre-wrap' : 'pre',
        overflowWrap: wrap ? 'anywhere' : 'normal',
        tabSize: 2,
        ...(copy ? null : style),
      }}
      {...rest}
    >
      {children}
    </pre>
  );
  if (!copy) return pre;
  // A string keeps its original test; a node tree is read for line breaks the same way.
  const singleLine = typeof children === 'string' ? !children.includes('\n') : !textOf(children).includes('\n');
  return (
    <div
      style={{
        display: 'flex',
        alignItems: singleLine ? 'center' : 'flex-start',
        gap: 'var(--space-1, 4px)',
        maxWidth: '100%',
        boxSizing: 'border-box',
        paddingRight: 'var(--space-1, 6px)',
        ...box,
        ...style,
      }}
    >
      {pre}
      <CopyButton
        /* Navy is the tonal IconButton treatment (on-navy ink, data-icon-tone="current"). */
        variant={tone === 'navy' ? 'navy' : 'ghost'}
        aria-label={copy.label || 'Copy'}
        copiedLabel={copy.copiedLabel}
        onCopy={copy.onCopy}
        onAnnounce={copy.onAnnounce}
        style={{ flex: 'none', marginTop: singleLine ? 0 : 'var(--space-1, 5px)' }}
      />
    </div>
  );
}
