import type {AccessSetting, AgentDispatchState} from "../core/model.js";
import type {PrincipalKind} from "../core/identity.js";
import type {
  ActivityRow,
  ActivityThreadState,
} from "../core/ports.js";

/** Feed entry kinds the web renders. */
export type ActivityEntryKind =
  | "access"
  | "admin"
  | "agent"
  | "resolution"
  | "thread"
  | "thread_deleted"
  | "version";

/** One comment or reply as the feed shows it. */
export interface WireComment {
  readonly author: {readonly kind: PrincipalKind; readonly name: string};
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
}

/** One feed entry on the wire. Optional fields appear only for their kinds. */
export interface ActivityEntry {
  readonly access?: {readonly from: AccessSetting | null; readonly to: AccessSetting};
  readonly actor: {readonly kind: PrincipalKind | null; readonly name: string | null};
  readonly agent?: {
    readonly dispatchState: AgentDispatchState;
    readonly name: string;
    readonly threadIds: readonly string[];
  };
  readonly artifact: {
    readonly archived: boolean;
    readonly id: string;
    readonly name: string;
  } | null;
  readonly at: string;
  readonly excerpt?: string;
  readonly id: string;
  readonly kind: ActivityEntryKind;
  readonly project: {readonly id: string; readonly name: string} | null;
  readonly subject?: {readonly id: string; readonly name: string | null};
  readonly thread?: {
    readonly anchor: unknown;
    readonly id: string;
    readonly isResolved: boolean;
    readonly opener: WireComment;
    readonly replies: readonly WireComment[];
    readonly replyCount: number;
    readonly state: ActivityThreadState;
  };
  readonly threadId?: string;
  readonly verb: string;
  readonly versionNumber: number | null;
}

/** Display names for member and key subjects, by ID. */
export interface SubjectNames {
  readonly keys: ReadonlyMap<string, string>;
  readonly members: ReadonlyMap<string, string>;
}

const verbs = {
  comment_create: ["thread", "commented"],
  comment_delete: ["thread_deleted", "deleted"],
  comment_reopen: ["resolution", "reopened"],
  comment_reply: ["thread", "replied"],
  comment_resolve: ["resolution", "resolved"],
  dispatch_addressed: ["agent", "answered"],
  dispatch_create: ["agent", "sent"],
  key_issue: ["admin", "issued"],
  key_revoke: ["admin", "revoked"],
  key_rotate: ["admin", "rotated"],
  member_admit: ["admin", "admitted"],
  member_deactivate: ["admin", "deactivated"],
  project_archive: ["admin", "archived"],
  project_create: ["admin", "created"],
  project_unarchive: ["admin", "unarchived"],
  public_link_disable: ["access", "disabled"],
  public_link_enable: ["access", "enabled"],
  publish: ["version", "published"],
  restore: ["version", "restored"],
} as const satisfies Record<string, readonly [ActivityEntryKind, string]>;

type FeedKind = keyof typeof verbs;

const isFeedKind = (action: string): action is FeedKind =>
  Object.hasOwn(verbs, action);

function wireComment(comment: {
  readonly author: {readonly displayName: string; readonly principalKind: PrincipalKind};
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
}): WireComment {
  return {
    author: {kind: comment.author.principalKind, name: comment.author.displayName},
    body: comment.body,
    createdAt: comment.createdAt,
    id: comment.id,
  };
}

function subjectOf(
  row: ActivityRow,
  names: SubjectNames,
): {readonly id: string; readonly name: string | null} | undefined {
  const {action, subjectId} = row.action;
  if (action.startsWith("project_")) {
    return row.project === null
      ? undefined
      : {id: row.project.id, name: row.project.name};
  }
  if (subjectId === null) return undefined;
  if (action.startsWith("member_")) {
    return {id: subjectId, name: names.members.get(subjectId) ?? null};
  }
  if (action.startsWith("key_")) {
    return {id: subjectId, name: names.keys.get(subjectId) ?? null};
  }
  return undefined;
}

/** Map one read-model row to its wire entry, or null for a non-feed kind. */
export function toActivityEntry(
  row: ActivityRow,
  names: SubjectNames,
): ActivityEntry | null {
  const {action} = row.action;
  if (!isFeedKind(action)) return null;
  const [kind, verb] = verbs[action];
  const base = {
    actor: {
      kind: row.action.actor?.kind ?? null,
      name: row.action.actor?.displayName ?? null,
    },
    artifact: row.artifact,
    at: row.action.createdAt,
    id: row.action.id,
    kind,
    project: row.project,
    verb,
    versionNumber: row.versionNumber,
  };
  switch (kind) {
    case "thread":
      return row.thread === null
        ? null
        : {
          ...base,
          thread: {
            anchor: row.thread.anchor,
            id: row.thread.id,
            isResolved: row.thread.isResolved,
            opener: wireComment(row.thread.opener),
            replies: row.thread.replies.map(wireComment),
            replyCount: row.thread.replyCount,
            state: row.thread.state,
          },
        };
    case "resolution":
    case "thread_deleted": {
      const threadId = row.action.threadId;
      const withThread = threadId === null ? base : {...base, threadId};
      return row.excerpt === null ? withThread : {...withThread, excerpt: row.excerpt};
    }
    case "agent":
      return row.dispatch === null
        ? base
        : {
          ...base,
          agent: {
            dispatchState: row.dispatch.state,
            name: row.dispatch.agentDisplayName,
            threadIds: row.dispatch.threadIds,
          },
        };
    case "access":
      return {
        ...base,
        access: {
          from: row.action.accessFrom,
          to: row.action.accessTo ??
            (action === "public_link_enable" ? "public_link" : "account_required"),
        },
      };
    case "admin": {
      const subject = subjectOf(row, names);
      return subject === undefined ? base : {...base, subject};
    }
    case "version":
      return base;
  }
  return base;
}
