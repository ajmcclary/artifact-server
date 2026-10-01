import {describe, expect, it} from "vitest";

import type {ActivityEntry} from "@/api/client";
import {dayKey, dayLabel, usDate, usDateTime, usTime} from "@/ui/activity-model";

import {type FeedEvent, feedEntries, feedGroups, mergedFeed, openTarget, thumbnailEntry, toFeedEvents} from "./activity-adapter";
import {appendPage} from "./activity-pages";

/** Type one API entry literal without asserting it. */
const entry = (fields: ActivityEntry): ActivityEntry => fields;
const localTime = (h: number, m: number): number => new Date(2026, 3, 4, h, m).getTime();
const at = (day: number, hour: number, minute = 0): string => new Date(2026, 8, day, hour, minute).toISOString();
const base = {
  actor: {kind: "human", name: "Dana Okonkwo"},
  artifact: {archived: false, id: "art_a", name: "Inspector study"},
  project: {id: "prj_a", name: "Claims"},
  versionNumber: 3,
} as const;
const comment = (id: string, author: string, createdAt: string, body: string) => ({author: {kind: "human" as const, name: author}, body, createdAt, id});
const threadEntry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ...base, at: at(30, 11, 20), id: "act_t1", kind: "thread", verb: "replied",
  thread: {anchor: null, id: "thr_1", isResolved: false, opener: comment("thr_1", "Dana Okonkwo", at(30, 10, 56), "First line.\nSecond line."),
    path: "index.html", replies: [comment("rep_1", "Claude", at(30, 11, 20), "Done.")], replyCount: 1, state: "needs_you", versionId: "ver_3"},
  ...over,
});
const version = (id: string, n: number, actor: string, iso: string, artifactId = "art_a"): ActivityEntry => ({
  ...base, actor: {kind: "service", name: actor}, artifact: {...base.artifact, id: artifactId}, at: iso, id, kind: "version", verb: "published", versionNumber: n,
});

function requiredThread(): NonNullable<ActivityEntry["thread"]> {
  const thread = threadEntry().thread;
  if (thread === undefined) throw new Error("The thread fixture carries a thread.");
  return thread;
}

