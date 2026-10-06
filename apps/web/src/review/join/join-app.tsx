import {useEffect, useState} from "react";

import {api, ApiError, type InvitePreview} from "@/api/client";
import {Alert, AuthCard, Avatar, Button, Divider, StatusPill, SurfaceState} from "@/arkcase";
import {GateFrame} from "@/shell/gates";
import {usDate} from "@/ui/activity-model";

import {joinCopy, readJoinLocation, type JoinLocation, type JoinOutcome} from "./join-model.ts";

type ActivePreview = Exclude<InvitePreview, {readonly status: "invalid"}>;

const roleLabel = (role: "administrator" | "member") => role === "administrator" ? "Administrator" : "Member";

/** `/review/join`: preview an invite, start sign-in, explain refusals, welcome. */
export function JoinApp() {
  const [location] = useState<JoinLocation>(() => readJoinLocation(window.location));
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (location.kind !== "invite") return;
    const check = async () => {
      try {
        setPreview(await api.previewInvite(location.token));
      } catch (caught) {
        setFailure(caught instanceof ApiError && caught.status === 429
          ? "Too many invite attempts from this server. Wait a minute and try again."
          : "The invite could not be checked. Try again.");
      }
    };
    void check();
  }, [location]);

  const start = async (forceSignIn: boolean) => {
    if (location.kind !== "invite") return;
    setPending(true);
    setFailure(null);
    try {
      const started = await api.startInvite(location.token, forceSignIn);
      if ("authorizationUrl" in started) {
        window.location.assign(started.authorizationUrl);
        return;
      }
      setPreview(started);
    } catch {
      setFailure("Sign-in could not start. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <GateFrame>
      {location.kind === "welcome" ? <Welcome next={location.next} />
        : location.kind === "outcome" ? <Refusal outcome={location.outcome} />
        : location.kind === "missing" ? <Refusal outcome="invalid" />
        : failure !== null && preview === null ? (
          <AuthCard flush title="Invite unavailable" titleSize="lg" width={440}>
            <Alert variant="danger">{failure}</Alert>
          </AuthCard>
        )
        : preview === null ? <SurfaceState loadingStyle="spinner" loadingTitle="Checking your invite" noun="invite" phase="loading" />
        : preview.status === "invalid" ? <Refusal outcome="invalid" />
        : preview.status !== "active" ? <Refusal outcome={preview.status} />
        : <Invitation failure={failure} onStart={(force) => void start(force)} pending={pending} preview={preview} />}
    </GateFrame>
  );
}

function Invitation({failure, onStart, pending, preview}: {
  readonly failure: string | null;
  readonly onStart: (forceSignIn: boolean) => void;
  readonly pending: boolean;
  readonly preview: ActivePreview;
}) {
  return (
    <AuthCard
      flush
      subtitle="You have been invited to review work on this Artifact Server."
      title="Join this Artifact Server"
      titleSize="lg"
      width={440}
    >
      <div style={{display: "flex", flexDirection: "column", gap: 18}}>
        {preview.inviterName === null ? null : (
          <div style={{alignItems: "center", background: "var(--surface-navy-subtle)", borderRadius: "var(--radius-md)", display: "flex", gap: 12, padding: 12}}>
            <Avatar name={preview.inviterName} size={36} />
            <span style={{fontSize: 14, fontWeight: 600}}>{preview.inviterName} invited you</span>
          </div>
        )}
        <dl style={{alignItems: "center", columnGap: 12, display: "grid", gridTemplateColumns: "108px minmax(0, 1fr)", margin: 0, rowGap: 10}}>
          <dt style={{color: "var(--text-secondary)", fontSize: 12}}>You Join As</dt>
          <dd style={{margin: 0}}><StatusPill label={roleLabel(preview.role)} tone="primary" /></dd>
          {preview.opens === null ? null : (
            <>
              <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Opens</dt>
              <dd style={{margin: 0}}>{preview.opens.artifactName} · v{preview.opens.versionNumber}</dd>
            </>
          )}
          {preview.maskedEmail === null ? (
            <>
              <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Uses</dt>
              <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{preview.usesLeft} left</dd>
            </>
          ) : (
            <>
              <dt style={{color: "var(--text-secondary)", fontSize: 12}}>For</dt>
              <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{preview.maskedEmail}</dd>
            </>
          )}
          <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Expires</dt>
          <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{usDate(Date.parse(preview.expiresAt))}</dd>
        </dl>
        {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
        <Button block icon="bi-shield-lock" loading={pending} onClick={() => onStart(false)} touch variant="primary">
          Continue to Sign In
        </Button>
        <Button block disabled={pending} onClick={() => onStart(true)} variant="link">
          Use a Different Account
        </Button>
        <p style={{color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5, margin: 0}}>
          Sign in with a passkey, Google, GitHub or an email code. Artifact Server never sees your password.
        </p>
      </div>
    </AuthCard>
  );
}

function Refusal({outcome}: {readonly outcome: JoinOutcome}) {
  const copy = joinCopy(outcome);
  return (
    <AuthCard flush subtitle={copy.body} title={copy.title} titleSize="lg" width={440}>
      <div style={{display: "flex", flexDirection: "column", gap: 18}}>
        <div><StatusPill label={copy.pill} tone={copy.tone} /></div>
        <Divider label="Already a member" />
        <Button block href="/auth/login?returnTo=%2Freview" icon="bi-shield-lock" outline touch variant="secondary">
          Sign In
        </Button>
      </div>
    </AuthCard>
  );
}

function Welcome({next}: {readonly next: string}) {
  return (
    <AuthCard
      flush
      subtitle="You can open every project on this Artifact Server."
      title="Welcome to Artifact Server"
      titleSize="lg"
      width={440}
    >
      <div style={{display: "flex", flexDirection: "column", gap: 12}}>
        <Button block href={next} iconRight="bi-arrow-right" touch variant="primary">
          Continue
        </Button>
        <Button block href="/review/projects" variant="link">Browse Projects</Button>
      </div>
    </AuthCard>
  );
}
