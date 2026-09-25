import {createHash} from "node:crypto";
import {link, mkdir, open, rm, stat} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
  BlobByteRange,
  BlobStore,
  BlobWrite,
  OpenedBlob,
  OpenedBlobRange,
  SealedStagedSource,
  StoredBlob,
} from "../core/ports.js";
import type {LocalBlobStore} from "./local-blob-store.js";
import {verifyExistingBlob} from "./local-blob-store.js";
import type {LocalStagingStore} from "./local-staging-store.js";
import {syncDirectory} from "./verified-file.js";

const systemErrorSchema = z.object({code: z.string().optional()});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const maximumSealAttempts = 3;

type PromotionOutcome = "installed" | "reused" | "swapped";

/**
 * A local blob store that can promote a sealed staged file to an immutable
 * blob by hard link instead of copying bytes. The staged inode is re-hashed
 * through one open handle and linked only while the staged path still resolves
 * to that exact inode; a slot swapped mid-promotion is detected and retried.
 * Every failure rejects so the caller falls back to the verified stream path.
 */
export class LocalPromotingBlobStore implements BlobStore {
  readonly #blobs: LocalBlobStore;
  readonly #staging: LocalStagingStore;

  constructor(blobs: LocalBlobStore, staging: LocalStagingStore) {
    this.#blobs = blobs;
    this.#staging = staging;
  }

  inspect(sha256: string): Promise<StoredBlob> {
    return this.#blobs.inspect(sha256);
  }

  open(sha256: string): Promise<OpenedBlob> {
    return this.#blobs.open(sha256);
  }

  openRange(sha256: string, range: BlobByteRange): Promise<OpenedBlobRange> {
    return this.#blobs.openRange(sha256, range);
  }

  put(write: BlobWrite): Promise<StoredBlob> {
    return this.#blobs.put(write);
  }

  async promote(source: SealedStagedSource): Promise<StoredBlob> {
    const digest = sha256Schema.parse(source.sha256);
    for (let attempt = 0; attempt < maximumSealAttempts; attempt += 1) {
      // Each attempt re-seals from the currently installed staged slot.
      // eslint-disable-next-line no-await-in-loop
      const outcome = await this.#promoteOnce(source, digest);
      if (outcome !== "swapped") {
        return {sha256: digest, size: source.size};
      }
    }
    throw new Error(
      `The staged source for blob ${digest} kept changing during promotion.`,
    );
  }

  async #promoteOnce(
    source: SealedStagedSource,
    digest: string,
  ): Promise<PromotionOutcome> {
    const stagedPath = this.#staging.stagedFilePath(
      source.uploadId,
      source.storageToken,
    );
    const handle = await open(stagedPath, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new Error("A staged upload entry is not a regular file.");
      }
      if (metadata.size !== source.size) {
        throw new Error(
          `The staged source for blob ${digest} has an unexpected size.`,
        );
      }
      const fingerprint = createHash("sha256");
      const chunk = new Uint8Array(65_536);
      let position = 0;
      while (position < metadata.size) {
        // The seal reads the staged inode sequentially through one handle.
        // eslint-disable-next-line no-await-in-loop
        const {bytesRead} = await handle.read(chunk, 0, chunk.byteLength, position);
        if (bytesRead === 0) break;
        fingerprint.update(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (position !== metadata.size || fingerprint.digest("hex") !== digest) {
        throw new Error(
          `The staged source for blob ${digest} failed fingerprint verification.`,
        );
      }

      const finalPath = this.#blobs.blobPath(digest);
      const directory = path.dirname(finalPath);
      await mkdir(directory, {recursive: true, mode: 0o700});
      try {
        await link(stagedPath, finalPath);
      } catch (error) {
        const parsed = systemErrorSchema.safeParse(error);
        if (!parsed.success || parsed.data.code !== "EEXIST") throw error;
        await verifyExistingBlob(finalPath, digest, source.size);
        return "reused";
      }

      const linked = await stat(finalPath);
      const sealed = await handle.stat();
      if (linked.dev !== sealed.dev || linked.ino !== sealed.ino) {
        // The staged slot was renamed over between the seal and the link, so
        // the linked bytes were never verified. Remove only this attempt's
        // link and re-seal from the current slot.
        await rm(finalPath);
        return "swapped";
      }
      await syncDirectory(directory);
      return "installed";
    } finally {
      await handle.close();
    }
  }
}
