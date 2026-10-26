import type {ActionAttribution} from "./action-attribution.js";
import type {AccessPolicy, StoredAccessPolicy} from "./access-policy.js";
import type {
  AccessGrant,
  ProjectAccess,
  ProjectAccessMode,
  ProjectRole,
} from "./permissions.js";

/** A grant as written by a caller; the store assigns timestamps and the revision. */
export type AccessGrantDraft = Omit<AccessGrant, "createdAt" | "revision" | "updatedAt">;

/** Persistence for installation policy, project access settings, and member grants. */
export interface AccessRepository {
  readonly deleteGrant: (command: {
    readonly attribution: ActionAttribution;
    readonly expectedRevision: number;
    readonly grantId: string;
    readonly installationId: string;
  }) => Promise<"conflict" | "deleted" | "missing">;
  readonly findSubjectGrants: (command: {
    readonly artifactId: string | null;
    readonly installationId: string;
    readonly memberId: string;
    readonly projectId: string;
  }) => Promise<{
    readonly artifactGrants: readonly AccessGrant[];
    readonly projectGrant: AccessGrant | null;
  }>;
  readonly listMemberGrants: (
    installationId: string,
    memberId: string,
  ) => Promise<readonly AccessGrant[]>;
  /** Project and artifact grants in one project. */
  readonly listProjectGrants: (
    installationId: string,
    projectId: string,
  ) => Promise<readonly AccessGrant[]>;
  readonly listProjectAccess: (installationId: string) => Promise<readonly ProjectAccess[]>;
  /** The stored policy, or the default policy at revision 0 when none was saved. */
  readonly readAccessPolicy: (installationId: string) => Promise<StoredAccessPolicy>;
  readonly readProjectAccess: (
    installationId: string,
    projectId: string,
  ) => Promise<ProjectAccess | null>;
  /** Create when expectedRevision is null; otherwise update that revision. */
  readonly upsertGrant: (command: {
    readonly attribution: ActionAttribution;
    readonly expectedRevision: number | null;
    readonly grant: AccessGrantDraft;
    readonly installationId: string;
  }) => Promise<AccessGrant | "conflict">;
  readonly writeAccessPolicy: (command: {
    readonly attribution: ActionAttribution;
    readonly expectedRevision: number;
    readonly installationId: string;
    readonly policy: AccessPolicy;
  }) => Promise<StoredAccessPolicy | "conflict">;
  readonly writeProjectAccess: (command: {
    readonly accessMode: ProjectAccessMode;
    readonly attribution: ActionAttribution;
    readonly defaultMemberRole: ProjectRole;
    readonly expectedRevision: number;
    readonly installationId: string;
    readonly projectId: string;
  }) => Promise<ProjectAccess | "conflict">;
}
