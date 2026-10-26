import {useCallback, useEffect, useState} from "react";

import {api, type AccessPolicy, type StoredAccessPolicy} from "@/api/client";
import {Alert, Button, Checkbox, Input, PageScaffold, Select, Switch} from "@/arkcase";
import {AdminActions, AdminNote, AdminPanel, AdminStack, RequestFailure} from "./admin-parts.tsx";
import {type Permission, permissionLabel, permissionOrder} from "./project-access-model.ts";

const guestHoldable: readonly Permission[] = ["artifact.view", "comment.read", "comment.write"];

const toggled = (values: readonly Permission[], permission: Permission, on: boolean): Permission[] =>
  on
    ? permissionOrder.filter((candidate) => candidate === permission || values.includes(candidate))
    : values.filter((candidate) => candidate !== permission);

/** The narrowing a saved policy reported, as one sentence. */
export function narrowedNotice(narrowed: {readonly grants: number; readonly shareLinks: number}): string {
  const grants = `${narrowed.grants} ${narrowed.grants === 1 ? "grant" : "grants"}`;
  const links = `${narrowed.shareLinks} share ${narrowed.shareLinks === 1 ? "link" : "links"}`;
  return `Saved. This narrows ${grants} and ${links}.`;
}

/** Installation-wide limits: share links, guest permissions, member ceiling, and the default project mode. */
export function AccessPolicyScreen() {
  const [stored, setStored] = useState<StoredAccessPolicy | null>(null);
  const [draft, setDraft] = useState<AccessPolicy | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const policy = await api.accessPolicy();
      setStored(policy);
      setDraft(policy.policy);
      setError(null);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure : new Error(String(failure)));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (draft === null || stored === null) {
    return (
      <PageScaffold title="Access policy">
        {error === null ? null : <RequestFailure error={error} onRetry={() => void load()} />}
      </PageScaffold>
    );
  }

  const save = async () => {
    setPending(true);
    setNotice(null);
    try {
      const written = await api.putAccessPolicy(draft, stored.revision);
      setStored(written.policy);
      setDraft(written.policy.policy);
      setNotice(narrowedNotice(written.narrowed));
      setError(null);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure : new Error(String(failure)));
    } finally {
      setPending(false);
    }
  };

  const ceiling = draft.members.memberCeiling;
  const links = draft.shareLinks;

  return (
    <PageScaffold
      meta="Limits that no project, grant, or share link can exceed. Narrowing a limit applies to existing access immediately."
      title="Access policy"
    >
      {error === null ? null : <RequestFailure error={error} />}
      {notice === null ? null : <Alert density="compact" variant="success">{notice}</Alert>}
      <AdminPanel label="Share links" subtitle="What people without an account can do">
        <AdminStack>
          <Switch
            checked={links.enabled}
            disabled={pending}
            label="Allow share links"
            onChange={(event) => setDraft({...draft, shareLinks: {...links, enabled: event.currentTarget.checked}})}
          />
          {guestHoldable.map((permission) => (
            <Checkbox
              checked={links.guestPermissionsMax.includes(permission)}
              disabled={pending || !links.enabled || permission === "artifact.view"}
              key={permission}
              label={`Guests may ${permissionLabel(permission).toLowerCase()}`}
              onChange={(event) => setDraft({
                ...draft,
                shareLinks: {
                  ...links,
                  guestPermissionsMax: toggled(links.guestPermissionsMax, permission, event.currentTarget.checked),
                },
              })}
            />
          ))}
          <Input
            disabled={pending}
            label="Longest a link may last, in days (empty for no limit)"
            onChange={(event) => {
              const days = Number.parseInt(event.currentTarget.value, 10);
              setDraft({...draft, shareLinks: {...links, maxExpiryDays: Number.isFinite(days) && days > 0 ? days : null}});
            }}
            size="sm"
            value={links.maxExpiryDays === null ? "" : String(links.maxExpiryDays)}
          />
          <Select
            disabled={pending}
            label="Who can create share links"
            onChange={(event) => setDraft({
              ...draft,
              shareLinks: {...links, linkCreators: event.currentTarget.value === "administrators" ? "administrators" : "sharers"},
            })}
            options={[
              {label: "Anyone who can share the artifact", value: "sharers"},
              {label: "Administrators only", value: "administrators"},
            ]}
            size="sm"
            value={links.linkCreators}
          />
        </AdminStack>
      </AdminPanel>
      <AdminPanel label="Members" subtitle="The most any member can do, whatever their grants">
        <AdminStack>
          <Switch
            checked={ceiling !== null}
            disabled={pending}
            label="Limit what members can do"
            onChange={(event) => setDraft({
              ...draft,
              members: {memberCeiling: event.currentTarget.checked ? [...permissionOrder] : null},
            })}
          />
          {ceiling === null ? (
            <AdminNote>Members can hold any permission their project role and grants give them.</AdminNote>
          ) : permissionOrder.map((permission) => (
            <Checkbox
              checked={ceiling.includes(permission)}
              disabled={pending}
              key={permission}
              label={permissionLabel(permission)}
              onChange={(event) => setDraft({
                ...draft,
                members: {memberCeiling: toggled(ceiling, permission, event.currentTarget.checked)},
              })}
            />
          ))}
          <Select
            disabled={pending}
            label="New projects start"
            onChange={(event) => setDraft({
              ...draft,
              projects: {defaultMode: event.currentTarget.value === "restricted" ? "restricted" : "open"},
            })}
            options={[
              {label: "Open to all members", value: "open"},
              {label: "Restricted to people listed", value: "restricted"},
            ]}
            size="sm"
            value={draft.projects.defaultMode}
          />
        </AdminStack>
      </AdminPanel>
      <AdminActions>
        <Button disabled={pending} icon="bi-save" onClick={() => void save()} size="sm">
          {pending ? "Saving…" : "Save policy"}
        </Button>
      </AdminActions>
    </PageScaffold>
  );
}
