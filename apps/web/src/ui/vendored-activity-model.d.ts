/**
 * Types for the vendored, untyped activity model (scripts/sync-arkcase-ds.mjs copies
 * workspace/projects/arkcase-artifacts/activity-model.js without a declaration). Only the
 * functions the application calls are declared; their behaviour is pinned by
 * src/ui/activity-model.test.ts.
 */
declare module "@/arkcase/review-ui/activity-model.js" {
  import type {ActivityArtifactGroup, ActivityBurst, ActivityEvent} from "@/arkcase/review-ui/review-ui.jsx";

  export interface ActivityDayGroup<Event extends ActivityEvent = ActivityEvent> {
    readonly events: Event[];
    readonly key: string;
    readonly label: string;
  }

  /** A burst whose items are the host's own events (the model keeps the objects it was given). */
  export type ActivityBurstOf<Event extends ActivityEvent> = Omit<ActivityBurst, "items"> & {items: Event[]};
  /** An artifact's day of conversations, holding the host's own events. */
  export type ActivityArtifactGroupOf<Event extends ActivityEvent> = Omit<ActivityArtifactGroup, "agent" | "events" | "threads"> & {
    agent: Event | null;
    events: Event[];
    threads: Event[];
  };
  /** One feed entry built from the host's events. */
  export type ActivityEntryOf<Event extends ActivityEvent> = Event | ActivityBurstOf<Event> | ActivityArtifactGroupOf<Event>;

  export function usDate(ms: number): string;
  export function usTime(ms: number): string;
  export function usDateTime(ms: number): string;
  export function sortEvents<Event extends ActivityEvent>(events: readonly Event[]): Event[];
  /** Merged events keep every field of their newest member (the model spreads it). */
  export function mergeBursts<Event extends ActivityEvent>(events: readonly Event[]): Event[];
  /**
   * One actor's consecutive version or access events (newest first) on one day, each within
   * `windowMs` (default 30 minutes) of the newest, collapse into a burst; a run of one stays itself.
   */
  export function groupBursts<Event extends ActivityEvent>(
    events: readonly Event[],
    options?: {readonly windowMs?: number},
  ): (Event | ActivityBurstOf<Event>)[];
  /** One day's comment, resolution and agent events on an artifact with a conversation that day become one entry. */
  export function groupByArtifact<Event extends ActivityEvent>(dayEvents: readonly Event[]): (Event | ActivityArtifactGroupOf<Event>)[];
  /** `groupBursts`, then `groupByArtifact` for each day, newest first. */
  export function groupEntries<Event extends ActivityEvent>(
    events: readonly Event[],
    options?: {readonly windowMs?: number},
  ): ActivityEntryOf<Event>[];
  export function dayKey(ms: number): string;
  export function dayLabel(key: string, now: number): string;
  export function groupByDay<Event extends ActivityEvent>(events: readonly Event[], now: number): ActivityDayGroup<Event>[];
}
