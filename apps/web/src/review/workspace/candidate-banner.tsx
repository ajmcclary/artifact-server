import {Button, ModeBanner} from "@/arkcase";

/** What the banner needs to know about the version on screen. */
export interface CandidateBannerProps {
  /** The base version's number, or null when it is not in the loaded history. */
  readonly baseVersionNumber: number | null;
  /** Promote is offered only to a person signed in directly with edit authority (CND-004). */
  readonly canPromote: boolean;
  readonly canReject: boolean;
  readonly onPromote: () => void;
  readonly onReject: () => void;
  readonly pending: boolean;
  /** True when current has moved past the base, so promotion would be refused (CND-003). */
  readonly stale: boolean;
}

/**
 * Names an open candidate opened by its exact-version link: it is staged
 * output, not what the artifact shows, until a person promotes it.
 */
export function CandidateBanner({
  baseVersionNumber,
  canPromote,
  canReject,
  onPromote,
  onReject,
  pending,
  stale,
}: CandidateBannerProps) {
  const base = baseVersionNumber === null ? "an earlier version" : `version ${baseVersionNumber}`;
  return (
    <ModeBanner
      actions={
        <>
          {canReject ? (
            <Button disabled={pending} icon="bi-x-circle" onClick={onReject} size="sm" variant="secondary">
              Reject
            </Button>
          ) : null}
          {canPromote ? (
            <Button disabled={pending || stale} icon="bi-check2-circle" onClick={onPromote} size="sm" variant="primary">
              Promote
            </Button>
          ) : null}
        </>
      }
      data-testid="candidate-banner"
      icon="bi-git"
      title={`Candidate · based on ${base}`}
      variant="card"
    >
      {stale
        ? "The current version has moved past this candidate's base, so it can no longer be promoted. Stage a new candidate on the current version."
        : "This version is waiting for review. Promoting makes this exact version current; rejecting keeps it and its comments."}
    </ModeBanner>
  );
}
