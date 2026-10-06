import {useState} from "react";

import {api, type AdministeredInvite} from "@/api/client";
import {Alert, Button, Input, StatusPill} from "@/arkcase";
import {CopyAction} from "@/ui/copy-action";
import {dateOrDash} from "../settings/admin-areas.ts";

export interface InviteLinkReadyProps {
  readonly allInvitesHref?: string;
  readonly invite: AdministeredInvite;
  readonly onDone: () => void;
  readonly onRevoked: () => void;
  readonly url: string;
}

/** The one moment the invite link exists in the browser. */
export function InviteLinkReady({allInvitesHref, invite, onDone, onRevoked, url}: InviteLinkReadyProps) {
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const revoke = async () => {
    setPending(true);
    try {
      await api.revokeInvite(invite.id);
      onRevoked();
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "The invite could not be revoked.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 14}}>
      <Alert density="compact" title="Copy the link now" variant="success">
        Artifact Server keeps only a fingerprint of it, so this link is shown once.
      </Alert>
      <div style={{alignItems: "center", display: "flex", gap: 8}}>
        <Input aria-label="Invite link" icon="bi-link-45deg" mono readOnly size="sm" style={{flex: "1 1 auto", minWidth: 0}} value={url} />
        <CopyAction copiedLabel="Invite link copied" label="Copy invite link" text={url} variant="outline">Copy Link</CopyAction>
      </div>
      <dl style={{alignItems: "center", columnGap: 12, display: "grid", fontSize: 13, gridTemplateColumns: "88px minmax(0, 1fr)", margin: 0, rowGap: 10}}>
        <dt style={{color: "var(--text-secondary)", fontSize: 12}}>For</dt>
        <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{invite.email ?? "Anyone with the link"}</dd>
        <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Joins As</dt>
        <dd style={{margin: 0}}><StatusPill label={invite.role === "administrator" ? "Administrator" : "Member"} tone="primary" /></dd>
        <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Uses</dt>
        <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{invite.useCount} of {invite.maxUses}</dd>
        <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Expires</dt>
        <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{dateOrDash(invite.expiresAt)}</dd>
      </dl>
      <p style={{color: "var(--text-secondary)", fontSize: 12, margin: 0}}>
        Send it through your team's own channel. Artifact Server does not send email.
      </p>
      {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
      <div style={{alignItems: "center", display: "flex", gap: 8}}>
        <Button danger disabled={pending} flush onClick={() => void revoke()} size="sm" variant="link">Revoke Link</Button>
        <span style={{flex: "1 1 auto"}} />
        {allInvitesHref === undefined ? null : <Button href={allInvitesHref} size="sm" variant="link">All Invites</Button>}
        <Button onClick={onDone} size="sm">Done</Button>
      </div>
    </div>
  );
}
