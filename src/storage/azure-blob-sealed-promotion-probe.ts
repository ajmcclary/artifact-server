import {createHash, randomUUID} from "node:crypto";

import {
  type BlobClient,
  type ContainerClient,
} from "@azure/storage-blob";
import {Option} from "effect";

import {
  azureDigestMetadataName,
  azureKindMetadataName,
  parseAzureFailure,
} from "./azure-blob-common.js";

/**
 * Probe whether an Azure Blob-compatible provider actually enforces the two
 * preconditions sealed promotion relies on: the source ETag must match
 * `sourceConditions.ifMatch`, and `conditions.ifNoneMatch: "*"` must keep the
 * destination create-only. The probe writes scratch objects under the
 * installation prefix and removes them in a finally block; any unexpected
 * behavior returns false so the runtime falls back to the verified stream path.
 */
export async function probeAzureSealedPromotion(
  container: ContainerClient,
  installationId: string,
  copySourceUrl: (source: BlobClient) => string | Promise<string> = (
    source,
  ) => source.url,
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
      deleteBlobQuietly(container.getBlockBlobClient(sourceAKey)),
      deleteBlobQuietly(container.getBlockBlobClient(sourceBKey)),
      deleteBlobQuietly(container.getBlockBlobClient(destKey)),
      deleteBlobQuietly(container.getBlockBlobClient(dest2Key)),
    ]);
  };

  try {
    const sourceA = container.getBlockBlobClient(sourceAKey);
    const putA = await sourceA.uploadData(bytesA, {
      metadata: {
        [azureDigestMetadataName]: digestA,
        [azureKindMetadataName]: "staging",
      },
    });
    if (putA.etag === undefined) return false;

    const dest = container.getBlockBlobClient(destKey);
    const copyA = await dest.beginCopyFromURL(await copySourceUrl(sourceA), {
      conditions: {ifNoneMatch: "*"},
      intervalInMs: 100,
      metadata: {
        [azureDigestMetadataName]: digestA,
        [azureKindMetadataName]: "blob",
      },
      sourceConditions: {ifMatch: putA.etag},
    });
    const resultA = await copyA.pollUntilDone();
    if (resultA.copyStatus !== "success") return false;

    const sourceB = container.getBlockBlobClient(sourceBKey);
    const putB = await sourceB.uploadData(bytesB, {
      metadata: {
        [azureDigestMetadataName]: digestB,
        [azureKindMetadataName]: "staging",
      },
    });
    if (putB.etag === undefined) return false;

    try {
      const copyB = await dest.beginCopyFromURL(await copySourceUrl(sourceB), {
        conditions: {ifNoneMatch: "*"},
        intervalInMs: 100,
        metadata: {
          [azureDigestMetadataName]: digestB,
          [azureKindMetadataName]: "blob",
        },
        sourceConditions: {ifMatch: putB.etag},
      });
      const resultB = await copyB.pollUntilDone();
      if (resultB.copyStatus === "success") return false;
    } catch (error) {
      const failure = parseAzureFailure(error);
      if (
        Option.isNone(failure) || failure.value.statusCode !== 409
      ) {
        return false;
      }
    }

    const dest2 = container.getBlockBlobClient(dest2Key);
    try {
      const copy2 = await dest2.beginCopyFromURL(await copySourceUrl(sourceA), {
        conditions: {ifNoneMatch: "*"},
        intervalInMs: 100,
        metadata: {
          [azureDigestMetadataName]: digestA,
          [azureKindMetadataName]: "blob",
        },
        sourceConditions: {ifMatch: '"bogus"'},
      });
      const result2 = await copy2.pollUntilDone();
      if (result2.copyStatus === "success") return false;
    } catch (error) {
      const failure = parseAzureFailure(error);
      if (
        Option.isNone(failure) || failure.value.statusCode !== 412
      ) {
        return false;
      }
    }

    return true;
  } finally {
    await cleanup().catch(() => undefined);
  }
}

async function deleteBlobQuietly(client: BlobClient): Promise<void> {
  try {
    await client.deleteIfExists();
  } catch {
    // Intentionally swallow: the probe must fail closed, not leak errors.
  }
}
