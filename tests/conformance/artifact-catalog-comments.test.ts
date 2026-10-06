import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew} from "../support/publishing.js";

const artifactPageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string()}),
    commentCount: z.number().int().nonnegative(),
  })),
  nextCursor: z.string().nullable(),
});

/** The catalog's newest-first order: creation time, then ID, both descending. */
function newestFirst(
  artifacts: readonly {readonly createdAt: string; readonly id: string}[],
): string[] {
  return artifacts.toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
  ).map(({id}) => id);
}

describe("artifact catalog comment queries", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ART-011-B ART-011-F: comment filters and ordering run before keyset pagination", async () => {
    const mostCommented = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "most commented",
      idempotencyKey: "catalog-comments-most",
      name: "Most commented",
    });
    const oneComment = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "one comment",
      idempotencyKey: "catalog-comments-one",
      name: "One comment",
    });
    const noComments = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "no comments",
      idempotencyKey: "catalog-comments-none",
      name: "No comments",
    });
    await createComment(mostCommented.body.artifact.id, mostCommented.body.version.id, 1);
    await createComment(mostCommented.body.artifact.id, mostCommented.body.version.id, 2);
    await createComment(oneComment.body.artifact.id, oneComment.body.version.id, 3);

    const first = await list({limit: "1", sort: "comments"});
    expect(first.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({id: mostCommented.body.artifact.id}),
        commentCount: 2,
      }),
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list({
      cursor: first.nextCursor ?? "",
      limit: "1",
      sort: "comments",
    });
    expect(second.nextCursor).not.toBeNull();
    expect(second.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({id: oneComment.body.artifact.id}),
        commentCount: 1,
      }),
    ]);
    const third = await list({
      cursor: second.nextCursor ?? "",
      limit: "1",
      sort: "comments",
    });
    expect(third.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({id: noComments.body.artifact.id}),
        commentCount: 0,
      }),
    ]);
    expect(third.nextCursor).toBeNull();

    const withComments = await list({comments: "with", sort: "comments"});
    expect(withComments.artifacts.map(({artifact}) => artifact.id)).toEqual([
      mostCommented.body.artifact.id,
      oneComment.body.artifact.id,
    ]);
    const withoutComments = await list({comments: "without"});
    expect(withoutComments.artifacts.map(({artifact}) => artifact.id)).toEqual([
      noComments.body.artifact.id,
    ]);

    // Filtering runs before pagination: one-item pages of commented artifacts
    // in newest order hold only commented artifacts, every one of them, even
    // though the newest artifact in the project has no comments.
    expect(await walkIds({comments: "with", limit: "1", sort: "newest"})).toEqual(
      newestFirst([mostCommented.body.artifact, oneComment.body.artifact]),
    );
    expect(await walkIds({comments: "without", limit: "1", sort: "comments"})).toEqual([
      noComments.body.artifact.id,
    ]);

    // Equal totals page in one deterministic order, newest first, with no
    // artifact repeated or skipped across pages.
    const tiedComment = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "tied comment",
      idempotencyKey: "catalog-comments-tied",
      name: "Tied comment",
    });
    await createComment(tiedComment.body.artifact.id, tiedComment.body.version.id, 4);
    const tied = newestFirst([tiedComment.body.artifact, oneComment.body.artifact]);
    const expectedOrder = [
      mostCommented.body.artifact.id,
      ...tied,
      noComments.body.artifact.id,
    ];
    expect(await walkIds({limit: "1", sort: "comments"})).toEqual(expectedOrder);
    expect(await walkIds({limit: "3", sort: "comments"})).toEqual(expectedOrder);

    const chronological = await list({limit: "1", sort: "newest"});
    const mismatchedCursor = await fetch(`${server.baseUrl}/api/v1/artifacts?${
      new URLSearchParams({
        cursor: chronological.nextCursor ?? "",
        limit: "1",
        projectId: "prj_default",
        sort: "comments",
      })
    }`, {headers: {Authorization: `Bearer ${installation.apiToken}`}});
    expect(mismatchedCursor.status).toBe(422);
    expect(await mismatchedCursor.json()).toMatchObject({
      error: {code: "INVALID_INPUT"},
    });
  });

  async function list(
    query: Readonly<Record<string, string>>,
  ): Promise<z.infer<typeof artifactPageSchema>> {
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts?${
      new URLSearchParams({projectId: "prj_default", ...query})
    }`, {headers: {Authorization: `Bearer ${installation.apiToken}`}});
    expect(response.status).toBe(200);
    return artifactPageSchema.parse(await response.json());
  }

  async function walkIds(
    query: Readonly<Record<string, string>>,
    cursor: string | null = null,
  ): Promise<string[]> {
    const page = await list(cursor === null ? query : {...query, cursor});
    const ids = page.artifacts.map(({artifact}) => artifact.id);
    return page.nextCursor === null ? ids : [...ids, ...await walkIds(query, page.nextCursor)];
  }

  async function createComment(
    artifactId: string,
    versionId: string,
    index: number,
  ): Promise<void> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/comments`,
      {
        body: JSON.stringify({body: `Catalog observation ${index}.`}),
        headers: apiHeaders(installation, `catalog-comment-${index}`),
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
  }
});
