import {Buffer} from "node:buffer";
import {randomUUID} from "node:crypto";
import {Readable, Writable} from "node:stream";
import {pipeline} from "node:stream/promises";

import {DefaultAzureCredential, type TokenCredential} from "@azure/identity";
import {
  BlobSASPermissions,
  BlobServiceClient,
  type BlobClient,
  type BlobLeaseClient,
  type BlobGetPropertiesResponse,
  type ContainerClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  type StorageSharedKeyCredential,
  type UserDelegationKey,
} from "@azure/storage-blob";
import {Option} from "effect";

import type {
  BlobByteRange,
  BlobStore,
  BlobWrite,
  OpenedBlob,
  OpenedBlobRange,
  SealedStagedSource,
  StagingStore,
  StoredBlob,
} from "../core/ports.js";
import {
  CloudObjectIntegrityError,
  createInstallationObjectKeyspace,
  digestMetadataName,
  inspectCloudObjectMetadata,
  kindMetadataName,
  nodeByteStream,
  requireCloudObjectBody,
  type InstallationObjectKeyspace,
  type StoredObjectKind,
  verifyCloudObjectWriteSize,
} from "./cloud-object-storage.js";
import type {
  ObjectStorageProvider,
  ObjectStorageProviderFactory,
} from "./object-storage-provider.js";
import {
  azureDigestMetadataName,
  azureKindMetadataName,
  parseAzureFailure,
} from "./azure-blob-common.js";
import {probeAzureSealedPromotion} from "./azure-blob-sealed-promotion-probe.js";
import {verifiedBlobStream} from "./verified-file.js";

const uploadBlockBytes = 8 * 1024 * 1024;
const uploadConcurrency = 2;
const leaseDurationSeconds = 60;
const leaseRetryMilliseconds = 50;
const leaseWaitMilliseconds = 65_000;
const maximumSealAttempts = 3;
const copySourceSasClockSkewMinutes = 5;
const copySourceSasExpirationMinutes = 60;

/** Azure Blob settings using the default Azure credential chain. */
export interface AzureBlobObjectStorageProviderConfig {
  /** HTTPS Blob service endpoint for the deployment's storage account. */
  readonly accountUrl: string;
  /** Existing private container authorized for the runtime identity. */
  readonly container: string;
  /**
   * Optional credential used instead of the default Azure credential chain.
   * Intended for integration environments that require a shared key.
   */
  readonly credential?: StorageSharedKeyCredential | TokenCredential;
  /**
   * Optional resolver for the URL passed as the copy source during sealed
   * promotion. Defaults to the source blob's plain URL; the provider factory
   * supplies a user-delegation SAS resolver for real Azure.
   */
  readonly copySourceUrl?: (source: BlobClient) => string | Promise<string>;
}

/** Construction values for one installation's Azure Blob adapters. */
export interface AzureBlobObjectStorageConfig {
  /** Container client owned by the deployment composition root. */
  readonly container: ContainerClient;
  /** Trusted installation identity used to derive an isolated key prefix. */
  readonly installationId: string;
  /**
   * Sealed Copy Blob promotion mode. "probe" defers the decision to runtime
   * readiness; "enabled" exposes promote unconditionally (test seam); "disabled"
   * never exposes it.
   */
  readonly promotion?: "probe" | "enabled" | "disabled";
  /**
   * Optional resolver for the URL passed as the copy source during sealed
   * promotion. Defaults to the source blob's plain URL.
   */
  readonly copySourceUrl?: (source: BlobClient) => string | Promise<string>;
}

/** Immutable and staging adapters backed by one installation-scoped container. */
export interface AzureBlobObjectStorageAdapters {
  /** Content-addressed immutable blob operations. */
  readonly blobs: BlobStore;
  /** Uncommitted staged-upload operations. */
  readonly staging: StagingStore;
}

/** Build the deployment-facing Azure Blob provider factory. */
export function createAzureBlobObjectStorageProviderFactory(
  config: AzureBlobObjectStorageProviderConfig,
): ObjectStorageProviderFactory {
  return {
    kind: "azure-blob",
    create: (installationId) => createAzureBlobObjectStorageProvider(
      config,
      installationId,
    ),
  };
}

