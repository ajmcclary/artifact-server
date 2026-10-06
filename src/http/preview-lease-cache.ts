/** Cache-Control for a successful lease-origin response: fresh only while its lease is. */
export function previewLeaseCacheControl(freshSeconds: number): string {
  return freshSeconds >= 1 ? `private, max-age=${freshSeconds}, immutable` : "private, no-store";
}

/** Lease-origin statuses that may be stored; every other status is never stored. */
export const cacheablePreviewLeaseStatuses: ReadonlySet<number> = new Set([200, 206, 304]);
