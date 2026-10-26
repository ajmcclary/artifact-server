import {Schema} from "effect";

import {
  allPermissions,
  guestHoldablePermissions,
  projectAccessModes,
  type Permission,
  type ProjectAccessMode,
} from "./permissions.js";

/** Installation-wide ceilings that no project, grant, or share link can exceed. */
export interface AccessPolicy {
  readonly members: {
    /** Null means no ceiling. */
    readonly memberCeiling: readonly Permission[] | null;
  };
  readonly projects: {
    readonly defaultMode: ProjectAccessMode;
  };
  readonly shareLinks: {
    readonly enabled: boolean;
    readonly guestPermissionsMax: readonly Permission[];
    /** Who may create share links: holders of artifact.share, or administrators only. */
    readonly linkCreators: "sharers" | "administrators";
    readonly maxExpiryDays: number | null;
  };
}

/** The policy every installation has until an administrator changes it. */
export const defaultAccessPolicy: AccessPolicy = {
  members: {memberCeiling: null},
  projects: {defaultMode: projectAccessModes.open},
  shareLinks: {
    enabled: true,
    guestPermissionsMax: [...guestHoldablePermissions],
    linkCreators: "sharers",
    maxExpiryDays: null,
  },
};

const permissionSchema = Schema.Literals(allPermissions);

/** Wire and storage schema for one access policy document. */
export const accessPolicySchema = Schema.Struct({
  members: Schema.Struct({
    memberCeiling: Schema.NullOr(Schema.Array(permissionSchema)),
  }),
  projects: Schema.Struct({
    defaultMode: Schema.Literals(Object.values(projectAccessModes)),
  }),
  shareLinks: Schema.Struct({
    enabled: Schema.Boolean,
    guestPermissionsMax: Schema.Array(permissionSchema),
    linkCreators: Schema.Literals(["sharers", "administrators"]),
    maxExpiryDays: Schema.NullOr(Schema.Int.check(Schema.isBetween({maximum: 3_650, minimum: 1}))),
  }),
});

/** Decode options for untrusted policy documents: unknown keys are refused. */
export const accessPolicyParseOptions = {errors: "all", onExcessProperty: "error"} as const;

/** A policy as stored, with its optimistic-concurrency revision. */
export interface StoredAccessPolicy {
  readonly policy: AccessPolicy;
  /** Zero when the installation has never saved a policy. */
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly updatedByPrincipalId: string | null;
}
