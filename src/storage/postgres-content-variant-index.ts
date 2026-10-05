import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {z} from "zod";

import {
  ContentVariantConflict,
  type ContentVariantIndex,
  type ContentVariantKey,
  type ContentVariantMapping,
} from "../core/content-variants.js";
import type {Clock} from "../core/ports.js";
import type {PostgresDatabase} from "./postgres-database.js";

const mappingRowSchema = z.object({
  variant_sha256: z.string(),
  // BIGINT arrives as a string from the driver.
  variant_size: z.coerce.number().int().nonnegative(),
});

/** Postgres variant index for stateless external-storage processes. */
export class PostgresContentVariantIndex implements ContentVariantIndex {
  readonly #clock: Clock;
  readonly #database: PostgresDatabase;
  readonly #installationId: string;

  constructor(database: PostgresDatabase, installationId: string, clock: Clock) {
    this.#clock = clock;
    this.#database = database;
    this.#installationId = installationId;
  }

  async find(key: ContentVariantKey): Promise<ContentVariantMapping | null> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql<{readonly variant_sha256: string; readonly variant_size: string}>`
        SELECT variant_sha256, variant_size FROM content_variants
        WHERE installation_id = ${installationId}
          AND source_sha256 = ${key.sourceSha256}
          AND coding = ${key.coding}
          AND encoder_id = ${key.encoderId}
      `.withoutTransform;
    }));
    const row = rows[0];
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
    const installationId = this.#installationId;
    const createdAt = this.#clock.now().toISOString();
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql`
        INSERT INTO content_variants
          (installation_id, source_sha256, coding, encoder_id, variant_sha256, variant_size, created_at)
        VALUES (${installationId}, ${mapping.sourceSha256}, ${mapping.coding}, ${mapping.encoderId},
          ${mapping.variantSha256}, ${mapping.variantSize}, ${createdAt})
        ON CONFLICT (installation_id, source_sha256, coding, encoder_id) DO NOTHING
      `;
    }));
    const stored = await this.find(mapping);
    if (
      stored === null
      || stored.variantSha256 !== mapping.variantSha256
      || stored.variantSize !== mapping.variantSize
    ) {
      throw new ContentVariantConflict(mapping);
    }
  }
}
