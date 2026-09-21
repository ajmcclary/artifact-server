import {createHash} from "node:crypto";

import {Storage} from "@google-cloud/storage";
import {beforeAll, expect, test} from "vitest";

import {createGcsObjectStorageAdapters} from
  "../../src/storage/gcs-object-storage.js";
import {
  defineNativeObjectStorageContract,
  nativeBlobKey,
} from "../support/native-object-storage-contract.js";

const bucketName = "artifact-server-integration";
const projectId = "artifact-server-integration";
const endpoint = requiredEnvironment("ARTIFACT_SERVER_TEST_GCS_ENDPOINT");
const storage = new Storage({apiEndpoint: endpoint, projectId});
const bucket = storage.bucket(bucketName);

beforeAll(async () => {
  const [exists] = await bucket.exists();
  if (!exists) await storage.createBucket(bucketName);
});

defineNativeObjectStorageContract({
  name: "GCS",
  create: (installationId) => createGcsObjectStorageAdapters({
    bucket,
    installationId,
  }),
  corrupt: async ({
    bytes,
    installationId,
    kind,
    objectDigest,
    recordedDigest,
  }) => {
    const metadata = recordedDigest === null
      ? {"artifact-kind": kind}
      : {"artifact-kind": kind, "artifact-sha256": recordedDigest};
    await bucket.file(nativeBlobKey(installationId, objectDigest)).save(bytes, {
      metadata: {metadata},
      resumable: false,
    });
  },
});

test("the provider enforces the zero-generation precondition", async () => {
  const installationId = "installation-gcs-precondition";
  const adapters = createGcsObjectStorageAdapters({bucket, installationId});
  const bytes = new TextEncoder().encode("gcs create-only precondition bytes");
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  await adapters.blobs.put({
    body: new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    sha256: fingerprint,
    size: bytes.byteLength,
  });
  await expect(bucket.file(nativeBlobKey(installationId, fingerprint)).save(bytes, {
    preconditionOpts: {ifGenerationMatch: 0},
    resumable: false,
    validation: false,
  })).rejects.toMatchObject({code: 412});
}, 30_000);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error("Run this test through pnpm test:storage-native-cloud.");
  }
  return value;
}
