/**
 * The vendored activity model's pure helpers: US date formats, burst merging, entry grouping
 * and day grouping. Filtering, segments, people and paging belong to the server's activity API.
 */
export {
  dayKey,
  dayLabel,
  groupByArtifact,
  groupBursts,
  groupByDay,
  groupEntries,
  mergeBursts,
  sortEvents,
  usDate,
  usDateTime,
  usTime,
} from "@/arkcase/review-ui/activity-model.js";
export type {
  ActivityArtifactGroupOf,
  ActivityBurstOf,
  ActivityDayGroup,
  ActivityEntryOf,
} from "@/arkcase/review-ui/activity-model.js";