describe("toFeedEvents", () => {
  it("ACT-005: maps one event per entry kind, newest first as the server ordered them", () => {
    const events = toFeedEvents([
      threadEntry(),
      entry({...base, at: at(30, 10), excerpt: "Agreed.", id: "act_r", kind: "resolution", thread: {...requiredThread(), id: "thr_2"}, threadId: "thr_2", verb: "resolved"}),
      version("act_v", 3, "Claude", at(30, 9)),
      entry({...base, agent: {dispatchState: "delivered", name: "Codex", threadIds: ["thr_1"]}, at: at(30, 8), id: "act_g", kind: "agent", verb: "sent"}),
      entry({...base, access: {from: "account_required", to: "public_link"}, at: at(30, 7), id: "act_a", kind: "access", verb: "enabled"}),
      entry({...base, artifact: null, at: at(30, 6), id: "act_m", kind: "admin", project: null, subject: {id: "mem_1", name: "Aaron Whitlock"}, verb: "admitted", versionNumber: null}),
      entry({...base, at: at(30, 5), id: "act_d", kind: "thread_deleted", threadId: "thr_3", verb: "deleted"}),
    ]);
    expect(events.map((event) => event.type)).toEqual(["comment", "resolution", "version", "agent", "access", "admin", "admin"]);
    expect(events.every((event, index) => index === 0 || event.at <= (events[index - 1]?.at ?? Number.POSITIVE_INFINITY))).toBe(true);
  });

  it("ACT-005: a replied thread is one event at its newest reply, by the replier, keyed by thread", () => {
    const [event] = toFeedEvents([threadEntry({actor: {kind: "service", name: "Claude"}})]);
    expect(event).toMatchObject({actor: "Claude", id: "comment:thr_1", type: "comment", verb: "replied on"});
    expect(event?.at).toBe(Date.parse(at(30, 11, 20)));
    expect(event?.thread).toMatchObject({author: "Dana Okonkwo", body: "First line.\nSecond line.", isResolved: false, key: "thr_1"});
    expect(event?.excerpt).toBe("First line.");
  });

  it("ACT-005: resolution, agent, access and admin events carry their own fields", () => {
    const [resolution, agent, access, admin, deleted] = toFeedEvents([
      entry({...base, at: at(30, 10), excerpt: "Agreed: stands down.", id: "act_r", kind: "resolution", thread: {...requiredThread(), id: "thr_2", isResolved: true, state: "resolved"},
        threadId: "thr_2", verb: "resolved"}),
      entry({...base, agent: {dispatchState: "delivered", name: "Codex", threadIds: ["thr_1"]}, artifact: {...base.artifact, archived: true}, at: at(30, 8), id: "act_g", kind: "agent", verb: "sent"}),
      entry({...base, access: {from: null, to: "public_link"}, at: at(30, 7), id: "act_a", kind: "access", verb: "enabled"}),
      entry({...base, artifact: null, at: at(30, 6), id: "act_k", kind: "admin", project: null, subject: {id: "key_1", name: "CI publisher"}, verb: "revoked", versionNumber: null}),
      entry({...base, at: at(30, 5), id: "act_d", kind: "thread_deleted", threadId: "thr_3", verb: "deleted"}),
    ]);
    expect([resolution?.verb, resolution?.excerpt, resolution?.needsYou]).toEqual(["resolved a conversation on", "Agreed: stands down.", false]);
    expect([agent?.agent, agent?.state, agent?.withAgent, agent?.archived]).toEqual(["Codex", "Delivered", true, true]);
    expect([access?.from, access?.to]).toEqual(["—", "Public link"]);
    expect([admin?.adminOnly, admin?.verb, admin?.detail, admin?.icon]).toEqual([true, "revoked the API key", "CI publisher", "bi-key"]);
    expect([deleted?.verb, deleted?.detail, deleted?.icon, deleted?.adminOnly]).toEqual(["deleted a conversation on", "Inspector study", "bi-trash", false]);
    // A resolution carries its conversation, so the feed draws it inside the conversation's card.
    expect(resolution?.thread).toMatchObject({isResolved: true, key: "thr_2", path: "index.html", version: 3});
  });

  it("ACT-005: a resolution whose conversation is gone stays a plain line rather than an empty card", () => {
    const [gone] = toFeedEvents([entry({...base, at: at(30, 10), excerpt: "Agreed.", id: "act_r", kind: "resolution", threadId: "thr_9", verb: "resolved"})]);
    expect(gone).toMatchObject({detail: "Inspector study", icon: "bi-check2-circle", type: "admin", verb: "resolved a conversation on"});
    expect(gone?.thread).toBeUndefined();
  });

  it("ACT-005: a thread's state decides Your turn and With an agent; resolved threads show neither", () => {
    const [needs, held, resolved] = toFeedEvents([
      threadEntry(),
      threadEntry({id: "act_t2", thread: {...requiredThread(), id: "thr_2", state: "with_agent"}}),
      threadEntry({id: "act_t3", thread: {...requiredThread(), id: "thr_3", isResolved: true, state: "resolved"}}),
    ]);
    expect([needs?.needsYou, needs?.withAgent]).toEqual([true, false]);
    expect([held?.needsYou, held?.withAgent]).toEqual([false, true]);
    expect([resolved?.needsYou, resolved?.withAgent]).toEqual([false, false]);
  });

  it("ACT-005: an unknown actor reads Unknown and an unreadable time sorts last", () => {
    const events = mergedFeed(toFeedEvents([
      entry({...version("act_x", 2, "Claude", "not a time"), actor: {kind: null, name: null}}),
      version("act_y", 1, "Claude", at(29, 9), "art_b"),
    ]));
    expect(events.map((event) => event.entry.id)).toEqual(["act_y", "act_x"]);
    expect(events[1]?.actor).toBe("Unknown");
    expect(Number.isNaN(events[1]?.at)).toBe(true);
  });

  it("ACT-005: comment and reply instants are carried for display in US format", () => {
    const [event] = toFeedEvents([threadEntry()]);
    expect(event?.thread?.at).toBe(at(30, 10, 56));
    expect(usDateTime(Date.parse(event?.thread?.replies[0]?.at ?? ""))).toBe("09/30/2026 11:20 AM");
    // The card's bylines read epoch instants: the clock alone on the entry's day.
    expect(event?.thread?.atMs).toBe(Date.parse(at(30, 10, 56)));
    expect(event?.thread?.replies[0]?.atMs).toBe(Date.parse(at(30, 11, 20)));
  });
});

