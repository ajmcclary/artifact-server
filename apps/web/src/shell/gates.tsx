import type {ReactNode} from "react";

import "./shell-skeleton.css";

import {
  Alert,
  AuthCard,
  AuthLayout,
  BrandLock,
  Button,
  type AuthLayoutPoint,
} from "@/arkcase";

const gatePoints: AuthLayoutPoint[] = [
  {
    icon: "bi-chat-square-quote",
    text: "Leave a comment on the part of the design you mean, not in a separate thread.",
  },
  {icon: "bi-layers-half", text: "Compare versions and see which files changed."},
  {icon: "bi-send", text: "Send open comments to a connected agent."},
];

function GateFrame({children}: {readonly children: ReactNode}) {
  return (
    <AuthLayout
      brand={<BrandLock label="ArkCase" product="Artifact Server" size={17} tone="reversed" />}
      brandCompact={<BrandLock label="ArkCase" product="Artifact Server" size={15} tone="reversed" />}
      headline="Review designs together."
      lead="Review and comments live on the trusted application origin. Artifact content is served from isolated version hosts."
      points={gatePoints}
      style={{height: "100dvh", overflowY: "auto"}}
    >
      {children}
    </AuthLayout>
  );
}

/**
 * Shown while the session, access mode, and projects load: the shell's own
 * frame, identical to the copy in review.html that paints before any script,
 * so startup reads as the application arriving rather than a sign-in page.
 */
export function LoadingGate() {
  return (
    <div className="as-boot">
      <div aria-hidden="true" className="as-boot__nav">
        <div className="as-boot__brand" />
      </div>
      <main className="as-boot__main">
        <div className="as-boot__status" role="status">
          <div aria-hidden="true" className="as-boot__spinner" />
          <h1 className="as-boot__title">Loading Artifact Server</h1>
        </div>
      </main>
    </div>
  );
}

/** Shown when the installation requires sign-in; returns to `returnTo` after login. */
export function SignInGate({returnTo}: {readonly returnTo: string}) {
  return (
    <GateFrame>
      <AuthCard
        flush
        subtitle="Continue with the identity this installation trusts."
        title="Sign in required"
        titleSize="lg"
        width={440}
      >
        <Button
          block
          href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
          icon="bi-shield-lock"
          touch
          variant="primary"
        >
          Continue to sign in
        </Button>
      </AuthCard>
    </GateFrame>
  );
}

/** Shown when the application could not start; Try again re-runs the bootstrap. */
export function UnavailableGate({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <GateFrame>
      <AuthCard
        flush
        subtitle="The review workspace could not start."
        title="Artifact Server unavailable"
        titleSize="lg"
        width={440}
      >
        <div style={{display: "flex", flexDirection: "column", gap: 12}}>
          <Alert variant="danger">{message}</Alert>
          <Button block icon="bi-arrow-clockwise" onClick={onRetry} touch variant="primary">
            Try again
          </Button>
        </div>
      </AuthCard>
    </GateFrame>
  );
}
