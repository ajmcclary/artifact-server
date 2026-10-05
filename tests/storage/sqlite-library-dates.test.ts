import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {ApiClient} from "../support/agent-dispatch.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const encoder = new TextEncoder();
const versionSchema = z.object({version: z.object({createdAt: z.string(), id: z.string(), number: z.number()})});
const threadSchema = z.object({thread: z.object({createdAt: z.string(), id: z.string()})});
const replySchema = z.object({reply: z.object({createdAt: z.string()})});

function page(pathName: string, body: string): TestSiteFile {
  return {bytes: encoder.encode(`<!doctype html><title>${body}</title>`), mediaType: "text/html", path: pathName};
}

describe("SQLite library dates", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let scratch: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    scratch = await mkdtemp(path.join(tmpdir(), "library-dates-"));
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(scratch, {force: true, recursive: true});
  });

  async function publish(
    key: string,
    files: readonly TestSiteFile[],
    previous: PublishResponse | null,
  ): Promise<PublishResponse> {
    const upload = await createStagedUpload(server, installation, files[0]?.path ?? "a.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const committed = previous === null
      ? await commitStagedUpload(installation, upload.body, key, {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Dated gallery",
        tags: [],
      })
      : await commitStagedUpload(installation, upload.body, key, {
        artifactId: previous.artifact.id,
        expectedCurrentVersionId: previous.version.id,
        kind: "new_version",
      });
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  test("foundation: SQLite page dates follow creation, change, re-add, comments, and the current pointer", async () => {
    const owner = new ApiClient(server, installation.apiToken);
    const v1 = await publish("library-dates-version-one", [page("a.html", "a1"), page("b.html", "b1"), page("c.html", "c1")], null);
    const v2 = await publish("library-dates-version-two", [page("a.html", "a1"), page("b.html", "b2")], v1);
    const v3 = await publish("library-dates-version-three", [page("a.html", "a1"), page("b.html", "b2"), page("c.html", "c1")], v2);
    const versionTime = async (published: PublishResponse) => versionSchema.parse(await (await owner.fetch(
      `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}?projectId=${published.artifact.projectId}`,
    )).json()).version.createdAt;
    const [t1, t2, t3] = [await versionTime(v1), await versionTime(v2), await versionTime(v3)];

    const commentsPath = `/api/v1/artifacts/${v1.artifact.id}/versions/${v1.version.id}/comments?projectId=${v1.artifact.projectId}`;
    const threadResponse = await owner.fetch(commentsPath, {
      body: JSON.stringify({body: "On a.", path: "a.html"}),
      idempotencyKey: "library-dates-thread-on-a",
      method: "POST",
    });
    expect(threadResponse.status).toBe(201);
    const thread = threadSchema.parse(await threadResponse.json()).thread;
    const replyResponse = await owner.fetch(
      `/api/v1/artifacts/${v1.artifact.id}/comments/${thread.id}/replies?projectId=${v1.artifact.projectId}`,
      {body: JSON.stringify({body: "Reply."}), idempotencyKey: "library-dates-reply-on-a", method: "POST"},
    );
    expect(replyResponse.status).toBe(201);
    const replyAt = replySchema.parse(await replyResponse.json()).reply.createdAt;
    // A comment on another page never counts toward this one.
    const otherPage = await owner.fetch(commentsPath, {
      body: JSON.stringify({body: "On c.", path: "c.html"}),
      idempotencyKey: "library-dates-thread-on-c",
      method: "POST",
    });
    expect(otherPage.status).toBe(201);
    const otherPageAt = threadSchema.parse(await otherPage.json()).thread.createdAt;

    const repository = new SqliteArtifactRepository(path.join(installation.dataDirectory, "artifact-server.db"), "local");
    try {
      const dates = await repository.libraryPageDates([
        {artifactId: v1.artifact.id, currentVersionNumber: 3, paths: ["a.html", "b.html", "c.html", "never.html"]},
      ]);
      const byPath = new Map(dates.map((row) => [row.path, row]));
      expect(byPath.get("a.html")).toMatchObject({changedAt: t1, commentedAt: replyAt, createdAt: t1});
      // Comments on a.html and c.html leave b.html untouched.
      expect(byPath.get("b.html")).toMatchObject({changedAt: t2, commentedAt: null, createdAt: t1});
      // Removed in version 2 and re-added in version 3 with identical bytes: creation stays, change moves.
      expect(byPath.get("c.html")).toMatchObject({changedAt: t3, commentedAt: otherPageAt, createdAt: t1});
      expect(byPath.has("never.html")).toBe(false);

      // A current pointer moved back to version 2 ignores version 3.
      const atTwo = await repository.libraryPageDates([
        {artifactId: v1.artifact.id, currentVersionNumber: 2, paths: ["c.html"]},
      ]);
      expect(atTwo[0]).toMatchObject({changedAt: t1, createdAt: t1});
    } finally {
      repository.close();
    }
  });
});
