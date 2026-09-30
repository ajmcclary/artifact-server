import {api, type AccessSetting, type ArtifactDetails} from "@/api/client";

/** The artifact after an access change, and the sentence that explains it. */
export interface AccessChange {
  readonly artifact: ArtifactDetails["artifact"];
  readonly notice: string;
}

export const accessOptions = [
  {label: "Private", value: "account_required"},
  {label: "Public link", value: "public_link"},
] as const satisfies readonly {readonly label: string; readonly value: AccessSetting}[];

/** Change who can open the current version, against the current version the reviewer saw. */
export async function changeArtifactAccess(
  details: ArtifactDetails,
  next: AccessSetting,
): Promise<AccessChange> {
  const changed = await api.changeAccess(
    details.artifact.projectId,
    details.artifact.id,
    details.artifact.currentVersionId,
    next,
    crypto.randomUUID(),
  );
  return {
    artifact: changed.artifact,
    notice: changed.warning ?? (
      next === "public_link"
        ? "The current version can now be opened without signing in."
        : "This artifact now requires an admitted account."
    ),
  };
}

/** What changes for people who already have the link. */
export function accessChangeWarning(next: AccessSetting): string {
  return next === "public_link"
    ? "The link can be redistributed. Earlier versions and history stay account-required."
    : "Downloaded or externally cached copies cannot be recalled.";
}
