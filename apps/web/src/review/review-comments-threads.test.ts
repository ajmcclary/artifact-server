import type { CommentThread, CommentThreadPage } from "@/api/client";
import { loadAllThreadsPaged } from "@/review/review-comments-threads";
import { describe, expect, it } from "vitest";

function thread(id: string, createdAt: string, updatedAt = createdAt): CommentThread {
  return {
    anchor: null,
    artifactId: "artifact-1",
    author: {
      authorizedByPrincipalId: null,
      displayName: "Author",
      principalId: "author-1",
      principalKind: "human",
    },
    body: `thread ${id}`,
    createdAt,
    id,
    links: { self: `https://example.com/comments/${id}`, version: "https://example.com/version" },
    path: null,
    projectId: "project-1",
    replyCount: 0,
    resolvedAt: null,
    resolvedBy: null,
    state: "open",
    updatedAt,
    versionId: "version-1",
  };
}

function page(
  items: CommentThread[],
  revision: number,
  nextCursor: string | null = null,
): CommentThreadPage {
  return { items, nextCursor, revision };
}

function fromMap(pages: Map<string | null, CommentThreadPage>, cursor: string | null): CommentThreadPage {
  const found = pages.get(cursor);
  if (found === undefined) {
    throw new Error(`Unexpected cursor: ${cursor ?? "null"}`);
  }
  return found;
}

describe("loadAllThreadsPaged", () => {
  it("returns every page and the page-one revision", async () => {
    const pages = new Map<string | null, CommentThreadPage>([
      [null, page([thread("a", "2026-09-21T10:00:00Z")], 5, "cursor-1")],
      ["cursor-1", page([thread("b", "2026-09-21T09:00:00Z")], 5, "cursor-2")],
      ["cursor-2", page([thread("c", "2026-09-21T08:00:00Z")], 5, null)],
    ]);
    const result = await loadAllThreadsPaged(async (cursor) => fromMap(pages, cursor));
    expect(result.revision).toBe(5);
    expect(result.threads.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("short-circuits to an empty listing when the known revision matches", async () => {
    const pages = new Map<string | null, CommentThreadPage>([
      [null, page([], 7, null)],
    ]);
    const result = await loadAllThreadsPaged(async (cursor) => fromMap(pages, cursor), 7);
    expect(result.revision).toBe(7);
    expect(result.threads).toEqual([]);
  });

  it("reloads the full listing when the known revision is behind", async () => {
    const pages = new Map<string | null, CommentThreadPage>([
      [null, page([thread("a", "2026-09-21T10:00:00Z")], 9, null)],
    ]);
    const result = await loadAllThreadsPaged(async (cursor) => fromMap(pages, cursor), 8);
    expect(result.revision).toBe(9);
    expect(result.threads.map((t) => t.id)).toEqual(["a"]);
  });

  it("restarts from page one when a deeper page reports a different revision", async () => {
    let attempt = 0;
    const result = await loadAllThreadsPaged(async (cursor) => {
      if (cursor === null) {
        attempt += 1;
        return page([thread("a", "2026-09-21T10:00:00Z")], 2, "cursor-1");
      }
      if (attempt === 1) {
        // First attempt: page two is stale, forcing a restart.
        return page([thread("b", "2026-09-21T09:00:00Z")], 1, null);
      }
      // Second attempt: consistent deeper page.
      return page([thread("c", "2026-09-21T08:00:00Z")], 2, null);
    });
    expect(result.revision).toBe(2);
    expect(result.threads.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("throws after the configured number of restart attempts", async () => {
    let pageOneRevision = 0;
    const result = loadAllThreadsPaged(async (cursor) => {
      if (cursor === null) {
        pageOneRevision += 1;
        return page([], pageOneRevision, "cursor");
      }
      // Every deeper page has a different revision, so no attempt converges.
      return page([], pageOneRevision + 1, null);
    }, null, 3);
    await expect(result).rejects.toThrow("revisions changed repeatedly");
  });
});