/** Construct Azure Blob adapters around an already configured container client. */
export function createAzureBlobObjectStorageAdapters(
  config: AzureBlobObjectStorageConfig,
): AzureBlobObjectStorageAdapters {
  const keyspace = createInstallationObjectKeyspace(config.installationId);
  const objects = new AzureBlobObjects(
    config.container,
    config.copySourceUrl,
  );
  return buildAzureBlobObjectStorageAdapters(
    objects,
    keyspace,
    config.promotion ?? "probe",
  );
}

function buildAzureBlobObjectStorageAdapters(
  objects: AzureBlobObjects,
  keyspace: InstallationObjectKeyspace,
  promotion: "probe" | "enabled" | "disabled" = "probe",
): AzureBlobObjectStorageAdapters {
  const blobs: BlobStore = {
    inspect: (digest) => objects.inspect(keyspace.blob(digest), digest, "blob"),
    open: (digest) => objects.open(keyspace.blob(digest), digest, "blob"),
    openRange: (digest, range) => objects.openRange(
      keyspace.blob(digest),
      digest,
      "blob",
      range,
    ),
    put: (write) => objects.put(
      keyspace.blob(write.sha256),
      write,
      write.sha256,
      "blob",
    ),
  };
  if (promotion === "enabled") {
    blobs.promote = (source) => objects.promote(source, keyspace);
  }

  return {
    blobs,
    staging: {
      remove: (uploadId, storageToken) => objects.remove(
        keyspace.staging(uploadId, storageToken),
      ),
      open: async (uploadId, storageToken) => {
        const opened = await objects.open(
          keyspace.staging(uploadId, storageToken),
          null,
          "staging",
        );
        return {body: opened.body, size: opened.size};
      },
      put: (write) => objects.put(
        keyspace.staging(write.uploadId, write.storageToken),
        write,
        write.sha256,
        "staging",
      ),
    },
  };
}

function createAzureBlobObjectStorageProvider(
  config: AzureBlobObjectStorageProviderConfig,
  installationId: string,
): ObjectStorageProvider {
  const credential = config.credential ?? new DefaultAzureCredential();
  const service = new BlobServiceClient(config.accountUrl, credential);
  const container = service.getContainerClient(config.container);
  const copySourceUrl = config.copySourceUrl ??
    createUserDelegationCopySourceUrlResolver(service, config.accountUrl);
  const keyspace = createInstallationObjectKeyspace(installationId);
  const objects = new AzureBlobObjects(container, copySourceUrl);
  const adapters = buildAzureBlobObjectStorageAdapters(objects, keyspace, "probe");
  // The capability probe writes, copies and deletes scratch objects, so a
  // settled result is memoized per process rather than re-run on every
  // readiness poll. A rejected probe is retried on the next poll and only
  // withholds promote — the verified-stream fallback keeps serving.
  let promotionProbe: Promise<boolean> | undefined;
  const probePromotion = async () => {
    promotionProbe ??= probeAzureSealedPromotion(
      container,
      installationId,
      copySourceUrl,
    );
    try {
      return await promotionProbe;
    } catch {
      promotionProbe = undefined;
      return false;
    }
  };
  return {
    ...adapters,
    kind: "azure-blob",
    close: () => Promise.resolve(),
    readiness: async (signal) => {
      await container.getProperties({abortSignal: signal});
      if (await probePromotion()) {
        adapters.blobs.promote = (source) => objects.promote(source, keyspace);
      }
    },
  };
}

class AzureBlobObjects {
  readonly #container: ContainerClient;
  readonly #copySourceUrl: (source: BlobClient) => string | Promise<string>;

  constructor(
    container: ContainerClient,
    copySourceUrl: ((source: BlobClient) => string | Promise<string>) = (
      source,
    ) => source.url,
  ) {
    this.#container = container;
    this.#copySourceUrl = copySourceUrl;
  }

