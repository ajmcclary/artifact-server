import {useEffect, useState} from "react";

import {api, type InstallationMember} from "@/api/client";
import {Button, Input, Modal, PageScaffold, Select, StatusPill, SurfaceState} from "@/arkcase";
import {formatTimestamp} from "@/lib/presentation";
import {
  AdminPanel,
  AdminStack,
  IdentityCell,
  Ledger,
  nativeInputAttributes,
  RequestFailure,
  type LedgerColumn,
} from "./admin-parts.tsx";

const roleOptions = [
  {label: "Member", value: "member"},
  {label: "Administrator", value: "administrator"},
];

/** Administrator-only installation member lifecycle surface. */
export function MembersScreen() {
  // Moved verbatim from settings-members.tsx:22-73; the two modal-state lines are new.
  const [members, setMembers] = useState<readonly InstallationMember[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"administrator" | "member">("member");
  const [admitOpen, setAdmitOpen] = useState(false);
  const [deactivating, setDeactivating] = useState<InstallationMember | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setMembers(await api.members());
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member list failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const admit = async () => {
    setPending(true);
    setError(null);
    try {
      await api.admitMember(displayName, email, role);
      setDisplayName("");
      setEmail("");
      setRole("member");
      await load();
      setAdmitOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member admission failed."));
    } finally {
      setPending(false);
    }
  };

  const deactivate = async (memberId: string) => {
    setPending(true);
    setError(null);
    try {
      await api.deactivateMember(memberId);
      await load();
      setDeactivating(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member deactivation failed."));
    } finally {
      setPending(false);
    }
  };

  const columns: readonly LedgerColumn<InstallationMember>[] = [
    {
      align: "left",
      cell: (member) => ({
        value: <IdentityCell detail={member.email} detailMono primary={member.displayName} />,
      }),
      key: "member",
      kind: "field",
      label: "Member",
      width: "minmax(0, 1.4fr)",
    },
    {
      align: "left",
      cell: (member) => ({value: member.role === "administrator" ? "Administrator" : "Member"}),
      key: "role",
      kind: "field",
      label: "Role",
      width: "140px",
    },
    {
      align: "left",
      cell: (member) => ({
        value: (
          <StatusPill
            label={member.status}
            tone={member.status === "active" ? "success" : "neutral"}
          />
        ),
      }),
      key: "status",
      kind: "field",
      label: "Status",
      width: "110px",
    },
    {
      align: "left",
      cell: (member) => ({mono: true, muted: true, value: formatTimestamp(member.createdAt)}),
      key: "admitted",
      kind: "field",
      label: "Admitted",
      width: "170px",
    },
    {
      align: "right",
      cell: (member) => ({
        value: member.status === "inactive" ? "" : (
          <Button
            danger
            disabled={pending}
            icon="bi-person-dash"
            onClick={() => setDeactivating(member)}
            size="sm"
            variant="ghost"
          >
            Deactivate
          </Button>
        ),
      }),
      key: "actions",
      kind: "action",
      label: "",
      width: "140px",
    },
  ];
  const activeCount = members.filter((member) => member.status === "active").length;

  return (
    <PageScaffold
      actions={(
        <Button icon="bi-person-plus" onClick={() => setAdmitOpen(true)} size="sm">
          Admit member
        </Button>
      )}
      count={loading && members.length === 0 ? null : `${members.length} admitted · ${activeCount} active`}
      meta="One installation has one closed member group. There is no public sign-up or project-specific membership."
      title="Members"
    >
      {error === null || admitOpen || deactivating !== null
        ? null
        : <RequestFailure error={error} onRetry={() => void load()} />}
      {loading && members.length === 0 ? (
        <SurfaceState loadingTitle="Loading members" noun="members" phase="loading" skeleton={3} />
      ) : (
        <AdminPanel label="Installation members" padded={false}>
          <Ledger
            ariaLabel="Installation members"
            columns={columns}
            rowKey={(member) => member.id}
            rows={members}
          />
        </AdminPanel>
      )}

      <Modal
        fullscreenBelow={768}
        icon="bi-person-plus"
        inertSiblings
        onClose={() => setAdmitOpen(false)}
        open={admitOpen}
        portal
        primaryAction={{
          disabled: pending || displayName.trim() === "" || email.trim() === "",
          label: pending ? "Admitting…" : "Admit member",
          onClick: () => void admit(),
        }}
        subtitle="Admit one person to this installation. Every active member can manage artifacts in every project."
        title="Admit member"
      >
        <AdminStack>
          {error === null ? null : <RequestFailure error={error} />}
          <Input
            {...nativeInputAttributes({maxLength: 200})}
            label="Display name"
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            size="sm"
            value={displayName}
          />
          <Input
            {...nativeInputAttributes({maxLength: 320})}
            label="Email"
            onChange={(event) => setEmail(event.currentTarget.value)}
            size="sm"
            type="email"
            value={email}
          />
          <Select
            helper="An administrator can also manage members, API keys, and public links."
            label="Role"
            onChange={(event) => {
              setRole(event.currentTarget.value === "administrator" ? "administrator" : "member");
            }}
            options={roleOptions}
            size="sm"
            value={role}
          />
        </AdminStack>
      </Modal>

      <Modal
        icon="bi-person-dash"
        inertSiblings
        onClose={() => setDeactivating(null)}
        open={deactivating !== null}
        portal
        primaryAction={{
          disabled: pending || deactivating === null,
          label: pending ? "Deactivating…" : "Deactivate member",
          onClick: () => {
            if (deactivating !== null) void deactivate(deactivating.id);
          },
          variant: "danger",
        }}
        size="sm"
        subtitle={deactivating === null
          ? ""
          : `${deactivating.displayName} will lose new browser sessions and API access. Existing artifact records and attribution remain unchanged.`}
        title="Deactivate member"
      >
        {error === null ? null : <RequestFailure error={error} />}
      </Modal>
    </PageScaffold>
  );
}
