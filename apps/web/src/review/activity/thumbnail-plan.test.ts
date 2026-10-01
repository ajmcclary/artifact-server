import {describe, expect, it} from "vitest";

import type {ActivityEntry} from "@/api/client";

import {thumbnailPlan} from "./thumbnail-plan";

const anchor = {htmlAnchor: {point: {x: 0.5, y: 0.5}, selector: "#title", tagName: "H1"}, originalText: "Title"};
const entry = (over: {path?: string | null; anchor?: NonNullable<ActivityEntry["thread"]>["anchor"]; artifact?: null}): ActivityEntry => ({
  actor: {kind: "human", name: "Dana"}, artifact: over.artifact === null ? null : {archived: false, id: "art", name: "A"},
  at: "2026-09-30T10:00:00.000Z", id: "act", kind: "thread", project: {id: "prj", name: "P"}, verb: "commented", versionNumber: 1,
  thread: {anchor: "anchor" in over ? over.anchor : anchor, id: "thr", isResolved: false,
    opener: {author: {kind: "human", name: "Dana"}, body: "b", createdAt: "2026-09-30T10:00:00.000Z", id: "thr"},
    path: over.path === undefined ? "index.html" : over.path, replies: [], replyCount: 0, state: "needs_you", versionId: "ver"},
});

describe("thumbnailPlan", () => {
  it("ACT-005: an anchored HTML page renders in the review frame", () => {
    expect(thumbnailPlan(entry({}), null)).toEqual({kind: "frame", path: "index.html"});
    expect(thumbnailPlan(entry({path: null}), "docs/Index.HTM")).toEqual({kind: "frame", path: "docs/Index.HTM"});
  });

  it("ACT-005: a non-HTML entry, a missing or unreadable anchor, or a missing artifact shows the file tile", () => {
    expect(thumbnailPlan(entry({path: "report.pdf"}), null)).toEqual({kind: "tile", reason: "not-html"});
    expect(thumbnailPlan(entry({path: null}), "image.png")).toEqual({kind: "tile", reason: "not-html"});
    expect(thumbnailPlan(entry({anchor: null}), null)).toEqual({kind: "tile", reason: "no-anchor"});
    expect(thumbnailPlan(entry({anchor: {kind: "page"}}), null)).toEqual({kind: "tile", reason: "no-anchor"});
    expect(thumbnailPlan(entry({artifact: null}), null)).toEqual({kind: "tile", reason: "no-artifact"});
  });
});