describe("mergedFeed", () => {
  it("ACT-005: consecutive versions by one publisher on one artifact merge; anything between breaks the burst", () => {
    const merged = mergedFeed(toFeedEvents([
      version("v7", 7, "Claude", at(30, 7)), version("x", 2, "Claude", at(30, 6, 30), "art_b"), version("v6", 6, "Claude", at(30, 6)),
      version("v5", 5, "Claude", at(30, 5)), version("v4", 4, "Codex", at(30, 4)),
      threadEntry({at: at(30, 3, 30), id: "c"}), version("v3", 3, "Codex", at(30, 3)), version("v2", 2, "Codex", at(30, 2)),
    ]));
    const onA = merged.filter((event) => event.artifactId === "art_a");
    expect(onA.map((event) => [event.type, event.version, event.firstVersion, event.count])).toEqual([
      ["version", 7, 5, 3], ["version", 4, 4, 1], ["comment", 3, undefined, undefined], ["version", 3, 2, 2],
    ]);
    expect(mergedFeed([])).toEqual([]);
  });

  it("ACT-005: a burst split across a page boundary merges once the older page loads", () => {
    const first = [version("v9", 9, "Claude", at(30, 9)), version("v8", 8, "Claude", at(30, 8))];
    const second = [version("v7", 7, "Claude", at(30, 7))];
    expect(mergedFeed(toFeedEvents(first))).toHaveLength(1);
    const both = mergedFeed(toFeedEvents(appendPage(first, second)));
    expect(both.map((event) => [event.version, event.firstVersion, event.count])).toEqual([[9, 7, 3]]);
  });

  it("ACT-005: a locally inserted reply sorts above server events", () => {
    const local = threadEntry({at: new Date(2026, 9, 1, 8).toISOString(), id: "local:rep_9"});
    const events = mergedFeed(toFeedEvents([version("v1", 1, "Claude", at(30, 9)), local]));
    expect(events[0]?.entry.id).toBe("local:rep_9");
  });
});

describe("day groups and formats", () => {
  it("ACT-005: day groups label today, yesterday and older days; undated events close the list", () => {
    const now = new Date(2026, 8, 30, 15, 0).getTime();
    const groups = feedGroups(toFeedEvents([
      version("1", 4, "A", at(30, 9), "a1"), version("2", 3, "B", at(30, 8), "a2"), version("3", 2, "C", at(29, 23), "a3"),
      version("4", 1, "D", at(14, 10), "a4"), version("5", 1, "E", "", "a5"),
    ]), now);
    expect(groups.map((group) => [group.label, group.events.length])).toEqual([["Today", 2], ["Yesterday", 1], ["Mon 09/14/2026", 1], ["Undated", 1]]);
    expect(dayKey(new Date(2026, 8, 14, 10).getTime())).toBe("2026-09-14");
    expect(dayLabel("2026-04-14", now)).toBe("Tue 04/14/2026");
  });

  it("ACT-005: US formatters print full dates and a 12-hour clock", () => {
    expect(usDate(localTime(9, 5))).toBe("04/04/2026");
    expect(usTime(localTime(13, 10))).toBe("1:10 PM");
    expect(usTime(localTime(0, 5))).toBe("12:05 AM");
    expect(usTime(localTime(12, 0))).toBe("12:00 PM");
    expect(usDateTime(localTime(23, 59))).toBe("04/04/2026 11:59 PM");
    expect([usDate(Number.NaN), usTime(Number.NaN), usDateTime(Number.NaN)]).toEqual(["", "", ""]);
  });
});

