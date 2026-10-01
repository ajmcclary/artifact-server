import React from 'react';
import { Avatar } from './Avatar.jsx';
import { StatusPill } from './StatusPill.jsx';
import { Button } from '../actions/Button.jsx';
import { MentionText } from './MentionText.jsx';

/* The two sizes the prototypes drew: a side-panel thread (24px thread avatars, 14px copy)
   and a dense inspector list (20px avatars, 13px copy). Replies are always 20px. */
const DENSITY = {
  comfortable: { avatar: 24, reply: 20, text: 'var(--font-size-sm, 0.875rem)', pad: 'var(--space-3, 0.75rem) var(--space-4, 1rem)' },
  compact: { avatar: 20, reply: 20, text: 'var(--font-size-dense, 0.8125rem)', pad: 'var(--space-2, 0.5rem) var(--space-3, 0.75rem)' },
};

const LIST = { listStyle: 'none', margin: 0, padding: 0 };
const CLAMP = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
const bodyStyle = (d, c) => ({
  margin: 'var(--space-input-padding-y, 0.375rem) 0 0', fontSize: d.text, lineHeight: 'var(--line-height-normal, 1.5)',
  color: c.resolved ? 'var(--text-secondary, #5a6268)' : 'var(--text-body, #212529)', textWrap: 'pretty', overflowWrap: 'anywhere',
});

function Byline({ author, time, size, badge, resolved }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2, 0.5rem)', minWidth: 0, flexWrap: 'wrap' }}>
      {badge != null && <span style={{ flex: 'none', display: 'inline-flex' }}>{badge}</span>}
      <span aria-hidden="true" style={{ display: 'inline-flex', flex: 'none' }}><Avatar name={author} size={size} /></span>
      <span style={{ minWidth: 0, fontSize: 'var(--font-size-dense, 0.8125rem)', fontWeight: 'var(--bs-font-weight-semibold, 600)', color: 'var(--text-strong, #111827)' }}>{author}</span>
      {time != null && (
        <span style={{ fontFamily: 'var(--font-data, "Source Code Pro", monospace)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', fontSize: 'var(--font-size-xs, 0.75rem)', color: 'var(--text-data, #495057)' }}>{time}</span>
      )}
      {resolved && <StatusPill tone="success" label="Resolved" />}
    </div>
  );
}

function Reply({ reply, d, muted }) {
  return (
    <li style={{ margin: 'var(--space-input-padding-x, 0.625rem) 0 0 var(--space-3, 0.75rem)' }}>
      <article aria-label={`Reply by ${reply.author}`} style={{
        paddingLeft: 'var(--space-3, 0.75rem)',
        borderLeft: 'calc(var(--border-width, 1px) * 2) solid var(--border-color, #dee2e6)',
      }}>
        <Byline author={reply.author} time={reply.time} size={d.reply} badge={reply.badge} resolved={false} />
        <div style={{ margin: 'calc(var(--space-1, 0.25rem) * 0.5) 0 0', fontSize: d.text, lineHeight: 'var(--line-height-normal, 1.5)', color: muted ? 'var(--text-secondary, #5a6268)' : 'var(--text-body, #212529)', textWrap: 'pretty', overflowWrap: 'anywhere' }}>{reply.text}</div>
      </article>
    </li>
  );
}

/* One top-level thread. When its reply composer closes while it held focus (posted or
   escaped), focus would fall to <body>; it returns to the thread's Reply action instead. */
