import type {PublicationReceipt} from "./publication-record.js";

export type GroupPreflightStatus = "changed" | "unchanged" | "unregistered" | "conflicted" | "resumable" | "blocked";
export type GroupMemberStatus = "published" | "unchanged" | "recovered" | "failed" | "skipped" | "running";
export interface GroupPreflightMember {
  readonly target: string;
  readonly source: string | null;
  readonly status: GroupPreflightStatus;
  readonly allowed: boolean;
  readonly message: string;
  readonly artifactId: string | null;
  readonly versionId: string | null;
}
export interface GroupMemberResult {
  readonly target: string;
  readonly source: string;
  readonly status: GroupMemberStatus;
  readonly receipt: (PublicationReceipt & {readonly unchanged: boolean}) | null;
  readonly error: string | null;
}
export interface GroupRunResult {
  readonly schemaVersion: 1;
  readonly group: string;
  readonly config: string | null;
  readonly mode: "dry-run" | "publish";
  readonly status: "blocked" | "ready" | "running" | "completed" | "failed";
  readonly destination: {
    readonly profile: string | null;
    readonly origin: string;
    readonly installationId: string;
    readonly principalId: string;
    readonly projectId: string;
  } | null;
  readonly preflight: readonly GroupPreflightMember[];
  readonly results: readonly GroupMemberResult[];
  readonly summary: {readonly published: number; readonly unchanged: number; readonly recovered: number; readonly failed: number; readonly skipped: number};
  readonly runId: string | null;
  readonly reportPath: string | null;
  readonly error: string | null;
}
export interface GroupProgress {
  readonly target: string;
  readonly status: GroupMemberStatus;
  readonly message: string;
  readonly reportPath: string;
}
export function groupSummary(results: readonly GroupMemberResult[]): GroupRunResult["summary"] {
  return {
    published: results.filter((row) => row.status === "published").length,
    unchanged: results.filter((row) => row.status === "unchanged").length,
    recovered: results.filter((row) => row.status === "recovered").length,
    failed: results.filter((row) => row.status === "failed").length,
    skipped: results.filter((row) => row.status === "skipped").length,
  };
}
