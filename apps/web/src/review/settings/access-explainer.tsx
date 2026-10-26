import {useEffect, useState} from "react";

import {api, type EffectiveAccess} from "@/api/client";
import {Select} from "@/arkcase";
import {AdminNote, AdminStack} from "./admin-parts.tsx";
import {explainSentence} from "./access-explainer-model.ts";
import {type Permission, permissionLabel, permissionOrder} from "./project-access-model.ts";

export interface AccessExplainerProps {
  readonly artifactId: string | null;
  readonly members: readonly {readonly displayName: string; readonly memberId: string}[];
  readonly projectId: string;
  readonly projectName: string;
}

const isPermission = (value: string): value is Permission =>
  permissionOrder.some((permission) => permission === value);

/** "Why can they?": pick a person and an action, read the layer that decides it. */
export function AccessExplainer({artifactId, members, projectId, projectName}: AccessExplainerProps) {
  const [memberId, setMemberId] = useState(members[0]?.memberId ?? "");
  const [permission, setPermission] = useState<Permission>("comment.write");
  const [access, setAccess] = useState<EffectiveAccess | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (memberId === "") return undefined;
    let current = true;
    setFailed(false);
    const load = async () => {
      try {
        const loaded = await api.effectiveAccess(projectId, artifactId, memberId);
        if (current) setAccess(loaded);
      } catch {
        if (current) setFailed(true);
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [artifactId, memberId, projectId]);

  return (
    <AdminStack>
      <Select
        label="Why can"
        onChange={(event) => setMemberId(event.currentTarget.value)}
        options={members.map((member) => ({label: member.displayName, value: member.memberId}))}
        size="sm"
        value={memberId}
      />
      <Select
        label="Action"
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (isPermission(value)) setPermission(value);
        }}
        options={permissionOrder.map((candidate) => ({label: permissionLabel(candidate), value: candidate}))}
        size="sm"
        value={permission}
      />
      <AdminNote>
        {failed
          ? "This explanation could not be loaded."
          : access === null
          ? "Loading…"
          : explainSentence({access, permission, projectName, subjectName: access.subject.displayName})}
      </AdminNote>
    </AdminStack>
  );
}
