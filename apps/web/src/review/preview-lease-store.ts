import {z} from "zod";

import type {KeyValueStorage} from "../lib/key-value-storage";

/** Reuse a stored lease only while this much of it remains, so it never expires mid-session. */
export const previewLeaseReuseMarginMilliseconds = 30 * 60 * 1_000;
export const PREVIEW_LEASE_STORAGE_KEY = "artifact-server.preview-leases";

export interface PreviewLease {
  readonly baseUrl: string;
  readonly expiresAt: string;
  readonly versionId: string;
}

export interface PreviewLeaseStore {
  /** Forget every lease of the current principal (logout). */
  readonly forgetPrincipal: () => void;
  readonly remember: (lease: PreviewLease) => void;
  /** The base URL to confirm for reuse, or null to ask for a fresh lease. */
  readonly reusableBaseUrl: (versionId: string) => string | null;
  /** Bind the store to the signed-in principal; another principal's leases are dropped. */
  readonly setPrincipal: (principalId: string | null) => void;
}

const storedLeaseSchema = z.object({baseUrl: z.url(), expiresAt: z.string()});
const storedDocumentSchema = z.object({
  leases: z.record(z.string(), storedLeaseSchema),
  principalId: z.string(),
});
type StoredLease = z.infer<typeof storedLeaseSchema>;
type StoredDocument = z.infer<typeof storedDocumentSchema>;

/** The stored document, or null when it is not valid JSON in the expected shape. */
function parseStoredDocument(raw: string): StoredDocument | null {
  try {
    const parsed = storedDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Preview leases for the signed-in principal, by exact version, kept in memory and
 * mirrored to one storage document so a reopen in a later tab reuses the same lease
 * origin and its browser cache. The server confirms every reuse; this store only
 * remembers what to ask for. Storage failures leave the in-memory copy in charge.
 */
export function createPreviewLeaseStore(storage: KeyValueStorage | null, now: () => number): PreviewLeaseStore {
  let principalId: string | null = null;
  let leases = new Map<string, StoredLease>();

  const removeDocument = (): void => {
    try {
      storage?.removeItem(PREVIEW_LEASE_STORAGE_KEY);
    } catch {
      // An unavailable store has nothing to remove.
    }
  };
  const writeDocument = (): void => {
    if (principalId === null) return;
    try {
      storage?.setItem(PREVIEW_LEASE_STORAGE_KEY, JSON.stringify({
        leases: Object.fromEntries(leases),
        principalId,
      }));
    } catch {
      // A refused write keeps the in-memory leases only.
    }
  };
  const readDocument = (principal: string): Map<string, StoredLease> => {
    let raw: string | null;
    try {
      raw = storage?.getItem(PREVIEW_LEASE_STORAGE_KEY) ?? null;
    } catch {
      return new Map();
    }
    if (raw === null) return new Map();
    const stored = parseStoredDocument(raw);
    // An unreadable document, or another principal's leases, never survives a change of who is signed in.
    if (stored?.principalId !== principal) {
      removeDocument();
      return new Map();
    }
    return new Map(Object.entries(stored.leases));
  };

  return {
    forgetPrincipal: () => {
      principalId = null;
      leases = new Map();
      removeDocument();
    },
    remember: (lease) => {
      if (principalId === null) return;
      leases.set(lease.versionId, {baseUrl: lease.baseUrl, expiresAt: lease.expiresAt});
      writeDocument();
    },
    reusableBaseUrl: (versionId) => {
      if (principalId === null) return null;
      const lease = leases.get(versionId);
      if (lease === undefined) return null;
      const remaining = Date.parse(lease.expiresAt) - now();
      if (Number.isFinite(remaining) && remaining >= previewLeaseReuseMarginMilliseconds) return lease.baseUrl;
      leases.delete(versionId);
      writeDocument();
      return null;
    },
    setPrincipal: (next) => {
      if (next === principalId) return;
      principalId = next;
      leases = next === null ? new Map() : readDocument(next);
    },
  };
}