  async inspect(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<StoredBlob> {
    const properties = await this.#container.getBlobClient(key).getProperties();
    return inspectAzureMetadata(properties, expectedDigest, kind);
  }

  async #inspectIfPresent(
    key: string,
    expectedDigest: string,
  ): Promise<StoredBlob | null> {
    try {
      return await this.inspect(key, expectedDigest, "blob");
    } catch (error) {
      const failure = parseAzureFailure(error);
      if (Option.isSome(failure) && failure.value.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.#container.getBlobClient(key).deleteIfExists();
  }

  async open(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<OpenedBlob> {
    const client = this.#container.getBlobClient(key);
    const response = await client.download();
    const stored = inspectAzureMetadata(response, expectedDigest, kind);
    const readable = requireCloudObjectBody(
      response.readableStreamBody instanceof Readable
        ? response.readableStreamBody
        : undefined,
      "Azure Blob",
      kind,
      "provider returned no Node.js byte stream",
    );
    return {
      body: nodeByteStream(readable),
      sha256: stored.sha256,
      size: stored.size,
    };
  }

  async openRange(
    key: string,
    expectedDigest: string,
    kind: StoredObjectKind,
    range: BlobByteRange,
  ): Promise<OpenedBlobRange> {
    const client = this.#container.getBlobClient(key);
    const properties = await client.getProperties();
    const stored = inspectAzureMetadata(properties, expectedDigest, kind);
    if (
      range.start < 0 ||
      range.endInclusive < range.start ||
      range.endInclusive >= stored.size
    ) {
      throw new RangeError("Azure Blob range is outside the stored object.");
    }
    const response = await client.download(
      range.start,
      range.endInclusive - range.start + 1,
    );
    const readable = requireCloudObjectBody(
      response.readableStreamBody instanceof Readable
        ? response.readableStreamBody
        : undefined,
      "Azure Blob",
      kind,
      "provider returned no ranged Node.js byte stream",
    );
    return {
      body: nodeByteStream(readable),
      range,
      sha256: stored.sha256,
      size: stored.size,
    };
  }

  async promote(
    source: SealedStagedSource,
    keyspace: InstallationObjectKeyspace,
  ): Promise<StoredBlob> {
    const destKey = keyspace.blob(source.sha256);
    for (let attempt = 0; attempt < maximumSealAttempts; attempt += 1) {
      // Each iteration re-inspects the destination first so a completed but
      // unacknowledged copy converges instead of duplicating.
      // eslint-disable-next-line no-await-in-loop
      const existing = await this.#inspectIfPresent(destKey, source.sha256);
      if (existing !== null) {
        return verifyCloudObjectWriteSize(
          existing,
          source.size,
          "Azure Blob",
          "blob",
        );
      }

      const sourceKey = keyspace.staging(
        source.uploadId,
        source.storageToken,
      );
      const sourceClient = this.#container.getBlobClient(sourceKey);
      let etag: string;
      try {
        // eslint-disable-next-line no-await-in-loop
        const properties = await sourceClient.getProperties();
        if (properties.contentLength !== source.size) {
          throw new Error(
            `The staged source for blob ${source.sha256} has an unexpected size.`,
          );
        }
        if (properties.metadata?.[azureDigestMetadataName] !== source.sha256) {
          throw new Error(
            `The staged source for blob ${source.sha256} failed fingerprint verification.`,
          );
        }
        if (properties.etag === undefined) {
          throw new Error("Azure Blob returned no ETag for the staged source.");
        }
        etag = properties.etag;
      } catch (error) {
        const failure = parseAzureFailure(error);
        const missing = Option.isSome(failure) &&
          failure.value.statusCode === 404;
        if (missing) {
          throw new Error(
            `The staged source for blob ${source.sha256} is missing.`,
            {cause: error},
          );
        }
        throw error;
      }

      const destClient = this.#container.getBlockBlobClient(destKey);
      try {
        // eslint-disable-next-line no-await-in-loop
        const copySource = await this.#copySourceUrl(sourceClient);
        // eslint-disable-next-line no-await-in-loop
        const poller = await destClient.beginCopyFromURL(copySource, {
          conditions: {ifNoneMatch: "*"},
          intervalInMs: 100,
          metadata: {
            [azureDigestMetadataName]: source.sha256,
            [azureKindMetadataName]: "blob",
          },
          sourceConditions: {ifMatch: etag},
        });
        // eslint-disable-next-line no-await-in-loop
        const result = await poller.pollUntilDone();
        if (result.copyStatus !== "success") {
          continue;
        }
      } catch (error) {
        const failure = parseAzureFailure(error);
        const status = Option.isSome(failure)
          ? failure.value.statusCode
          : undefined;
        if (status === 409 || status === 412) {
          // eslint-disable-next-line no-await-in-loop
          const winner = await this.#inspectIfPresent(destKey, source.sha256);
          if (winner !== null) {
            return verifyCloudObjectWriteSize(
              winner,
              source.size,
              "Azure Blob",
              "blob",
            );
          }
        }
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const verified = await this.inspect(destKey, source.sha256, "blob");
      return verifyCloudObjectWriteSize(
        verified,
        source.size,
        "Azure Blob",
        "blob",
      );
    }
    throw new Error(
      `The staged source for blob ${source.sha256} could not be promoted after ${maximumSealAttempts} attempts.`,
    );
  }

  async put(
    key: string,
    write: BlobWrite,
    expectedDigest: string,
    kind: StoredObjectKind,
  ): Promise<StoredBlob> {
    const client = this.#container.getBlockBlobClient(key);
    await ensureLeaseTarget(client, kind, write.signal);
    const lease = await acquireWriteLease(
      client,
      Date.now() + leaseWaitMilliseconds,
      write.signal,
    );
    try {
      const existing = await inspectExistingAzureObject(
        client,
        expectedDigest,
        kind,
        write.signal,
      );
      if (existing !== null) {
        await drainVerifiedWrite(write, expectedDigest);
        return existing;
      }
      const blockIds = await stageVerifiedBlocks(
        client,
        write,
        expectedDigest,
        lease.leaseId,
        () => lease.renewLease(abortOptions(write.signal)).then(() => undefined),
        write.signal,
      );
      await client.commitBlockList(blockIds, {
        ...abortOptions(write.signal),
        blobHTTPHeaders: {blobContentType: "application/octet-stream"},
        conditions: {leaseId: lease.leaseId},
        metadata: {
          [azureDigestMetadataName]: expectedDigest,
          [azureKindMetadataName]: kind,
        },
      });
    } finally {
      await lease.releaseLease();
    }
    return verifyCloudObjectWriteSize(
      await this.inspect(key, expectedDigest, kind),
      write.size,
      "Azure Blob",
      kind,
    );
  }
}

async function stageVerifiedBlocks(
  client: ReturnType<ContainerClient["getBlockBlobClient"]>,
  write: BlobWrite,
  expectedDigest: string,
  leaseId: string,
  renewLease: () => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<Array<string>> {
  const uploadId = randomUUID();
  const blockIds: Array<string> = [];
  let pending: Array<Promise<unknown>> = [];
  let streamingFailed = false;
  let streamingFailure: unknown;
  try {
    for await (const block of fixedSizeBlocks(
      verifiedBlobStream(write, expectedDigest),
    )) {
      const index = String(blockIds.length).padStart(10, "0");
      const blockId = Buffer.from(`${uploadId}:${index}`).toString("base64");
      blockIds.push(blockId);
      pending.push(client.stageBlock(blockId, block, block.byteLength, {
        ...abortOptions(signal),
        conditions: {leaseId},
      }));
      if (pending.length === uploadConcurrency) {
        // A batch bounds memory while preserving provider upload concurrency.
        // eslint-disable-next-line no-await-in-loop
        await settleStagedBlockBatch(pending);
        // The fixed lease remains valid while a large stream is staged.
        // eslint-disable-next-line no-await-in-loop
        await renewLease();
        pending = [];
      }
    }
  } catch (error) {
    streamingFailed = true;
    streamingFailure = error;
  }
  let pendingFailed = false;
  let pendingFailure: unknown;
  try {
    await settleStagedBlockBatch(pending);
  } catch (error) {
    pendingFailed = true;
    pendingFailure = error;
  }
  if (streamingFailed) throw streamingFailure;
  if (pendingFailed) throw pendingFailure;
  return blockIds;
}

async function settleStagedBlockBatch(
  pending: ReadonlyArray<Promise<unknown>>,
): Promise<void> {
  const results = await Promise.allSettled(pending);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
}

async function ensureLeaseTarget(
  client: ReturnType<ContainerClient["getBlockBlobClient"]>,
  kind: StoredObjectKind,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await client.uploadData(new Uint8Array(), {
      ...abortOptions(signal),
      conditions: {ifNoneMatch: "*"},
      metadata: {[azureKindMetadataName]: kind},
    });
  } catch (error) {
    const failure = parseAzureFailure(error);
    if (
      Option.isNone(failure) ||
      (failure.value.statusCode !== 409 && failure.value.statusCode !== 412)
    ) {
      throw error;
    }
  }
}

async function acquireWriteLease(
  client: ReturnType<ContainerClient["getBlockBlobClient"]>,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<BlobLeaseClient> {
  const lease = client.getBlobLeaseClient(randomUUID());
  try {
    await lease.acquireLease(leaseDurationSeconds, abortOptions(signal));
    return lease;
  } catch (error) {
    const failure = parseAzureFailure(error);
    if (
      Option.isNone(failure) || failure.value.statusCode !== 409 ||
      Date.now() >= deadline
    ) {
      throw error;
    }
    await abortableDelay(leaseRetryMilliseconds, signal);
    return acquireWriteLease(client, deadline, signal);
  }
}

async function inspectExistingAzureObject(
  client: ReturnType<ContainerClient["getBlockBlobClient"]>,
  expectedDigest: string,
  kind: StoredObjectKind,
  signal: AbortSignal | undefined,
): Promise<StoredBlob | null> {
  const properties = await client.getProperties(abortOptions(signal));
  try {
    return inspectAzureMetadata(properties, expectedDigest, kind);
  } catch (error) {
    if (error instanceof CloudObjectIntegrityError) return null;
    throw error;
  }
}

async function drainVerifiedWrite(
  write: BlobWrite,
  expectedDigest: string,
): Promise<void> {
  await pipeline(
    Readable.from(verifiedBlobStream(write, expectedDigest), {objectMode: false}),
    new Writable({
      write: (_chunk, _encoding, callback) => callback(),
    }),
    write.signal === undefined ? {} : {signal: write.signal},
  );
}

function abortOptions(signal: AbortSignal | undefined) {
  return signal === undefined ? {} : {abortSignal: signal};
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, {once: true});
  });
}

async function* fixedSizeBlocks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let block = new Uint8Array(uploadBlockBytes);
  let blockOffset = 0;
  for await (const chunk of body) {
    let chunkOffset = 0;
    while (chunkOffset < chunk.byteLength) {
      const copied = Math.min(
        block.byteLength - blockOffset,
        chunk.byteLength - chunkOffset,
      );
      block.set(chunk.subarray(chunkOffset, chunkOffset + copied), blockOffset);
      blockOffset += copied;
      chunkOffset += copied;
      if (blockOffset === block.byteLength) {
        yield block;
        block = new Uint8Array(uploadBlockBytes);
        blockOffset = 0;
      }
    }
  }
  if (blockOffset > 0) yield block.subarray(0, blockOffset);
}

function createUserDelegationCopySourceUrlResolver(
  service: BlobServiceClient,
  accountUrl: string,
): (source: BlobClient) => Promise<string> {
  const accountName = parseAccountName(accountUrl);
  let cached: {key: UserDelegationKey; expiresOn: Date} | undefined;
  return async (source) => {
    const now = Date.now();
    const refreshDeadline = new Date(
      now + copySourceSasClockSkewMinutes * 60 * 1000,
    );
    if (cached === undefined || cached.expiresOn <= refreshDeadline) {
      const startsOn = new Date(now - copySourceSasClockSkewMinutes * 60 * 1000);
      const expiresOn = new Date(now + copySourceSasExpirationMinutes * 60 * 1000);
      cached = {
        key: await service.getUserDelegationKey(startsOn, expiresOn),
        expiresOn,
      };
    }
    const startsOn = new Date();
    const expiresOn = new Date(
      Date.now() + copySourceSasExpirationMinutes * 60 * 1000,
    );
    const sas = generateBlobSASQueryParameters(
      {
        blobName: source.name,
        containerName: source.containerName,
        expiresOn,
        permissions: BlobSASPermissions.parse("r"),
        protocol: SASProtocol.Https,
        startsOn,
      },
      cached.key,
      accountName,
    );
    return `${source.url}?${sas.toString()}`;
  };
}

function parseAccountName(accountUrl: string): string {
  const host = new URL(accountUrl).hostname;
  const [name] = host.split(".");
  if (name === undefined || name.length === 0) {
    throw new Error("Azure Blob account URL has no account name.");
  }
  return name;
}

function inspectAzureMetadata(
  properties: BlobGetPropertiesResponse,
  expectedDigest: string | null,
  kind: StoredObjectKind,
): StoredBlob {
  const metadata: Record<string, string> = {};
  const digest = properties.metadata?.[azureDigestMetadataName];
  const storedKind = properties.metadata?.[azureKindMetadataName];
  if (digest !== undefined) metadata[digestMetadataName] = digest;
  if (storedKind !== undefined) metadata[kindMetadataName] = storedKind;
  return inspectCloudObjectMetadata({
    expectedDigest,
    kind,
    metadata,
    provider: "Azure Blob",
    size: properties.contentLength ?? Number.NaN,
  });
}
