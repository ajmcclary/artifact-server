import {describe, expect, it} from "vitest";

import type {ActivityEntry} from "@/api/client";

import {appendPage, refreshFirstPage} from "./activity-pages";

const thread = (id: string, threadId: string, iso: string): ActivityEntry => ({
  actor: {kind: "human", name: "Dana"}, artifact: {archived: false, id: "art", name: "A"}, at: iso, id, kind: "thread",
  project: {id: "prj", name: "P"}, verb: "replied", versionNumber: 1,
  thread: {anchor: null, id: threadId, isResolved: false, opener: {author: {kind: "human", name: "Dana"}, body: "b", createdAt: iso, id: threadId},
    path: null, replies: [], replyCount: 0, state: "needs_you", versionId: "ver"},
});

describe("feed pages", () => {
  it("ACT-005: an older page never repeats a thread already shown nearer the top", () => {
    const first = [thread("act_2", "thr_a", "2026-09-30T10:00:00.000Z")];
    const older = [thread("act_1", "thr_a", "2026-09-29T10:00:00.000Z"), thread("act_0", "thr_b", "2026-09-28T10:00:00.000Z")];
    expect(appendPage(first, older).map((entry) => entry.id)).toEqual(["act_2", "act_0"]);
  });

  it("ACT-005: a refreshed first page replaces what it covers and keeps loaded older entries", () => {
    const loaded = [thread("act_2", "thr_a", "2026-09-30T10:00:00.000Z"), thread("act_0", "thr_b", "2026-09-28T10:00:00.000Z")];
    const first = [thread("act_3", "thr_b", "2026-10-01T09:00:00.000Z"), thread("act_2", "thr_a", "2026-09-30T10:00:00.000Z")];
    expect(refreshFirstPage(loaded, first).map((entry) => entry.id)).toEqual(["act_3", "act_2"]);
  });
});
