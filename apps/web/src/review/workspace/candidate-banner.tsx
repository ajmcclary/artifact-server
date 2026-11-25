import {useState} from "react";

import {Alert, Button, ModeBanner} from "@/arkcase";

import {candidateBannerCopy, type CandidateState} from "./candidate-model.ts";

/** What the banner needs to know about the version on screen. */
export interface CandidateBannerProps {
  /** The base version's number, or null when it is not in the loaded history. */
  readonly baseVersionNumber: number | null;
  /** Promote is offered only to a person signed in directly with edit authority (CND-004). */
  readonly canPromote: boolean;
  readonly canReject: boolean;
  /** The artifact's current version number, named when the candidate is stale. */
  readonly currentVersionNumber: number;
  readonly onPromote: () => void;
  readonly onReject: () => void;
  readonly pending: boolean;
  /** True when current is no longer the base, so promotion would be refused (CND-003). */
  readonly stale: boolean;
  readonly state: CandidateState;
  readonly versionNumber: number;
}

/**
 * Names a candidate opened by its exact-version link: staged output, not what
 * the artifact shows, until a person promotes it. A closed candidate keeps its
 * banner without actions. Reject cannot be undone (the server has no reopen),
 * so it asks in place first.
 */
export function CandidateBanner({
  baseVersionNumber,
  canPromote,
  canReject,
  currentVersionNumber,
  onPromote,
  onReject,
  pending,
  stale,
  state,
  versionNumber,
}: CandidateBannerProps) {
  const [asking, setAsking] = useState(false);
  const copy = candidateBannerCopy({baseVersionNumber, currentVersionNumber, stale, state, versionNumber});
  const open = state === "candidate";
  return (
    <ModeBanner
      actions={open ? (
        <>
          {canReject ? (
            <Button disabled={pending || asking} icon="bi-x-circle" onClick={() => setAsking(true)} size="sm" variant="secondary">
              Reject
            </Button>
          ) : null}
          {canPromote ? (
            <Button disabled={pending || stale || asking} icon="bi-check2-circle" onClick={onPromote} size="sm" variant="primary">
              Promote
            </Button>
          ) : null}
        </>
      ) : null}
      aria-label={`Candidate version ${versionNumber}`}
      data-testid="candidate-banner"
      icon="bi-git"
      title={copy.title}
      variant="card"
    >
      {copy.body}
      {open && asking ? (
        <Alert variant="warning">
          <span style={{display: "flex", flexDirection: "column", gap: 6}}>
            <span>{copy.rejectQuestion}</span>
            <span style={{alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8}}>
              <Button disabled={pending} onClick={() => setAsking(false)} outline size="xs" variant="secondary">
                Cancel
              </Button>
              <Button
                disabled={pending}
                onClick={() => {
                  setAsking(false);
                  onReject();
                }}
                size="xs"
                variant="danger"
              >
                Reject Candidate
              </Button>
            </span>
          </span>
        </Alert>
      ) : null}
    </ModeBanner>
  );
}
