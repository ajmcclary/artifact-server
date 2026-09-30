import type {AgentDispatch, AgentDispatchState, ArtifactPage, Project} from "@/api/client";
import {describe, expect, test} from "vitest";

import {
  describeQueueEntry,
  dispatchesByArtifact,
  filterQueue,
  groupQueue,
  isActiveDispatch,
  queueCounts,
  queueKey,
  type QueueArtifact,
} from "./queue-model";

function project(id: string, name: string, archivedAt: string | null = null): Project {
  return {
    archivedAt,
    createdAt: "2026-09-01T09:00:00.000Z",
    id,
    installationId: "ins_local",
    name,
  };
}

function catalogEntry(
  projectId: string,
  id: string,
  name: string,
  commentCount: number,
): QueueArtifact {
  return {
    artifact: {
      accessSetting: "account_required",
      createdAt: "2026-09-02T10:00:00.000Z",
      currentVersionId: `ver_${id}`,
      deletedAt: null,
      id,
      name,
      projectId,
      tags: [],
    },
    commentCount,
    links: {
      artifact: `http://127.0.0.1:8787/api/v1/artifacts/${id}?projectId=${projectId}`,
      management: `http://127.0.0.1:8787/review?project=${projectId}&artifact=${id}`,
    },
    versionCount: 2,
  };
}

function catalogPage(entries: readonly QueueArtifact[]): ArtifactPage {
  return {artifacts: entries, nextCursor: null};
}

function send(
  id: string,
  projectId: string,
  state: AgentDispatchState,
  threadIds: readonly string[],
  updatedAt: string,
): AgentDispatch {
  return {
    addressedAt: state === "addressed" ? updatedAt : null,
    agentDisplayName: "solo",
    agentId: "agt_solo",
    canceledAt: state === "canceled" ? updatedAt : null,
    claimedAt: state === "claimed" || state === "delivered" || state === "addressed"
      ? updatedAt
      : null,
    createdAt: "2026-09-03T08:00:00.000Z",
    deliveredAt: state === "delivered" || state === "addressed" ? updatedAt : null,
    failedAt: state === "failed" ? updatedAt : null,
    failureReason: state === "failed" ? "The agent session ended before delivery." : null,
    id,
    idempotencyKey: `send-${id}`,
    leaseExpiresAt: state === "claimed" ? "2026-09-03T08:05:00.000Z" : null,
    note: null,
    projectId,
    sender: {
      authorizedByPrincipalId: null,
      displayName: "Local owner",
      principalId: "prn_owner",
      principalKind: "human",
    },
    state,
    threadIds: [...threadIds],
    updatedAt,
  };
}

const defaultProject = project("prj_default", "Default");
const researchProject = project("prj_research", "Research", "2026-09-20T12:00:00.000Z");

