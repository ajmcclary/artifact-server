import {createHash, randomUUID} from "node:crypto";

import type {Bucket} from "@google-cloud/storage";
import {Option} from "effect";

import {
  digestMetadataName,
  kindMetadataName,
} from "./cloud-object-storage.js";
import {parseGcsFailure} from "./gcs-failure.js";

/**
 * Probe whether a GCS-compatible provider actually enforces the two
 * preconditions sealed promotion relies on: the rewrite must pin the exact
 * sealed source generation, and ifGenerationMatch 0 on the rewrite must keep
 * the destination create-only. The probe writes scratch objects under the
 * installation prefix and removes them in a finally block; any unexpected
 * behavior returns false so the runtime falls back to the verified stream
 * path.
 */
export async function probeGcsSealedPromotion(
  bucket: Bucket,
  installationId: string,
): Promise<boolean> {
  const namespace = createHash("sha256").update(installationId).digest("hex");
  const probeId = randomUUID();
  const prefix = `installations/${namespace}/promotion-probe/${probeId}`;
  const sourceAKey = `${prefix}/source-a`;
  const sourceBKey = `${prefix}/source-b`;
  const destKey = `${prefix}/dest`;
  const dest2Key = `${prefix}/dest2`;

  const bytesA = new TextEncoder().encode("sealed promotion probe a");
  const digestA = createHash("sha256").update(bytesA).digest("hex");
  const bytesB = new TextEncoder().encode("sealed promotion probe b");
  const digestB = createHash("sha256").update(bytesB).digest("hex");

  const cleanup = async () => {
    await Promise.all(
      [sourceAKey, sourceBKey, destKey, dest2Key].map((key) =>
        bucket.file(key).delete({ignoreNotFound: true})
      ),
    );
  };

  try {
    await bucket.file(sourceAKey).save(bytesA, {
      metadata: {
        metadata: {
          [digestMetadataName]: digestA,
          [kindMetadataName]: "staging",
        },
      },
      resumable: false,
      validation: false,
    });
    const [metadataA] = await bucket.file(sourceAKey).getMetadata();
    const generationA = Number(metadataA.generation);
    if (!Number.isSafeInteger(generationA)) return false;

    await bucket.file(sourceAKey, {generation: generationA}).copy(
      bucket.file(destKey),
      {
        contentType: "application/octet-stream",
        metadata: {
          [digestMetadataName]: digestA,
          [kindMetadataName]: "blob",
        },
        preconditionOpts: {ifGenerationMatch: 0},
      },
    );

    await bucket.file(sourceBKey).save(bytesB, {
      metadata: {
        metadata: {
          [digestMetadataName]: digestB,
          [kindMetadataName]: "staging",
        },
      },
      resumable: false,
      validation: false,
    });
    const [metadataB] = await bucket.file(sourceBKey).getMetadata();
    const generationB = Number(metadataB.generation);
    if (!Number.isSafeInteger(generationB)) return false;

    try {
      await bucket.file(sourceBKey, {generation: generationB}).copy(
        bucket.file(destKey),
        {
          contentType: "application/octet-stream",
          metadata: {
            [digestMetadataName]: digestB,
            [kindMetadataName]: "blob",
          },
          preconditionOpts: {ifGenerationMatch: 0},
        },
      );
      return false;
    } catch (error) {
      const failure = parseGcsFailure(error);
      if (Option.isNone(failure) || failure.value.code !== 412) return false;
    }

    try {
      await bucket.file(sourceAKey, {generation: generationA + 1}).copy(
        bucket.file(dest2Key),
        {
          contentType: "application/octet-stream",
          metadata: {
            [digestMetadataName]: digestA,
            [kindMetadataName]: "blob",
          },
          preconditionOpts: {ifGenerationMatch: 0},
        },
      );
      return false;
    } catch (error) {
      const failure = parseGcsFailure(error);
      if (
        Option.isNone(failure) ||
        (failure.value.code !== 404 && failure.value.code !== 412)
      ) {
        return false;
      }
    }

    return true;
  } finally {
    await cleanup().catch(() => undefined);
  }
}
