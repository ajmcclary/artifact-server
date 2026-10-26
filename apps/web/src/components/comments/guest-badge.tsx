import type {CSSProperties} from "react";

const badgeStyle = {
  background: "var(--surface-muted, #eef0f3)",
  borderRadius: 4,
  color: "var(--text-secondary)",
  fontSize: 11,
  fontWeight: 600,
  padding: "1px 6px",
} satisfies CSSProperties;

/** Marks a comment written through a share link by someone without an account. */
export function GuestBadge() {
  return <span style={badgeStyle} title="Written through a share link by someone without an account">Guest</span>;
}
