export const joinOutcomes = [
  "account_unavailable",
  "expired",
  "invalid",
  "revoked",
  "unverified",
  "used",
  "wrong_account",
] as const;

export type JoinOutcome = (typeof joinOutcomes)[number];

export type JoinLocation =
  | {readonly kind: "invite"; readonly token: string}
  | {readonly kind: "missing"}
  | {readonly kind: "outcome"; readonly outcome: JoinOutcome}
  | {readonly kind: "welcome"; readonly next: string};

const outcomeOf = (value: string | null): JoinOutcome | null =>
  joinOutcomes.find((candidate) => candidate === value) ?? null;

/** What `/review/join` shows. The token is only ever read from the fragment. */
export function readJoinLocation(location: {readonly hash: string; readonly search: string}): JoinLocation {
  const token = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (token !== "") return {kind: "invite", token};
  const query = new URLSearchParams(location.search);
  const outcome = outcomeOf(query.get("outcome"));
  if (outcome !== null) return {kind: "outcome", outcome};
  const next = safeReviewPath(query.get("next"));
  if (next !== null) return {kind: "welcome", next};
  return {kind: "missing"};
}

/** A same-origin `/review` path, or null. */
export function safeReviewPath(value: string | null): string | null {
  if (value === null || !value.startsWith("/review") || value.includes("\\")) return null;
  try {
    const base = new URL("https://artifactserver.invalid");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin || !parsed.pathname.startsWith("/review")) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export interface JoinCopy {
  readonly body: string;
  readonly pill: string;
  readonly title: string;
  readonly tone: "danger" | "neutral" | "primary" | "secondary";
}

const outcomeCopy = {
  account_unavailable: {
    body: "This account belongs to a deactivated member. Ask an administrator for help.",
    pill: "Unavailable",
    title: "This account can't join",
    tone: "danger",
  },
  expired: {
    body: "Invite links work for a limited time. Ask the person who invited you for a new link.",
    pill: "Expired",
    title: "This invite link has expired",
    tone: "secondary",
  },
  invalid: {
    body: "The link is incomplete or was changed. Ask the person who invited you for the full link.",
    pill: "Invalid",
    title: "This invite link doesn't work",
    tone: "danger",
  },
  revoked: {
    body: "An administrator turned this link off. Ask them for a new link.",
    pill: "Revoked",
    title: "This invite link was revoked",
    tone: "danger",
  },
  unverified: {
    body: "Finish verifying your email with your sign-in provider, then open the invite link again.",
    pill: "Not verified",
    title: "Your email isn't verified yet",
    tone: "secondary",
  },
  used: {
    body: "It already admitted the people it was made for. Ask the person who invited you for a new link.",
    pill: "Used",
    title: "This invite link has been used",
    tone: "primary",
  },
  wrong_account: {
    body: "Nothing has changed, and the invite is still unused. Open your invite link again and choose Use a Different Account.",
    pill: "Different account",
    title: "This invite is for a different account",
    tone: "danger",
  },
} as const satisfies Readonly<Record<JoinOutcome, JoinCopy>>;

/** What the join screen says for one refusal outcome. */
export function joinCopy(outcome: JoinOutcome): JoinCopy {
  return outcomeCopy[outcome];
}