const anchored = {htmlAnchor: {point: {x: 0.5, y: 0.5}, selector: "#title", tagName: "H1"}, originalText: "Title"};
const conversation = (id: string, hour: number, author: string, anchor: NonNullable<ActivityEntry["thread"]>["anchor"] = null): ActivityEntry => threadEntry({
  actor: {kind: "human", name: author}, at: at(30, hour), id: `act_${id}`, verb: "commented",
  thread: {...requiredThread(), anchor, id, opener: comment(id, author, at(30, hour), `Note ${id}`),
    replies: [], replyCount: 0, versionId: `ver_${id}`},
});
const byId = (events: readonly FeedEvent[]): Map<string, FeedEvent> => new Map(events.map((event) => [event.id, event]));

describe("feed entries", () => {
  it("ACT-005: one actor's versions across artifacts within 30 minutes become one burst whose items open one by one", () => {
    const events = mergedFeed(toFeedEvents([
      version("v_a", 4, "Claude", at(30, 9, 30), "art_a"), version("v_b", 2, "Claude", at(30, 9, 10), "art_b"),
      version("v_b1", 1, "Claude", at(30, 9, 5), "art_b"),
    ]));
    const entries = feedEntries(events);
    expect(entries.map((row) => row.id)).toEqual(["burst:version:v_a"]);
    const [burst] = entries;
    if (burst === undefined || !("items" in burst)) throw new Error("The versions form a burst.");
    // A merged span keeps its count inside the burst: one version on A, two on B.
    expect([burst.count, burst.items.map((item) => item.count)]).toEqual([3, [1, 2]]);
    expect(burst.items.map((item) => openTarget(item, byId(events))?.artifactId)).toEqual(["art_a", "art_b"]);
    // The burst itself opens its newest item.
    expect(openTarget(burst, byId(events))).toMatchObject({artifactId: "art_a", projectId: "prj_a", threadId: null});
  });

  it("ACT-005: an artifact's conversations that day form one card that opens its newest conversation", () => {
    const events = mergedFeed(toFeedEvents([conversation("thr_new", 11, "Rosa Santoro"), conversation("thr_old", 9, "Dana Okonkwo")]));
    const [card] = feedEntries(events);
    if (card === undefined || !("threads" in card)) throw new Error("The conversations form a card.");
    expect(card.actors).toEqual(["Rosa Santoro", "Dana Okonkwo"]);
    expect(openTarget(card, byId(events))).toEqual({artifactId: "art_a", path: "index.html", projectId: "prj_a", threadId: "thr_new", versionId: "ver_thr_new"});
  });

  it("ACT-005: a card's thumbnail draws its newest conversation with a pin, else its newest conversation", () => {
    const pinned = mergedFeed(toFeedEvents([conversation("thr_new", 11, "Rosa Santoro"), conversation("thr_pin", 9, "Dana Okonkwo", anchored)]));
    const [card] = feedEntries(pinned);
    if (card === undefined || !("threads" in card)) throw new Error("The conversations form a card.");
    expect(thumbnailEntry(card, byId(pinned))?.thread?.id).toBe("thr_pin");

    const unpinned = mergedFeed(toFeedEvents([conversation("thr_new", 11, "Rosa Santoro"), conversation("thr_old", 9, "Dana Okonkwo")]));
    const [plain] = feedEntries(unpinned);
    if (plain === undefined || !("threads" in plain)) throw new Error("The conversations form a card.");
    expect(thumbnailEntry(plain, byId(unpinned))?.thread?.id).toBe("thr_new");
  });

  it("ACT-005: an entry naming no artifact opens nothing", () => {
    const events = toFeedEvents([entry({...base, artifact: null, at: at(30, 6), id: "act_m", kind: "admin", project: null, verb: "admitted", versionNumber: null})]);
    const [admin] = events;
    expect(admin === undefined ? undefined : openTarget(admin, byId(events))).toBeNull();
  });
});
