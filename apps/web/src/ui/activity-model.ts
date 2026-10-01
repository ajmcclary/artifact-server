/**
 * The vendored activity model's pure helpers: US date formats, burst merging and day
 * grouping. Filtering, segments and paging belong to the server's activity API.
 */
export {
  dayKey,
  dayLabel,
  groupByDay,
  mergeBursts,
  sortEvents,
  usDate,
  usDateTime,
  usTime,
} from "@/arkcase/review-ui/activity-model.js";
export type {ActivityDayGroup} from "@/arkcase/review-ui/activity-model.js";
