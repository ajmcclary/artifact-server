import {useEffect, useState} from "react";

import {api, ApiError, type AdministeredInvite} from "@/api/client";
import {Alert, DataGrid, Modal, RecordPanel, StatusPill, SurfaceState, type GridColumn} from "@/arkcase";
import {InviteForm} from "../invites/invite-form.tsx";
import {InviteLinkReady} from "../invites/invite-link-ready.tsx";
import {AddRecordButton, RequestFailure} from "./admin-parts.tsx";
import {AdminConsole} from "./admin-console.tsx";
import {dateOrDash} from "./admin-areas.ts";

interface InviteRow {
  readonly createdBy: string;
  readonly expires: string;
  readonly id: string;
  readonly invite: AdministeredInvite;
  readonly label: string;
  readonly role: string;
  readonly status: AdministeredInvite["status"];
  readonly uses: string;
}

const statusLabels = {active: "Active", expired: "Expired", revoked: "Revoked", used: "Used"} as const;
const statusTones = {active: "success", expired: "neutral", revoked: "danger", used: "primary"} as const;

/** Administrator-only invite links: create, copy once, revoke. */
export function InvitesScreen() {
  const [invites, setInvites] = useState<readonly AdministeredInvite[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{readonly invite: AdministeredInvite; readonly url: string} | null>(null);
  const [revoking, setRevoking] = useState<AdministeredInvite | null>(null);
  const [pending, setPending] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setInvites(await api.invites());
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "INVITES_UNAVAILABLE") {
        setUnavailable(true);
      } else {
        setError(caught instanceof Error ? caught : new Error("Invite list failed."));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (invite: AdministeredInvite) => {
    setPending(true);
    setError(null);
    try {
      await api.revokeInvite(invite.id);
      setRevoking(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The invite could not be revoked."));
    } finally {
      setPending(false);
    }
  };

  const closeCreate = () => {
    setCreating(false);
    setIssued(null);
    void load();
  };

  const rows: InviteRow[] = invites.map((invite) => ({
    createdBy: invite.createdByName ?? "—",
    expires: dateOrDash(invite.expiresAt),
    id: invite.id,
    invite,
    label: invite.email ?? "Anyone with the link",
    role: invite.role === "administrator" ? "Administrator" : "Member",
    status: invite.status,
    uses: `${invite.useCount} of ${invite.maxUses}`,
  }));
  const columns: GridColumn<InviteRow>[] = [
    {field: "label", headerName: "Invite", width: 260},
    {field: "role", headerName: "Role", width: 140},
    {field: "createdBy", headerName: "Created by", width: 180},
    {field: "uses", headerName: "Uses", type: "count", width: 110},
    {field: "expires", headerName: "Expires", type: "date", width: 130},
    {
      cellRenderer: (value: InviteRow["status"]) => <StatusPill label={statusLabels[value]} tone={statusTones[value]} />,
      field: "status",
      headerName: "Status",
      width: 120,
    },
  ];

  return (
    <AdminConsole administrator area="invites" inspector={null}>
      {error === null || revoking !== null ? null : <RequestFailure error={error} onRetry={() => void load()} />}
      {unavailable ? (
        <SurfaceState
          count={0}
          emptyBody="Invite links work when Artifact Server signs people in through WorkOS or OIDC."
          emptyIcon="bi-person-plus"
          emptyTitle="Invites need team sign-in"
          noun="invites"
          phase="ready"
          variant="dashed"
        />
      ) : loading && invites.length === 0 ? (
        <SurfaceState loadingTitle="Loading invites" noun="invites" phase="loading" skeleton={3} />
      ) : (
        <>
          <Alert density="compact" live="off" variant="neutral">
            Invites admit people only through your sign-in provider. Every invite created, redeemed or revoked is recorded in Activity.
          </Alert>
          <RecordPanel
            actions={<AddRecordButton label="Create invite link" onClick={() => setCreating(true)} />}
            capAlign="center"
            label="Invites"
            metaWrap
            subtitle={`${invites.length} invites · ${invites.filter((invite) => invite.status === "active").length} active`}
          >
            <DataGrid
              ariaLabel="Invites"
              columns={columns}
              quickFilter
              rowActions={(row: InviteRow) => row.status === "active"
                ? [{danger: true, icon: "bi-x-circle", label: "Revoke", onClick: () => setRevoking(row.invite)}]
                : null}
              rowActionsLabel={(row: InviteRow) => `Actions for ${row.label}`}
              rows={rows}
              selectable={false}
              statusBar={false}
            />
          </RecordPanel>
        </>
      )}

      <Modal
        fullscreenBelow={768}
        icon="bi-person-plus"
        inertSiblings
        onClose={closeCreate}
        open={creating}
        portal
        title={issued === null ? "Create invite link" : "Invite link ready"}
      >
        {issued === null ? (
          <InviteForm onCancel={closeCreate} onCreated={setIssued} opens={undefined} />
        ) : (
          <InviteLinkReady invite={issued.invite} onDone={closeCreate} onRevoked={closeCreate} url={issued.url} />
        )}
      </Modal>

      <Modal
        icon="bi-x-circle"
        inertSiblings
        onClose={() => setRevoking(null)}
        open={revoking !== null}
        portal
        primaryAction={{
          disabled: pending || revoking === null,
          label: pending ? "Revoking…" : "Revoke link",
          onClick: () => {
            if (revoking !== null) void revoke(revoking);
          },
          variant: "danger",
        }}
        size="sm"
        subtitle="Nobody can join with this link after you revoke it. People who already joined stay members."
        title="Revoke invite link"
      >
        {error === null ? null : <RequestFailure error={error} />}
      </Modal>
    </AdminConsole>
  );
}
