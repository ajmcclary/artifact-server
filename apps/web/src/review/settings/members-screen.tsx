import {useEffect, useState} from "react";

import {api, type AdministeredMember} from "@/api/client";
import {
  Button, DataGrid, FieldGrid, Input, Modal, RecordPanel, Select, SlideOver, StatusPill, SurfaceState,
  type GridColumn,
} from "@/arkcase";
import {AddRecordButton, AdminStack, nativeInputAttributes, RequestFailure} from "./admin-parts.tsx";
import {AdminConsole, useAdminInspectorFullscreen} from "./admin-console.tsx";
import {admittedLabel, dateOrDash, dateTimeOrDash} from "./admin-areas.ts";
import {useSelectedRecord} from "./use-selected-record.ts";

interface MemberRow {
  readonly email: string;
  readonly id: string;
  readonly lastActive: string;
  readonly member: AdministeredMember;
  readonly name: string;
  readonly role: string;
  readonly status: "Active" | "Inactive";
}

const statusPill = (status: MemberRow["status"]) => (
  <StatusPill label={status} tone={status === "Active" ? "success" : "neutral"} />
);

const roleOptions = [
  {label: "Member", value: "member"},
  {label: "Administrator", value: "administrator"},
];

/** Administrator-only installation member lifecycle surface. */
export function MembersScreen() {
  const [members, setMembers] = useState<readonly AdministeredMember[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"administrator" | "member">("member");
  const [admitOpen, setAdmitOpen] = useState(false);
  const [deactivating, setDeactivating] = useState<AdministeredMember | null>(null);

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

  const [selectedId, selectRecord] = useSelectedRecord();
  const fullscreen = useAdminInspectorFullscreen();
  const rows: MemberRow[] = members.map((member) => ({
    email: member.email,
    id: member.id,
    lastActive: dateOrDash(member.lastActiveAt),
    member,
    name: member.displayName,
    role: member.role === "administrator" ? "Administrator" : "Member",
    status: member.status === "active" ? "Active" : "Inactive",
  }));
  const columns: GridColumn<MemberRow>[] = [
    {field: "name", headerName: "Member", onCellClick: (row) => selectRecord(row.id), width: 220},
    {field: "email", headerName: "Email", type: "contact", width: 260},
    {field: "role", headerName: "Role", width: 140},
    {cellRenderer: (value: MemberRow["status"]) => statusPill(value), field: "status", headerName: "Status", width: 120},
    {field: "lastActive", headerName: "Last active", type: "date", width: 130},
  ];
  const selected = members.find((member) => member.id === selectedId) ?? null;
  const inspector = selected === null ? null : (
    <SlideOver
      footer={selected.status === "active" ? (
        <Button danger icon="bi-person-dash" onClick={() => setDeactivating(selected)} outline size="sm" variant="secondary">
          Deactivate
        </Button>
      ) : null}
      fullscreen={fullscreen}
      onClose={() => selectRecord(null)}
      subtitle={selected.email}
      title={selected.displayName}
      titleMeta={statusPill(selected.status === "active" ? "Active" : "Inactive")}
      width={360}
    >
      <FieldGrid
        columns={1}
        fields={[
          {label: "Role", value: selected.role === "administrator" ? "Administrator" : "Member"},
          {label: "Admitted", mono: true, value: dateTimeOrDash(selected.admittedAt)},
          {label: "Admitted by", value: admittedLabel(selected)},
          {label: "Last active", mono: true, value: dateTimeOrDash(selected.lastActiveAt)},
        ]}
      />
    </SlideOver>
  );
  const activeCount = members.filter((member) => member.status === "active").length;

  return (
    <AdminConsole administrator area="members" inspector={inspector}>
      {error === null || admitOpen || deactivating !== null
        ? null
        : <RequestFailure error={error} onRetry={() => void load()} />}
      {loading && members.length === 0 ? (
        <SurfaceState loadingTitle="Loading members" noun="members" phase="loading" skeleton={3} />
      ) : (
        <RecordPanel
          actions={<AddRecordButton label="Admit member" onClick={() => setAdmitOpen(true)} />}
          capAlign="center"
          label="Members"
          metaWrap
          subtitle={`${members.length} members · ${activeCount} active`}
        >
          <DataGrid
            ariaLabel="Members"
            columns={columns}
            quickFilter
            rowActions={(row: MemberRow) => row.member.status === "active"
              ? [{danger: true, icon: "bi-person-dash", label: "Deactivate", onClick: () => setDeactivating(row.member)}]
              : null}
            rowActionsLabel={(row: MemberRow) => `Actions for ${row.name}`}
            rows={rows}
            selectable={false}
            statusBar={false}
          />
        </RecordPanel>
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
        subtitle="Admit one person to this installation. Every active member can open every project."
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
    </AdminConsole>
  );
}
