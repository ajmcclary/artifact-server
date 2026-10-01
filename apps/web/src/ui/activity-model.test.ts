import {describe, expect, test} from "vitest";

import type {ActivityEvent} from "@/ui/review-ui";

import {
  type ActivityEntryOf,
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
} from "./activity-model";

const at = (year: number, month: number, day: number, hour: number, minute: number): number =>
  new Date(year, month - 1, day, hour, minute).getTime();

function versionEvent(id: string, version: number, when: number, actor = "Claude", artifact = "art_1", project = "prj_1"): ActivityEvent {
  return {
    actor, adminOnly: false, artifactId: artifact, artifactName: `Artifact ${artifact}`, at: when, fromVersion: version - 1,
    id, needsYou: false, projectId: project, projectName: `Project ${project}`, type: "version", verb: "published", version, withAgent: false,
  };
}

function accessEvent(id: string, when: number, actor = "Dana Okonkwo", artifact = "art_1"): ActivityEvent {
  return {
    actor, adminOnly: false, artifactId: artifact, artifactName: `Artifact ${artifact}`, at: when, from: "Account required",
    id, needsYou: false, projectId: "prj_1", projectName: "Project prj_1", to: "Public link", type: "access", verb: "changed access on", withAgent: false,
  };
}

function commentEvent(key: string, when: number, actor: string, artifact = "art_1", type: "comment" | "resolution" = "comment"): ActivityEvent {
  return {
    actor, adminOnly: false, artifactId: artifact, artifactName: `Artifact ${artifact}`, at: when, id: `${type}:${key}`,
    needsYou: type === "comment", projectId: "prj_1", projectName: "Project prj_1",
    thread: {author: actor, body: `Body ${key}`, isResolved: type === "resolution", key, replies: []},
    type, verb: type === "comment" ? "commented on" : "resolved a conversation on", withAgent: false,
  };
}

function agentEvent(id: string, when: number, artifact = "art_1"): ActivityEvent {
  return {
    actor: "Dana Okonkwo", adminOnly: false, agent: "Claude", artifactId: artifact, artifactName: `Artifact ${artifact}`, at: when,
    id, needsYou: false, projectId: "prj_1", projectName: "Project prj_1", state: "Delivered", type: "agent", verb: "sent conversations on", withAgent: true,
  };
}

const minute = 60 * 1000;
const kindOf = (entry: ActivityEntryOf<ActivityEvent>): string => "kind" in entry ? entry.kind : "event";

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

describe("vendored activity grouping", () => {
  const nine = at(2026, 4, 15, 9, 0);

  test("ACT-005: one actor's versions within 30 minutes collapse into a burst across artifacts and projects", () => {
    const entries = groupBursts([
      versionEvent("a", 4, nine, "Claude", "art_1", "prj_1"),
      versionEvent("b", 2, nine - 10 * minute, "Claude", "art_2", "prj_2"),
      // Exactly at the window's edge still belongs; one millisecond past it does not.
      versionEvent("c", 7, nine - 30 * minute, "Claude", "art_3", "prj_1"),
      versionEvent("d", 1, nine - 30 * minute - 1, "Claude", "art_4", "prj_1"),
    ]);
    expect(entries.map(kindOf)).toEqual(["burst", "event"]);
    const [burst] = entries;
    expect(burst !== undefined && "items" in burst ? [burst.id, burst.count, burst.at, burst.firstAt, burst.items.map((item) => item.id)] : null)
      .toEqual(["burst:a", 3, nine, nine - 30 * minute, ["a", "b", "c"]]);
    expect(burst !== undefined && "projects" in burst ? burst.projects : null).toEqual([
      {count: 2, id: "prj_1", name: "Project prj_1"},
      {count: 1, id: "prj_2", name: "Project prj_2"},
    ]);
  });

  test("ACT-005: another type or actor breaks a burst, a lone event stays itself, and flags carry over", () => {
    const flagged = {...accessEvent("x2", nine - 5 * minute, "Dana Okonkwo", "art_2"), needsYou: true};
    const entries = groupBursts([
      accessEvent("x1", nine), flagged,
      versionEvent("v1", 3, nine - 6 * minute, "Dana Okonkwo"),
      versionEvent("v2", 2, nine - 7 * minute, "Claude"),
      accessEvent("x3", nine - 8 * minute),
    ]);
    expect(entries.map((entry) => [kindOf(entry), entry.id])).toEqual([
      ["burst", "burst:x1"], ["event", "v1"], ["event", "v2"], ["event", "x3"],
    ]);
    const [burst] = entries;
    expect(burst === undefined ? null : [burst.needsYou, burst.withAgent]).toEqual([true, false]);
  });

  test("ACT-005: versions on two days never share a burst", () => {
    const midnight = at(2026, 4, 15, 0, 0);
    expect(groupBursts([versionEvent("a", 2, midnight + minute), versionEvent("b", 1, midnight - minute, "Claude", "art_2")]).map(kindOf))
      .toEqual(["event", "event"]);
  });

  test("ACT-005: a day's conversations on one artifact become one entry, its agent hand-off the footer", () => {
    const entries = groupByArtifact([
      commentEvent("t1", nine, "Dana Okonkwo"),
      versionEvent("v", 2, nine - minute, "Claude", "art_9"),
      agentEvent("g", nine - 2 * minute),
      commentEvent("t2", nine - 3 * minute, "R. Pham"),
      commentEvent("t1", nine - 4 * minute, "Rosa Santoro", "art_1", "resolution"),
      commentEvent("t3", nine - 5 * minute, "Dana Okonkwo"),
      agentEvent("lonely", nine - 6 * minute, "art_5"),
    ]);
    expect(entries.map((entry) => [kindOf(entry), entry.id])).toEqual([
      ["artifact", "artifact:art_1:2026-04-15"], ["event", "v"], ["event", "lonely"],
    ]);
    const [group] = entries;
    if (group === undefined || !("threads" in group)) throw new Error("The first entry is an artifact group.");
    // Actors newest first and once each; one thread per conversation; the hand-off is the footer.
    expect(group.actors).toEqual(["Dana Okonkwo", "R. Pham", "Rosa Santoro"]);
    expect(group.threads.map((thread) => thread.id)).toEqual(["comment:t1", "comment:t2", "comment:t3"]);
    expect(group.agent?.id).toBe("g");
    expect(group.events).toHaveLength(5);
    expect([group.at, group.needsYou, group.withAgent]).toEqual([nine, true, true]);
  });

  test("ACT-005: entries group bursts first, then each day's conversations by artifact", () => {
    const yesterday = at(2026, 4, 14, 16, 0);
    const entries = groupEntries([
      commentEvent("today", nine, "Dana Okonkwo"),
      versionEvent("a", 3, nine - minute, "Claude", "art_2"),
      versionEvent("b", 2, nine - 2 * minute, "Claude", "art_3"),
      commentEvent("yesterday", yesterday, "Dana Okonkwo"),
    ]);
    expect(entries.map((entry) => [kindOf(entry), entry.id])).toEqual([
      ["artifact", "artifact:art_1:2026-04-15"], ["burst", "burst:a"], ["artifact", "artifact:art_1:2026-04-14"],
    ]);
  });
});
