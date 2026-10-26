import type {CSSProperties} from "react";

/** Copy for every ended, revoked, expired or unknown link. */
export const endedLinkMessage = "This link has ended or isn't valid. Ask the person who shared it for a new one.";

const pageStyle = {
  alignItems: "center",
  background: "var(--surface-page, #f5f6f8)",
  display: "flex",
  justifyContent: "center",
  minHeight: "100vh",
  padding: 24,
} satisfies CSSProperties;
const cardStyle = {
  background: "var(--surface-card, #fff)",
  border: "1px solid var(--border-subtle, #dde1e6)",
  borderRadius: 8,
  maxWidth: 440,
  padding: 24,
  textAlign: "center",
} satisfies CSSProperties;
const headingStyle = {fontSize: "var(--font-size-md, 16px)", margin: "8px 0"} satisfies CSSProperties;
const textStyle = {color: "var(--text-secondary)", margin: 0} satisfies CSSProperties;

/** What a guest sees once their link no longer opens anything. */
export function EndedLink() {
  return (
    <main style={pageStyle}>
      <section aria-labelledby="ended-link-heading" style={cardStyle}>
        <i aria-hidden="true" className="bi bi-link-45deg" />
        <h1 id="ended-link-heading" style={headingStyle}>This link has ended</h1>
        <p style={textStyle}>{endedLinkMessage}</p>
      </section>
    </main>
  );
}
