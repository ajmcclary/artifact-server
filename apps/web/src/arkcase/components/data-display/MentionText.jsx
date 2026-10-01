import React from 'react';

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ArkCase MentionText — a comment body with its @mentions drawn as names: each "@Name" that
 * matches a person in `people` takes 600 weight in the on-tint link ink, so the reader sees who
 * was called in. Longer names match first ("@Dana Okonkwo" before "@Dana"); text that names no
 * one renders unchanged. It is inline text — no element of its own around plain text.
 */
export function MentionText({ text, people = [] }) {
  const names = people.map((p) => p && p.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (text == null) return null;
  if (!names.length) return <>{text}</>;
  const re = new RegExp('(@(?:' + names.map(escapeRe).join('|') + '))', 'g');
  return (
    <>
      {String(text).split(re).filter((part) => part !== '').map((part, i) => (names.some((n) => part === '@' + n)
        ? <span key={i} data-mention="" style={{ fontWeight: 600, color: 'var(--text-link-on-tint, #00688f)' }}>{part}</span>
        : part))}
    </>
  );
}
