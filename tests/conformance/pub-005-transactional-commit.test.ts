import {createHash} from "node:crypto";
import {access} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  type CreateUploadResponse,
  createStagedUpload,
  publishNew,
  type TestSiteFile,
  uploadEveryStagedFile,
  uploadStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const encoder = new TextEncoder();

const versionRowSchema = z.object({id: z.string(), number: z.number()});
const entryRowSchema = z.object({path: z.string(), sha256: z.string(), version_id: z.string()});
const keyRowSchema = z.object({idempotency_key: z.string(), version_id: z.string()});
const actionRowSchema = z.object({action: z.string(), idempotency_key: z.string(), version_id: z.string()});
const pointerRowSchema = z.object({current_version_id: z.string().nullable()});
const committedSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), id: z.string()}).loose(),
  version: z.object({id: z.string(), number: z.number()}).loose(),
}).loose();

/** Everything one artifact's publishes leave in the database, read in one snapshot. */
interface ArtifactRecords {
  readonly actions: readonly z.infer<typeof actionRowSchema>[];
  readonly currentVersionId: string | null;
  readonly entries: readonly z.infer<typeof entryRowSchema>[];
  readonly idempotencyKeys: readonly z.infer<typeof keyRowSchema>[];
  readonly versions: readonly z.infer<typeof versionRowSchema>[];
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function site(label: string): readonly TestSiteFile[] {
  return [
    {bytes: encoder.encode(`<!doctype html><title>${label}</title>`), mediaType: "text/html; charset=utf-8", path: "index.html"},
    {bytes: encoder.encode(`document.title = ${JSON.stringify(label)};`), mediaType: "text/javascript", path: "app.js"},
  ];
}

describe("one database transaction commits a publish after its blobs are durable", () => {
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

  function withDatabase<T>(operation: (database: DatabaseSync) => T): T {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {timeout: 5_000},
    );
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }

  function records(artifactId: string): ArtifactRecords {
    return withDatabase((database) => {
      database.exec("BEGIN");
      try {
        const rows = (sql: string) => database.prepare(sql).all(artifactId);
        return {
          actions: z.array(actionRowSchema).parse(rows(
            "SELECT action, idempotency_key, version_id FROM actions WHERE artifact_id = ? ORDER BY created_at, id",
          )),
          currentVersionId: z.array(pointerRowSchema).parse(rows(
            "SELECT current_version_id FROM artifacts WHERE id = ?",
          ))[0]?.current_version_id ?? null,
          entries: z.array(entryRowSchema).parse(rows(
            "SELECT version_id, path, sha256 FROM manifest_entries WHERE version_id IN (SELECT id FROM versions WHERE artifact_id = ?) ORDER BY version_id, path",
          )),
          idempotencyKeys: z.array(keyRowSchema).parse(rows(
            "SELECT idempotency_key, version_id FROM idempotency_records WHERE artifact_id = ? ORDER BY idempotency_key",
          )),
          versions: z.array(versionRowSchema).parse(rows(
            "SELECT id, number FROM versions WHERE artifact_id = ? ORDER BY number",
          )),
        };
      } finally {
        database.exec("COMMIT");
      }
    });
  }

  async function blobExists(digest: string): Promise<boolean> {
    try {
      await access(path.join(installation.dataDirectory, "blobs", digest.slice(0, 2), digest));
      return true;
    } catch {
      return false;
    }
  }

  async function commit(
    upload: CreateUploadResponse,
    idempotencyKey: string,
    target: Readonly<Record<string, string>>,
  ): Promise<Response> {
    return fetch(upload.commitUrl, {
      body: JSON.stringify({target}),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      method: "POST",
    });
  }

  async function stagedVersion(label: string) {
    const files = site(label);
    const upload = await createStagedUpload(server, installation, "index.html", files);
    expect(upload.response.status).toBe(201);
    return {files, upload: upload.body};
  }

  test("PUB-005-B: a committed publish shows its version, manifest entries, idempotency result, action, and current pointer together, every blob already stored", async () => {
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>First</title>",
      idempotencyKey: "pub-005-b-first-version",
    });
    const artifactId = first.body.artifact.id;
    const {files, upload} = await stagedVersion("second");
    await uploadEveryStagedFile(installation, upload, files);
    const committed = await commit(upload, "pub-005-b-second-version", {
      artifactId,
      expectedCurrentVersionId: first.body.version.id,
      kind: "new_version",
    });
    expect(committed.status).toBe(201);
    const second = committedSchema.parse(await committed.json());

    const stored = records(artifactId);
    expect(stored.versions).toEqual([
      {id: first.body.version.id, number: 1},
      {id: second.version.id, number: 2},
    ]);
    expect(stored.currentVersionId).toBe(second.version.id);
    expect(stored.entries.filter((entry) => entry.version_id === second.version.id)
      .map((entry) => [entry.path, entry.sha256]))
      .toEqual(files.map((file) => [file.path, sha256(file.bytes)])
        .toSorted(([left = ""], [right = ""]) => left.localeCompare(right)));
    expect(stored.idempotencyKeys).toContainEqual({
      idempotency_key: "pub-005-b-second-version",
      version_id: second.version.id,
    });
    expect(stored.actions.at(-1)).toEqual({
      action: "publish",
      idempotency_key: "pub-005-b-second-version",
      version_id: second.version.id,
    });
    // Every blob a committed entry names was durable when the records became visible.
    expect(await Promise.all(stored.entries.map((entry) => blobExists(entry.sha256))))
      .toEqual(stored.entries.map(() => true));
  });

  test("PUB-005-F: failures before and during the commit transaction leave no partial version or dangling current pointer", async () => {
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Baseline</title>",
      idempotencyKey: "pub-005-f-baseline-version",
    });
    const artifactId = first.body.artifact.id;
    const baseline = records(artifactId);
    const versionCommit = {
      artifactId,
      expectedCurrentVersionId: first.body.version.id,
      kind: "new_version",
    };

    // Before the transaction: a declared blob was never uploaded.
    const incomplete = await stagedVersion("missing-blob");
    const uploadOne = (filePath: string) => {
      const planned = incomplete.upload.files.find((file) => file.path === filePath);
      const bytes = incomplete.files.find((file) => file.path === filePath)?.bytes;
      if (planned === undefined || bytes === undefined) throw new Error(`No planned ${filePath}.`);
      return uploadStagedFile(installation, planned, bytes);
    };
    expect((await uploadOne("index.html")).status).toBeLessThan(300);
    const beforeTransaction = await commit(incomplete.upload, "pub-005-f-missing-blob", versionCommit);
    expect(beforeTransaction.status).toBeGreaterThanOrEqual(400);
    await beforeTransaction.arrayBuffer();
    expect(records(artifactId)).toEqual(baseline);

    // During the transaction: each record the commit writes refuses in turn.
    const outages = [
      "BEFORE INSERT ON versions",
      "BEFORE INSERT ON manifest_entries",
      "BEFORE INSERT ON idempotency_records",
      "BEFORE INSERT ON actions",
      "BEFORE UPDATE OF current_version_id ON artifacts",
    ];
    const failedStatuses: number[] = [];
    for (const [index, outage] of outages.entries()) {
      // eslint-disable-next-line no-await-in-loop -- each outage is injected and removed in turn
      const staged = await stagedVersion(`outage-${index}`);
      // eslint-disable-next-line no-await-in-loop
      await uploadEveryStagedFile(installation, staged.upload, staged.files);
      withDatabase((database) => database.exec(
        `CREATE TRIGGER pub_005_outage ${outage} BEGIN SELECT RAISE(ABORT, 'injected outage'); END;`,
      ));
      try {
        // eslint-disable-next-line no-await-in-loop
        const failed = await commit(staged.upload, `pub-005-f-outage-${index}`, versionCommit);
        failedStatuses.push(failed.status);
        // eslint-disable-next-line no-await-in-loop
        await failed.arrayBuffer();
      } finally {
        withDatabase((database) => database.exec("DROP TRIGGER pub_005_outage;"));
      }
      expect(records(artifactId)).toEqual(baseline);
    }
    expect(failedStatuses.every((status) => status >= 500)).toBe(true);

    // The same idempotency key succeeds once the outage clears, and the
    // missing blob upload completes the earlier commit; exactly one version
    // lands.
    expect((await uploadOne("app.js")).status).toBeLessThan(300);
    const recovered = await commit(incomplete.upload, "pub-005-f-missing-blob", versionCommit);
    expect(recovered.status).toBe(201);
    const second = committedSchema.parse(await recovered.json());
    const after = records(artifactId);
    expect(after.versions).toEqual([...baseline.versions, {id: second.version.id, number: 2}]);
    expect(after.currentVersionId).toBe(second.version.id);
    expect(after.actions).toHaveLength(baseline.actions.length + 1);
  });
});
