import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

import {
  ContentVariantConflict,
  type ContentVariantIndex,
  type ContentVariantKey,
  type ContentVariantMapping,
} from "../core/content-variants.js";
import type {Clock} from "../core/ports.js";

const mappingRowSchema = z.object({
  variant_sha256: z.string(),
  variant_size: z.number().int().nonnegative(),
});

/** SQLite variant index sharing the compact installation database. */
export class SqliteContentVariantIndex implements ContentVariantIndex {
  readonly #clock: Clock;
  readonly #database: DatabaseSync;
  readonly #installationId: string;

  constructor(databasePath: string, installationId: string, clock: Clock) {
    this.#clock = clock;
    this.#installationId = installationId;
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      open: true,
      timeout: 5_000,
    });
  }

  async find(key: ContentVariantKey): Promise<ContentVariantMapping | null> {
    const row = this.#database.prepare(`
      SELECT variant_sha256, variant_size FROM content_variants
      WHERE installation_id = ? AND source_sha256 = ? AND coding = ? AND encoder_id = ?
    `).get(this.#installationId, key.sourceSha256, key.coding, key.encoderId);
    if (row === undefined) return null;
    const parsed = mappingRowSchema.parse(row);
    return {
      coding: key.coding,
      encoderId: key.encoderId,
      sourceSha256: key.sourceSha256,
      variantSha256: parsed.variant_sha256,
      variantSize: parsed.variant_size,
    };
  }

  async record(mapping: ContentVariantMapping): Promise<void> {
    this.#database.prepare(`
      INSERT INTO content_variants
        (installation_id, source_sha256, coding, encoder_id, variant_sha256, variant_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (installation_id, source_sha256, coding, encoder_id) DO NOTHING
    `).run(
      this.#installationId,
      mapping.sourceSha256,
      mapping.coding,
      mapping.encoderId,
      mapping.variantSha256,
      mapping.variantSize,
      this.#clock.now().toISOString(),
    );
    const stored = await this.find(mapping);
    if (
      stored === null
      || stored.variantSha256 !== mapping.variantSha256
      || stored.variantSize !== mapping.variantSize
    ) {
      throw new ContentVariantConflict(mapping);
    }
  }

  close(): void {
    this.#database.close();
  }
}
