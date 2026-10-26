import {useCallback, useEffect, useState} from "react";

import {
  api,
  ApiError,
  type AccessGrant,
  type ProjectAccessDetails,
} from "@/api/client";
import {Button, ConfirmDialog, Select, StatusPill} from "@/arkcase";
import {
  AdminActions,
  AdminNote,
  AdminPanel,
  AdminStack,
  IdentityCell,
  Ledger,
  RequestFailure,
  type LedgerColumn,
} from "./admin-parts.tsx";
import {AccessExplainer} from "./access-explainer.tsx";
import {PermissionOverridePopover} from "./permission-override-popover.tsx";
import {
  type Permission,
  projectRoleOrder,
  type ProjectRole,
  restrictConfirmation,
  roleLabel,
} from "./project-access-model.ts";

export interface ProjectAccessPanelProps {
  readonly projectId: string;
  readonly projectName: string;
}

type AccessMember = ProjectAccessDetails["members"][number];

const modeOptions = [
  {label: "Open to all members", value: "open"},
  {label: "Restricted to people listed", value: "restricted"},
];
const roleOptions = projectRoleOrder.map((role) => ({label: roleLabel(role), value: role}));

const isRole = (value: string): value is ProjectRole =>
  projectRoleOrder.some((role) => role === value);