function Thread({ c, d, onReply, onResolve, renderReplyComposer, renderActions, selectable, selected, onSelect, visibleReplies, repliesOpen, onToggleReplies }) {
  /* Selectable threads collapse to a two-line summary until selected; the selected thread
     opens its replies, its composer and its actions. */
  const expanded = !selectable || selected;
  const allReplies = expanded ? (c.replies || []) : [];
  /* Folding a single reply behind a button costs more than it saves, so a thread folds
     only when at least two replies would hide. */
  const foldable = visibleReplies != null && allReplies.length > visibleReplies + 1;
  const hiddenCount = foldable && !repliesOpen ? allReplies.length - visibleReplies : 0;
  const replies = hiddenCount ? allReplies.slice(hiddenCount) : allReplies;
  const composer = expanded && renderReplyComposer ? renderReplyComposer(c.id) : null;
  const extra = expanded && renderActions ? renderActions(c.id) : null;
  const open = composer != null && composer !== false;
  const hasActions = expanded && !!(onReply || onResolve || (extra != null && extra !== false));
  const actionsRef = React.useRef(null);
  const focusInside = React.useRef(false);
  const wasOpen = React.useRef(open);
  React.useLayoutEffect(() => {
    if (wasOpen.current && !open && focusInside.current) {
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (!active || active === document.body || !active.isConnected) {
        const target = actionsRef.current && actionsRef.current.querySelector('button');
        if (target) target.focus();
      }
    }
    if (!open) focusInside.current = false;
    wasOpen.current = open;
  }, [open]);
  return (
    <li style={{
      borderBottom: 'var(--border-width, 1px) solid var(--list-divider, #e9ecef)',
      ...(selectable ? { borderLeft: 'calc(var(--border-width, 1px) * 3) solid ' + (selected ? 'var(--list-rail, #0079a8)' : 'transparent') } : null),
    }}>
      <article aria-label={`Comment by ${c.author}`} style={{
        padding: d.pad,
        background: selected ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : c.resolved ? 'var(--surface-secondary, #f8f9fa)' : 'transparent',
      }}>
        {selectable ? (
          <div
            role="button"
            tabIndex={0}
            aria-expanded={!!selected}
            onClick={() => onSelect(c.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(c.id); } }}
            style={{ cursor: 'pointer', borderRadius: 'var(--radius-sm, 4px)' }}
          >
            <Byline author={c.author} time={c.time} size={d.avatar} badge={c.badge} resolved={!!c.resolved} />
            <div style={{ ...bodyStyle(d, c), ...(selected ? null : CLAMP) }}>{c.text}</div>
            {!selected && c.activity != null && (
              <div style={{ marginTop: 'calc(var(--space-1, 0.25rem) * 0.75)', fontSize: 'var(--font-size-label, 0.6875rem)', color: 'var(--text-secondary, #5a6268)' }}>{c.activity}</div>
            )}
          </div>
        ) : (
          <React.Fragment>
            <Byline author={c.author} time={c.time} size={d.avatar} badge={c.badge} resolved={!!c.resolved} />
            <div style={bodyStyle(d, c)}>{c.text}</div>
          </React.Fragment>
        )}
        {allReplies.length > 0 && (
          <ul aria-label={`Replies to ${c.author}`} style={LIST}>
            {foldable && (
              <li key="toggle" style={{ margin: 'var(--space-input-padding-x, 0.625rem) 0 0 var(--space-3, 0.75rem)' }}>
                <Button variant="ghost" size="xs" icon={repliesOpen ? 'bi-chevron-up' : 'bi-chevron-down'}
                  aria-expanded={!!repliesOpen} onClick={() => onToggleReplies(c.id, !repliesOpen)}>
                  {repliesOpen ? 'Show fewer replies' : `Show ${hiddenCount} earlier ${hiddenCount === 1 ? 'reply' : 'replies'}`}
                </Button>
              </li>
            )}
            {replies.map((r) => <Reply key={r.id} reply={r} d={d} muted={!!c.resolved} />)}
          </ul>
        )}
        {open && (
          <div onFocus={() => { focusInside.current = true; }}
            style={{ margin: 'var(--space-input-padding-x, 0.625rem) 0 0 var(--space-3, 0.75rem)' }}>{composer}</div>
        )}
        {hasActions && (
          <div ref={actionsRef} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-1, 0.25rem)', marginTop: 'var(--space-2, 0.5rem)' }}>
            {onReply && (
              <Button variant="ghost" size="xs" icon="bi-reply" aria-label={`Reply to ${c.author}`} onClick={() => onReply(c.id)}>Reply</Button>
            )}
            {onResolve && (
              <Button variant="ghost" size="xs" icon={c.resolved ? 'bi-arrow-counterclockwise' : 'bi-check2'}
                aria-label={`${c.resolved ? 'Reopen' : 'Resolve'} comment by ${c.author}`}
                onClick={() => onResolve(c.id, !c.resolved)}>
                {c.resolved ? 'Reopen' : 'Resolve'}
              </Button>
            )}
            {extra}
          </div>
        )}
      </article>
    </li>
  );
}

/**
 * ArkCase CommentThread — a list of comment threads: author avatar and name, data-font time,
 * the comment, replies indented behind a 2px rule, and optional Reply / Resolve actions.
 * Resolved threads sit on the secondary surface in secondary text with a Resolved pill.
 * With `onSelect` the list becomes selectable: each thread collapses to its byline, a two-line
 * clamp of the comment and an optional activity line, and only the selected thread — marked by
 * the list rail and the selected tint — opens its replies, reply composer and actions.
 * The host owns the comments and every mutation; the component only reports intent.
 */
export function CommentThread({
  comments = [], onReply, onResolve, density = 'comfortable', renderReplyComposer, renderActions,
  selectedId, onSelect, visibleReplies, expandedIds, onToggleReplies, emptyMessage = 'No comments yet.', mentions, style, ...rest
}) {
  /* With `mentions`, every string body — comment and reply — draws its @mentions as names. */
  const mention = (text) => (mentions && typeof text === 'string' ? <MentionText text={text} people={mentions} /> : text);
  const list = mentions ? comments.map((c) => ({ ...c, text: mention(c.text),
    replies: c.replies ? c.replies.map((r) => ({ ...r, text: mention(r.text) })) : c.replies })) : comments;
  const selectable = typeof onSelect === 'function';
  const [ownExpanded, setOwnExpanded] = React.useState([]);
  const expandedList = expandedIds || ownExpanded;
  const toggleReplies = (id, next) => {
    if (onToggleReplies) onToggleReplies(id, next);
    if (!expandedIds) setOwnExpanded((all) => (next ? all.concat(id) : all.filter((x) => x !== id)));
  };
  const d = DENSITY[density] || DENSITY.comfortable;
  if (!list.length) {
    // No list, so no list name: a generic div must not carry aria-label.
    const { 'aria-label': _unused, ...plain } = rest;
    return (
      <div style={style} {...plain}>
        <p style={{ margin: 0, padding: d.pad, fontSize: 'var(--font-size-dense, 0.8125rem)', lineHeight: 'var(--line-height-normal, 1.5)', color: 'var(--text-secondary, #5a6268)' }}>{emptyMessage}</p>
      </div>
    );
  }
  return (
    <ul style={{ ...LIST, fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', ...style }} {...rest}>
      {list.map((c) => (
        <Thread key={c.id} c={c} d={d} onReply={onReply} onResolve={onResolve} renderReplyComposer={renderReplyComposer}
          renderActions={renderActions} selectable={selectable} selected={selectable && c.id === selectedId} onSelect={onSelect}
          visibleReplies={visibleReplies} repliesOpen={expandedList.indexOf(c.id) > -1} onToggleReplies={toggleReplies} />
      ))}
    </ul>
  );
}
