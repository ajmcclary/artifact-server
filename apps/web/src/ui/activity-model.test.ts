import {describe, expect, test} from "vitest";

import type {ActivityEvent} from "@/ui/review-ui";

import {dayKey, dayLabel, groupByDay, mergeBursts, sortEvents, usDate, usDateTime, usTime} from "./activity-model";

const at = (year: number, month: number, day: number, hour: number, minute: number): number =>
  new Date(year, month - 1, day, hour, minute).getTime();

function versionEvent(id: string, version: number, when: number, actor = "Claude"): ActivityEvent {
  return {
    actor, adminOnly: false, artifactId: "art_1", artifactName: "Stage bar", at: when, fromVersion: version - 1,
    id, needsYou: false, type: "version", verb: "published", version, withAgent: false,
  };
}

describe("vendored activity model", () => {
  test("prints US dates and a 12-hour clock in local time", () => {
    expect(usDate(at(2026, 4, 14, 15, 5))).toBe("04/14/2026");
    expect(usTime(at(2026, 4, 14, 15, 5))).toBe("3:05 PM");
    expect(usTime(at(2026, 4, 14, 0, 7))).toBe("12:07 AM");
    expect(usTime(at(2026, 4, 14, 12, 0))).toBe("12:00 PM");
    expect(usDateTime(at(2026, 4, 14, 9, 30))).toBe("04/14/2026 9:30 AM");
    expect(usDate(Number.NaN)).toBe("");
    expect(usDateTime(Number.NaN)).toBe("");
  });

  test("labels days as Today, Yesterday, then weekday and US date", () => {
    const now = at(2026, 4, 15, 10, 0);
    expect(dayLabel(dayKey(at(2026, 4, 15, 8, 0)), now)).toBe("Today");
    expect(dayLabel(dayKey(at(2026, 4, 14, 23, 59)), now)).toBe("Yesterday");
    expect(dayLabel(dayKey(at(2026, 4, 13, 9, 0)), now)).toBe("Mon 04/13/2026");
  });

  test("merges one publisher's consecutive versions and groups newest-first events by day", () => {
    const now = at(2026, 4, 15, 10, 0);
    const merged = mergeBursts([
      versionEvent("v7", 7, at(2026, 4, 15, 9, 0)),
      versionEvent("v6", 6, at(2026, 4, 15, 8, 0)),
      versionEvent("v5", 5, at(2026, 4, 14, 8, 0), "Dana Okonkwo"),
    ]);
    expect(merged.map((event) => [event.id, event.firstVersion, event.count])).toEqual([["v7", 6, 2], ["v5", 5, 1]]);
    expect(groupByDay(merged, now).map((group) => [group.label, group.events.length])).toEqual([["Today", 1], ["Yesterday", 1]]);
  });

  test("sorts newest first and puts unreadable times last", () => {
    const sorted = sortEvents([
      versionEvent("old", 1, at(2026, 4, 13, 8, 0)),
      versionEvent("undated", 2, Number.NaN),
      versionEvent("new", 3, at(2026, 4, 15, 8, 0)),
    ]);
    expect(sorted.map((event) => event.id)).toEqual(["new", "old", "undated"]);
  });
});