/** One project's access mode, default member role, and per-member grants. */
export function ProjectAccessPanel({projectId, projectName}: ProjectAccessPanelProps) {
  const [details, setDetails] = useState<ProjectAccessDetails | null>(null);
  const [actor, setActor] = useState<ReadonlySet<Permission>>(new Set());
  const [ceiling, setCeiling] = useState<readonly Permission[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<"open" | "restricted">("open");
  const [defaultRole, setDefaultRole] = useState<ProjectRole>("editor");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [customizing, setCustomizing] = useState<AccessMember | null>(null);

  const load = useCallback(async () => {
    try {
      const [read, mine] = await Promise.all([
        api.projectAccess(projectId),
        api.effectiveAccess(projectId, null),
      ]);
      setDetails(read);
      setActor(new Set(mine.permissions));
      setMode(read.access.accessMode);
      setDefaultRole(read.access.defaultMemberRole);
      setHidden(false);
      // Only administrators can read the policy; the server enforces it for everyone else.
      setCeiling(await api.accessPolicy().then((stored) => stored.policy.members.memberCeiling, () => null));
    } catch (failure: unknown) {
      if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) {
        setHidden(true);
        return;
      }
      setError(failure instanceof Error ? failure : new Error(String(failure)));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async <Result,>(operation: () => Promise<Result>) => {
    setPending(true);
    setError(null);
    try {
      await operation();
      await load();
    } catch (failure: unknown) {
      if (failure instanceof ApiError && failure.code === "ACCESS_CHANGE_UNCONFIRMED" && failure.details !== null) {
        setConfirming(failure.details.membersLosingAccess);
        return;
      }
      setError(failure instanceof Error ? failure : new Error(String(failure)));
    } finally {
      setPending(false);
    }
  };

  if (hidden) return null;
  if (details === null) {
    return error === null ? null : <RequestFailure error={error} onRetry={() => void load()} />;
  }

  const saveAccess = (confirm: number | null) => run(() => api.changeProjectAccess(projectId, {
    accessMode: mode,
    confirmMembersLosingAccess: confirm,
    defaultMemberRole: defaultRole,
    expectedRevision: details.access.revision,
  }));

  const grantFor = (memberId: string): AccessGrant | null =>
    details.grants.find((grant) => grant.memberId === memberId && grant.artifactId === null) ?? null;

  const setRole = (member: AccessMember, role: ProjectRole) => {
    const current = grantFor(member.memberId);
    void run(() => api.putGrant(projectId, null, member.memberId, {
      add: current?.add ?? [],
      expectedRevision: current?.revision ?? null,
      expiresAt: current?.expiresAt ?? null,
      remove: current?.remove ?? [],
      role,
    }));
  };

  const columns: readonly LedgerColumn<AccessMember>[] = [
    {
      align: "left",
      cell: (member) => ({value: <IdentityCell detail={member.email} primary={member.displayName} />}),
      key: "member",
      kind: "field",
      label: "Member",
      width: "minmax(0, 1fr)",
    },
    {
      align: "left",
      cell: (member) => {
        if (member.effectiveRole === "administrator") return {value: "Manager (administrator)"};
        return {
          value: (
            <Select
              aria-label={`${member.displayName}'s role`}
              disabled={pending || !actor.has("project.manage")}
              onChange={(event) => {
                const role = event.currentTarget.value;
                if (isRole(role)) setRole(member, role);
              }}
              options={roleOptions}
              size="sm"
              value={member.effectiveRole}
            />
          ),
        };
      },
      key: "role",
      kind: "field",
      label: "Role",
      width: "200px",
    },
    {
      align: "right",
      cell: (member) => {
        if (member.effectiveRole === "administrator") return {value: null};
        const grant = grantFor(member.memberId);
        return {
          value: (
            <AdminActions>
              <Button disabled={pending} onClick={() => setCustomizing(member)} outline size="sm" variant="secondary">
                Customize
              </Button>
              {grant === null ? null : (
                <Button
                  disabled={pending}
                  onClick={() => void run(() => api.deleteGrant(projectId, null, member.memberId, grant.revision))}
                  size="sm"
                  variant="link"
                >
                  Use default
                </Button>
              )}
            </AdminActions>
          ),
        };
      },
      key: "actions",
      kind: "action",
      label: "Actions",
      width: "220px",
    },
  ];

  const customGrant = customizing === null ? null : grantFor(customizing.memberId);
  const customRole: ProjectRole = customGrant?.role ??
    (customizing === null || customizing.effectiveRole === "administrator" ? "viewer" : customizing.effectiveRole);

  return (
    <AdminPanel
      actions={<StatusPill label={details.access.accessMode === "open" ? "Open" : "Restricted"} tone="neutral" />}
      label="Access"
      padded={false}
      subtitle="Who can open and change this project"
    >
      <AdminStack>
        {error === null ? null : <RequestFailure error={error} />}
        <Select
          disabled={pending}
          label="Who can open this project"
          onChange={(event) => setMode(event.currentTarget.value === "restricted" ? "restricted" : "open")}
          options={modeOptions}
          size="sm"
          value={mode}
        />
        {mode === "open" ? (
          <Select
            disabled={pending}
            label="Role for every member"
            onChange={(event) => {
              const role = event.currentTarget.value;
              if (isRole(role)) setDefaultRole(role);
            }}
            options={roleOptions}
            size="sm"
            value={defaultRole}
          />
        ) : (
          <AdminNote>Only the people listed with a role, and administrators, can open this project.</AdminNote>
        )}
        <AdminActions>
          <Button
            disabled={pending || (mode === details.access.accessMode && defaultRole === details.access.defaultMemberRole)}
            icon="bi-save"
            onClick={() => void saveAccess(null)}
            size="sm"
          >
            {pending ? "Saving…" : "Save access"}
          </Button>
        </AdminActions>
      </AdminStack>
      <Ledger ariaLabel="Project members" columns={columns} rowKey={(member) => member.memberId} rows={details.members} />
      <AccessExplainer artifactId={null} members={details.members} projectId={projectId} projectName={projectName} />
      <ConfirmDialog
        confirmLabel="Restrict project"
        message={confirming === null ? null : restrictConfirmation(confirming)}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          const count = confirming;
          setConfirming(null);
          void saveAccess(count);
        }}
        open={confirming !== null}
        title="Change who can open this project?"
        tone="danger"
      />
      {customizing === null ? null : (
        <PermissionOverridePopover
          actorPermissions={actor}
          add={customGrant?.add ?? []}
          ceiling={ceiling}
          memberName={customizing.displayName}
          onClose={() => setCustomizing(null)}
          onSave={(add, remove) => {
            const member = customizing;
            void run(() => api.putGrant(projectId, null, member.memberId, {
              add,
              expectedRevision: customGrant?.revision ?? null,
              expiresAt: customGrant?.expiresAt ?? null,
              remove,
              role: customRole,
            })).then(() => setCustomizing(null));
          }}
          open
          pending={pending}
          remove={customGrant?.remove ?? []}
          role={customRole}
        />
      )}
    </AdminPanel>
  );
}