describe("review queue grouping", () => {
  test.each([
    ["queued", true],
    ["claimed", true],
    ["delivered", true],
    ["addressed", false],
    ["canceled", false],
    ["failed", false],
  ] as const)("a %s send counts as active: %s", (state, active) => {
    expect(isActiveDispatch(send("dsp_1", "prj_default", state, ["cmt_1"], "2026-09-03T08:01:00.000Z")))
      .toBe(active);
  });

  test("an artifact with conversations and an active send is with an agent and not also in conversations", () => {
    const dashboard = catalogEntry("prj_default", "art_dashboard", "Release dashboard", 3);
    const queued = send("dsp_queued", "prj_default", "queued", ["cmt_1"], "2026-09-03T08:01:00.000Z");
    const dispatches = dispatchesByArtifact([queued], [
      {artifactId: "art_dashboard", projectId: "prj_default", threadIds: ["cmt_1"]},
    ]);

    const entries = groupQueue({
      dispatches,
      pages: new Map([["prj_default", catalogPage([dashboard])]]),
      projects: [defaultProject],
    });

    expect(entries).toEqual([{
      activeDispatch: queued,
      artifact: dashboard,
      group: "agent",
      project: defaultProject,
    }]);
  });

  test("failed, canceled and addressed sends leave their artifact in conversations", () => {
    const failed = catalogEntry("prj_default", "art_failed", "Failed send", 1);
    const canceled = catalogEntry("prj_default", "art_canceled", "Canceled send", 1);
    const addressed = catalogEntry("prj_default", "art_addressed", "Addressed send", 2);
    // Failure and cancellation clear the thread marker; an addressed send keeps it.
    const dispatches = dispatchesByArtifact([
      send("dsp_failed", "prj_default", "failed", ["cmt_f"], "2026-09-03T08:02:00.000Z"),
      send("dsp_canceled", "prj_default", "canceled", ["cmt_c"], "2026-09-03T08:03:00.000Z"),
      send("dsp_addressed", "prj_default", "addressed", ["cmt_a"], "2026-09-03T08:04:00.000Z"),
    ], [
      {artifactId: "art_failed", projectId: "prj_default", threadIds: []},
      {artifactId: "art_canceled", projectId: "prj_default", threadIds: []},
      {artifactId: "art_addressed", projectId: "prj_default", threadIds: ["cmt_a"]},
    ]);

    const entries = groupQueue({
      dispatches,
      pages: new Map([["prj_default", catalogPage([failed, canceled, addressed])]]),
      projects: [defaultProject],
    });

    expect(entries.map((entry) => [entry.artifact.artifact.id, entry.group, entry.activeDispatch]))
      .toEqual([
        ["art_addressed", "conversations", null],
        ["art_canceled", "conversations", null],
        ["art_failed", "conversations", null],
      ]);
  });

  test("a thread resent after a failed send is with the new send", () => {
    const dashboard = catalogEntry("prj_default", "art_dashboard", "Release dashboard", 1);
    const failed = send("dsp_old", "prj_default", "failed", ["cmt_9"], "2026-09-03T08:01:00.000Z");
    const resent = send("dsp_new", "prj_default", "claimed", ["cmt_9"], "2026-09-03T09:01:00.000Z");
    const dispatches = dispatchesByArtifact([resent, failed], [
      {artifactId: "art_dashboard", projectId: "prj_default", threadIds: ["cmt_9"]},
    ]);

    const [entry] = groupQueue({
      dispatches,
      pages: new Map([["prj_default", catalogPage([dashboard])]]),
      projects: [defaultProject],
    });

    expect(entry?.group).toBe("agent");
    expect(entry?.activeDispatch?.id).toBe("dsp_new");
  });

  test("the most recently updated of several active sends is the one shown", () => {
    const dashboard = catalogEntry("prj_default", "art_dashboard", "Release dashboard", 2);
    const older = send("dsp_older", "prj_default", "delivered", ["cmt_1"], "2026-09-03T08:00:00.000Z");
    const newer = send("dsp_newer", "prj_default", "queued", ["cmt_2"], "2026-09-03T10:00:00.000Z");
    const dispatches = dispatchesByArtifact([older, newer], [
      {artifactId: "art_dashboard", projectId: "prj_default", threadIds: ["cmt_1", "cmt_2"]},
    ]);

    const [entry] = groupQueue({
      dispatches,
      pages: new Map([["prj_default", catalogPage([dashboard])]]),
      projects: [defaultProject],
    });

    expect(entry?.activeDispatch?.id).toBe("dsp_newer");
  });

  test("an artifact without conversations or a send is not queued", () => {
    const quiet = catalogEntry("prj_default", "art_quiet", "Quiet artifact", 0);

    expect(groupQueue({
      dispatches: new Map(),
      pages: new Map([["prj_default", catalogPage([quiet])]]),
      projects: [defaultProject],
    })).toEqual([]);
  });

  test("a send never claims a thread listed under another project", () => {
    const foreign = send("dsp_a", "prj_default", "queued", ["cmt_shared"], "2026-09-03T08:00:00.000Z");

    const dispatches = dispatchesByArtifact([foreign], [
      {artifactId: "art_research", projectId: "prj_research", threadIds: ["cmt_shared"]},
    ]);

    expect(dispatches.size).toBe(0);
  });

  test("one send carrying threads from two artifacts puts both with an agent", () => {
    const bundle = send("dsp_bundle", "prj_default", "queued", ["cmt_1", "cmt_2"], "2026-09-03T08:00:00.000Z");

    const dispatches = dispatchesByArtifact([bundle], [
      {artifactId: "art_one", projectId: "prj_default", threadIds: ["cmt_1"]},
      {artifactId: "art_two", projectId: "prj_default", threadIds: ["cmt_2"]},
    ]);

    expect(dispatches.get(queueKey("prj_default", "art_one"))).toEqual([bundle]);
    expect(dispatches.get(queueKey("prj_default", "art_two"))).toEqual([bundle]);
  });

  test("sends come first, most recent first; conversations follow by count, then name", () => {
    const early = catalogEntry("prj_default", "art_early", "Early send", 1);
    const late = catalogEntry("prj_research", "art_late", "Late send", 1);
    const busy = catalogEntry("prj_default", "art_busy", "Busy notes", 9);
    const alpha = catalogEntry("prj_research", "art_alpha", "Alpha notes", 2);
    const beta = catalogEntry("prj_default", "art_beta", "Beta notes", 2);
    const dispatches = dispatchesByArtifact([
      send("dsp_early", "prj_default", "queued", ["cmt_e"], "2026-09-03T08:00:00.000Z"),
      send("dsp_late", "prj_research", "queued", ["cmt_l"], "2026-09-03T11:00:00.000Z"),
    ], [
      {artifactId: "art_early", projectId: "prj_default", threadIds: ["cmt_e"]},
      {artifactId: "art_late", projectId: "prj_research", threadIds: ["cmt_l"]},
    ]);

    const entries = groupQueue({
      dispatches,
      pages: new Map([
        ["prj_default", catalogPage([busy, beta, early])],
        ["prj_research", catalogPage([alpha, late])],
      ]),
      projects: [defaultProject, researchProject],
    });

    expect(entries.map((entry) => entry.artifact.artifact.name)).toEqual([
      "Late send",
      "Early send",
      "Busy notes",
      "Alpha notes",
      "Beta notes",
    ]);
  });

  test("filtering matches artifact names, project names and identifiers, and counts follow the filter", () => {
    const dashboard = catalogEntry("prj_default", "art_dashboard", "Release dashboard", 3);
    const notes = catalogEntry("prj_research", "art_notes", "Field notes", 1);
    const entries = groupQueue({
      dispatches: dispatchesByArtifact([
        send("dsp_1", "prj_default", "queued", ["cmt_1"], "2026-09-03T08:00:00.000Z"),
      ], [{artifactId: "art_dashboard", projectId: "prj_default", threadIds: ["cmt_1"]}]),
      pages: new Map([
        ["prj_default", catalogPage([dashboard])],
        ["prj_research", catalogPage([notes])],
      ]),
      projects: [defaultProject, researchProject],
    });

    expect(filterQueue(entries, "all", "RELEASE").map((entry) => entry.artifact.artifact.id))
      .toEqual(["art_dashboard"]);
    expect(filterQueue(entries, "all", "research").map((entry) => entry.artifact.artifact.id))
      .toEqual(["art_notes"]);
    expect(filterQueue(entries, "all", "art_notes").map((entry) => entry.artifact.artifact.id))
      .toEqual(["art_notes"]);
    expect(filterQueue(entries, "agent", "").map((entry) => entry.artifact.artifact.id))
      .toEqual(["art_dashboard"]);
    expect(filterQueue(entries, "conversations", "dashboard")).toEqual([]);
    expect(queueCounts(entries)).toEqual({agent: 1, all: 2, conversations: 1});
    expect(queueCounts(filterQueue(entries, "all", "field"))).toEqual({agent: 0, all: 1, conversations: 1});
  });

  test("row copy states what is recorded and never claims threads are unresolved or waiting on the reader", () => {
    const dashboard = catalogEntry("prj_default", "art_dashboard", "Release dashboard", 3);
    const notes = catalogEntry("prj_research", "art_notes", "Field notes", 1);
    const entries = groupQueue({
      dispatches: dispatchesByArtifact([
        send("dsp_1", "prj_default", "claimed", ["cmt_1", "cmt_2"], "2026-09-03T08:00:00.000Z"),
      ], [{artifactId: "art_dashboard", projectId: "prj_default", threadIds: ["cmt_1", "cmt_2"]}]),
      pages: new Map([
        ["prj_default", catalogPage([dashboard])],
        ["prj_research", catalogPage([notes])],
      ]),
      projects: [defaultProject, researchProject],
    });

    const [agentRow, conversationRow] = entries.map(describeQueueEntry);

    expect(agentRow).toEqual({
      meta: ["Default", "Account required", "2 versions"],
      sentence: "Claimed for solo; 2 conversations travelled with the send.",
      state: "Claimed",
      tone: "running",
    });
    expect(conversationRow).toEqual({
      meta: ["Research", "Account required", "2 versions", "Archived project"],
      sentence: "1 conversation recorded, open or resolved.",
      state: "1 conversation",
      tone: "neutral",
    });
    for (const copy of [agentRow, conversationRow]) {
      expect(JSON.stringify(copy)).not.toMatch(/unresolved|needs you/iu);
    }
  });
});
