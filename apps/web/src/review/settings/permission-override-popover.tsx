import {useEffect, useState} from "react";

import {Checkbox, Modal} from "@/arkcase";
import {AdminNote, AdminStack} from "./admin-parts.tsx";
import {
  overrideRows,
  type OverrideState,
  type Permission,
  type ProjectRole,
  roleLabel,
} from "./project-access-model.ts";

export interface PermissionOverridePopoverProps {
  readonly actorPermissions: ReadonlySet<Permission>;
  readonly add: readonly Permission[];
  /** The installation's member ceiling, when the editor can read it. */
  readonly ceiling: readonly Permission[] | null;
  readonly memberName: string;
  readonly onClose: () => void;
  readonly onSave: (add: readonly Permission[], remove: readonly Permission[]) => void;
  readonly open: boolean;
  readonly pending: boolean;
  readonly remove: readonly Permission[];
  readonly role: ProjectRole;
}

const stateNotes = {
  added: "Added to the role",
  blocked_by_policy: "Blocked by installation policy",
  from_role: "From the role",
  off: "Not granted",
  removed: "Removed from the role",
} as const satisfies Readonly<Record<OverrideState, string>>;

/** Add or remove single permissions on one member's grant. */
export function PermissionOverridePopover({
  actorPermissions,
  add,
  ceiling,
  memberName,
  onClose,
  onSave,
  open,
  pending,
  remove,
  role,
}: PermissionOverridePopoverProps) {
  const [added, setAdded] = useState<readonly Permission[]>(add);
  const [removed, setRemoved] = useState<readonly Permission[]>(remove);

  useEffect(() => {
    setAdded(add);
    setRemoved(remove);
  }, [add, remove, open]);

  const rows = overrideRows(role, added, removed, actorPermissions, ceiling);
  const toggle = (permission: Permission, state: OverrideState) => {
    if (state === "from_role") setRemoved([...removed, permission]);
    else if (state === "removed") setRemoved(removed.filter((candidate) => candidate !== permission));
    else if (state === "off") setAdded([...added, permission]);
    else if (state === "added") setAdded(added.filter((candidate) => candidate !== permission));
  };

  return (
    <Modal
      icon="bi-sliders"
      inertSiblings
      onClose={onClose}
      open={open}
      portal
      primaryAction={{
        disabled: pending,
        label: pending ? "Saving…" : "Save permissions",
        onClick: () => onSave(added, removed),
      }}
      size="sm"
      subtitle={`${roleLabel(role)}, with single permissions added or removed.`}
      title={`Customize ${memberName}`}
    >
      <AdminStack>
        {rows.map((row) => (
          <Checkbox
            checked={row.state === "from_role" || row.state === "added"}
            description={row.disabledReason ?? stateNotes[row.state]}
            disabled={pending || row.disabledReason !== null}
            key={row.permission}
            label={row.label}
            onChange={() => toggle(row.permission, row.state)}
          />
        ))}
        <AdminNote>You can only grant permissions you hold on this project yourself.</AdminNote>
      </AdminStack>
    </Modal>
  );
}
