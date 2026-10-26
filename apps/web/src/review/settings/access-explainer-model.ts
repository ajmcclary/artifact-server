import type {AccessSource, EffectiveAccess} from "@/api/client";
import {type Permission, permissionLabel, roleLabel} from "./project-access-model.ts";

/** What one explanation is about. */
export interface ExplanationInput {
  readonly access: Pick<EffectiveAccess, "permissions" | "sources">;
  readonly permission: Permission;
  readonly projectName: string;
  readonly subjectName: string;
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

function grantingReason(source: AccessSource, projectName: string): string | null {
  switch (source.layer) {
    case "administrator":
      return "an administrator manages every project";
    case "project_default":
      return `${roleLabel(source.role)} for every member of ${projectName}`;
    case "project_grant":
      return `${roleLabel(source.role)} on ${projectName}`;
    case "artifact_grant":
      return `${roleLabel(source.role)} on this artifact`;
    case "share_link":
      return "a share link";
    case "policy":
    case "state":
      return null;
  }
  return null;
}

function removingReason(source: AccessSource, input: ExplanationInput): string | null {
  if (source.layer === "policy" && source.removed.includes(input.permission)) {
    return "blocked by installation policy";
  }
  if (source.layer === "state" && source.removed.includes(input.permission)) {
    return source.reason === "archived" ? `${input.projectName} is archived` : "the artifact was deleted";
  }
  if ((source.layer === "project_grant" || source.layer === "artifact_grant") && source.removed.includes(input.permission)) {
    return `removed from ${input.subjectName}'s grant`;
  }
  return null;
}

/** One plain sentence saying whether a person holds a permission, and the layer that decided it. */
export function explainSentence(input: ExplanationInput): string {
  const action = lowerFirst(permissionLabel(input.permission));
  if (input.access.permissions.includes(input.permission)) {
    const reason = input.access.sources
      .map((source) => grantingReason(source, input.projectName))
      .find((candidate) => candidate !== null) ?? "their access";
    return `${input.subjectName} can ${action}: ${reason}.`;
  }
  const reason = input.access.sources
    .map((source) => removingReason(source, input))
    .find((candidate) => candidate !== null) ?? "no role or grant gives it";
  return `${input.subjectName} cannot ${action}: ${reason}.`;
}
