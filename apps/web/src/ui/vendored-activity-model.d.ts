/**
 * Types for the vendored, untyped activity model (scripts/sync-arkcase-ds.mjs copies
 * workspace/projects/arkcase-artifacts/activity-model.js without a declaration). Only the
 * functions the application calls are declared; their behaviour is pinned by
 * src/ui/activity-model.test.ts.
 */
declare module "@/arkcase/review-ui/activity-model.js" {
  import type {ActivityEvent} from "@/arkcase/review-ui/review-ui.jsx";

  export interface ActivityDayGroup<Event extends ActivityEvent = ActivityEvent> {
    readonly events: Event[];
    readonly key: string;
    readonly label: string;
  }

  export function usDate(ms: number): string;
  export function usTime(ms: number): string;
  export function usDateTime(ms: number): string;
  export function sortEvents<Event extends ActivityEvent>(events: readonly Event[]): Event[];
  /** Merged events keep every field of their newest member (the model spreads it). */
  export function mergeBursts<Event extends ActivityEvent>(events: readonly Event[]): Event[];
  export function dayKey(ms: number): string;
  export function dayLabel(key: string, now: number): string;
  export function groupByDay<Event extends ActivityEvent>(events: readonly Event[], now: number): ActivityDayGroup<Event>[];
}
