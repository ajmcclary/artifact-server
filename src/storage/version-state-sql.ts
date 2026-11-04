import {
  acceptedVersionStates,
  type VersionListFilter,
  versionStates,
} from "../core/model.js";

// Every value comes from a closed constant set, so quoting needs no escaping.
const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(", ");

/** Every persisted version state, as a SQL list for CHECK constraints. */
export const versionStateSqlList = sqlList(Object.values(versionStates));

/** Accepted-history states (mainline, promoted), as a SQL list. */
export const acceptedVersionStateSqlList = sqlList(acceptedVersionStates);

/**
 * A portable predicate over a `versions` row selecting one listing filter.
 * `accepted` is the default history view; `candidates` is the open review
 * queue; `all` also shows rejected and superseded candidates (CND-005).
 */
export function versionListFilterSql(filter: VersionListFilter, alias: string | null = null): string {
  const column = alias === null ? "state" : `${alias}.state`;
  const predicates = {
    accepted: `${column} IN (${acceptedVersionStateSqlList})`,
    all: "1 = 1",
    candidates: `${column} = '${versionStates.candidate}'`,
  } as const satisfies Record<VersionListFilter, string>;
  return predicates[filter];
}

/** Predicate that keeps only accepted-history versions under an alias. */
export function acceptedVersionSql(alias: string): string {
  return versionListFilterSql("accepted", alias);
}
