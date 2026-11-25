/** A version's place in candidate review (CND-001); mainline versions never show the banner. */
export type CandidateState = "candidate" | "promoted" | "rejected" | "superseded";

export interface CandidateBannerCopyInput {
  /** The base version's number, or null when it is not in the loaded history. */
  readonly baseVersionNumber: number | null;
  readonly currentVersionNumber: number;
  readonly stale: boolean;
  readonly state: CandidateState;
  readonly versionNumber: number;
}

export interface CandidateBannerCopy {
  readonly body: string;
  /** Asked in place before Reject acts, because the server has no reopen. */
  readonly rejectQuestion: string;
  readonly title: string;
}

/** True when the version on screen is a candidate the banner speaks for. */
export function showsCandidateBanner(state: string): state is "candidate" | "rejected" | "superseded" {
  return state === "candidate" || state === "rejected" || state === "superseded";
}

/**
 * The candidate banner's words. A stale candidate names both versions literally,
 * because current may have moved forward or been rolled back past the base.
 */
export function candidateBannerCopy(input: CandidateBannerCopyInput): CandidateBannerCopy {
  const base = input.baseVersionNumber === null ? "an earlier version" : `version ${input.baseVersionNumber}`;
  const rejectQuestion = `Reject candidate v${input.versionNumber}? It will never become current, and this cannot be undone. Its bytes and comments are kept.`;
  if (input.state === "rejected" || input.state === "superseded") {
    return {
      body: `It never became current; its bytes and comments are kept. Version ${input.currentVersionNumber} is current.`,
      rejectQuestion,
      title: `${input.state === "rejected" ? "Rejected" : "Superseded"} candidate · based on ${base}`,
    };
  }
  if (input.stale) {
    const based = input.baseVersionNumber === null ? "Based on an earlier version" : `Based on v${input.baseVersionNumber}`;
    return {
      body: `${based}. Current is v${input.currentVersionNumber}, so this candidate can no longer be promoted. Stage a new candidate on v${input.currentVersionNumber}.`,
      rejectQuestion,
      title: `Candidate · based on ${base}`,
    };
  }
  return {
    body: "This version is waiting for review. Promoting makes this exact version current; rejecting keeps it and its comments.",
    rejectQuestion,
    title: `Candidate · based on ${base}`,
  };
}

/** What Review announces after a candidate is rejected; the reviewer stays on it. */
export function rejectedAnnouncement(versionNumber: number, currentVersionNumber: number): string {
  return `Candidate v${versionNumber} rejected. It never became current; its bytes and comments are kept. Version ${currentVersionNumber} is still current.`;
}

/** The Make Current confirmation, stating what moves and what stays (UX-18). */
export function makeCurrentMessage(versionNumber: number | string): string {
  return `Latest links and the public link will open version ${versionNumber}. Links pinned to a version and every conversation stay where they are. No saved version is changed or duplicated.`;
}
