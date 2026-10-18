import {z} from "zod";
import type {CommittedStagingCleanupRepository, CommittedStagingUpload} from "../core/ports.js";

type Query = (statement: string, values: readonly (string | number | null)[]) => Promise<readonly unknown[]>;
const rowSchema = z.object({id:z.string(),storageToken:z.string().nullable(),sha256:z.string().nullable(),size:z.coerce.number().nullable()});

/** Shared parameterized SQL for SQLite, Postgres and D1 cleanup progress. */
export function committedStagingCleanupRepository(query: Query, installationId?: string): CommittedStagingCleanupRepository {
  const scope = installationId === undefined ? "" : " AND u.installation_id = ?";
  const scopeValues = installationId === undefined ? [] : [installationId];
  const fileScope = installationId === undefined ? "" : " AND f.installation_id = u.installation_id";
  const selectedColumns = installationId === undefined ? "u.id" : "u.id, u.installation_id";
  const selectedScope = installationId === undefined ? "" : " AND f.installation_id = selected.installation_id";
  return {
    list: async (expiredBefore, limit) => {
      const rows = z.array(rowSchema).parse(await query(`
        WITH selected AS (
          SELECT ${selectedColumns} FROM staged_uploads u
          WHERE u.status = 'committed' AND u.expires_at <= ? AND u.staging_cleaned_at IS NULL${scope}
          ORDER BY u.expires_at, u.id LIMIT ?
        )
        SELECT selected.id, f.storage_token AS "storageToken", f.sha256, f.size
        FROM selected LEFT JOIN staged_upload_files f ON f.upload_id = selected.id
          AND f.staging_cleaned_at IS NULL${selectedScope}
        ORDER BY selected.id, f.storage_token`, [expiredBefore,...scopeValues,limit]));
      const uploads = new Map<string, {id:string;files:Array<CommittedStagingUpload['files'][number]>}>();
      for (const row of rows) {
        const upload = uploads.get(row.id) ?? {id:row.id,files:[]};
        if (row.storageToken !== null) {
          if (row.sha256 === null || row.size === null) throw new Error("Incomplete committed staging metadata.");
          upload.files.push({storageToken:row.storageToken,sha256:row.sha256,size:row.size});
        }
        uploads.set(row.id,upload);
      }
      return [...uploads.values()];
    },
    claim: async (uploadId,expiredBefore,now,staleClaimBefore) => (await query(`
      UPDATE staged_uploads AS u SET cleanup_claimed_at = ?
      WHERE u.id = ? AND u.status = 'committed' AND u.expires_at <= ? AND u.staging_cleaned_at IS NULL
        AND (u.cleanup_claimed_at IS NULL OR u.cleanup_claimed_at <= ?)${scope}
      RETURNING id`,[now,uploadId,expiredBefore,staleClaimBefore,...scopeValues])).length === 1,
    markFileRemoved: async (uploadId,storageToken,claimedAt,removedAt) => {
      const result = await query(`UPDATE staged_upload_files AS f SET staging_cleaned_at = ?
        WHERE f.upload_id = ? AND f.storage_token = ? AND EXISTS (
          SELECT 1 FROM staged_uploads u WHERE u.id = f.upload_id AND u.status = 'committed'
            AND u.cleanup_claimed_at = ?${fileScope}${scope}) RETURNING storage_token`,
        [removedAt,uploadId,storageToken,claimedAt,...scopeValues]);
      if (result.length !== 1) throw new Error("Committed staging cleanup claim was lost.");
    },
    complete: async (uploadId,claimedAt,completedAt) => (await query(`
      UPDATE staged_uploads AS u SET staging_cleaned_at = ?, cleanup_claimed_at = NULL
      WHERE u.id = ? AND u.status = 'committed' AND u.cleanup_claimed_at = ?${scope}
        AND NOT EXISTS (SELECT 1 FROM staged_upload_files f WHERE f.upload_id = u.id
          AND f.staging_cleaned_at IS NULL${fileScope}) RETURNING id`,
      [completedAt,uploadId,claimedAt,...scopeValues])).length === 1,
    release: async (uploadId,claimedAt,staleClaimBefore) => {
      await query(`UPDATE staged_uploads AS u SET cleanup_claimed_at = ? WHERE u.id = ?
        AND u.status = 'committed' AND u.cleanup_claimed_at = ?${scope} RETURNING id`,
        [staleClaimBefore,uploadId,claimedAt,...scopeValues]);
    },
  };
}
