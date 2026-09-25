import {createHash, randomUUID} from "node:crypto";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {Option} from "effect";

import {
  digestMetadataName,
  kindMetadataName,
} from "./cloud-object-storage.js";
import {parseS3Failure} from "./s3-failure.js";

/**
 * Probe whether an S3-compatible provider actually enforces the two preconditions
 * sealed promotion relies on: CopySourceIfMatch must match the source ETag, and
 * IfNoneMatch on CopyObject must keep the destination create-only. The probe
 * writes scratch objects under the installation prefix and removes them in a
 * finally block; any unexpected behavior returns false so the runtime falls back
 * to the verified stream path.
 */
export async function probeS3SealedPromotion(
  client: S3Client,
  bucket: string,
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
    await Promise.all([
      deleteObjectQuietly(client, bucket, sourceAKey),
      deleteObjectQuietly(client, bucket, sourceBKey),
      deleteObjectQuietly(client, bucket, destKey),
      deleteObjectQuietly(client, bucket, dest2Key),
    ]);
  };

  try {
    const putA = await client.send(new PutObjectCommand({
      Body: bytesA,
      Bucket: bucket,
      Key: sourceAKey,
      Metadata: {
        [digestMetadataName]: digestA,
        [kindMetadataName]: "staging",
      },
    }));
    if (putA.ETag === undefined) return false;

    await client.send(new CopyObjectCommand({
      Bucket: bucket,
      Key: destKey,
      CopySource: `/${bucket}/${encodeURIComponent(sourceAKey)}`,
      CopySourceIfMatch: putA.ETag,
      IfNoneMatch: "*",
      MetadataDirective: "REPLACE",
      Metadata: {
        [digestMetadataName]: digestA,
        [kindMetadataName]: "blob",
      },
      ContentType: "application/octet-stream",
    }));

    const putB = await client.send(new PutObjectCommand({
      Body: bytesB,
      Bucket: bucket,
      Key: sourceBKey,
      Metadata: {
        [digestMetadataName]: digestB,
        [kindMetadataName]: "staging",
      },
    }));
    if (putB.ETag === undefined) return false;

    try {
      await client.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: destKey,
        CopySource: `/${bucket}/${encodeURIComponent(sourceBKey)}`,
        CopySourceIfMatch: putB.ETag,
        IfNoneMatch: "*",
        MetadataDirective: "REPLACE",
        Metadata: {
          [digestMetadataName]: digestB,
          [kindMetadataName]: "blob",
        },
        ContentType: "application/octet-stream",
      }));
      return false;
    } catch (error) {
      const failure = parseS3Failure(error);
      if (
        !(Option.isSome(failure) &&
          failure.value.$metadata?.httpStatusCode === 412)
      ) {
        return false;
      }
    }

    try {
      await client.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: dest2Key,
        CopySource: `/${bucket}/${encodeURIComponent(sourceAKey)}`,
        CopySourceIfMatch: '"bogus"',
        IfNoneMatch: "*",
        MetadataDirective: "REPLACE",
        Metadata: {
          [digestMetadataName]: digestA,
          [kindMetadataName]: "blob",
        },
        ContentType: "application/octet-stream",
      }));
      return false;
    } catch (error) {
      const failure = parseS3Failure(error);
      if (
        !(Option.isSome(failure) &&
          failure.value.$metadata?.httpStatusCode === 412)
      ) {
        return false;
      }
    }

    return true;
  } finally {
    await cleanup().catch(() => undefined);
  }
}

async function deleteObjectQuietly(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  try {
    await client.send(new DeleteObjectCommand({Bucket: bucket, Key: key}));
  } catch {
    // Intentionally swallow: the probe must fail closed, not leak errors.
  }
}
