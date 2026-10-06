import {describe, expect, test} from "vitest";

import {createPreviewLeaseStore, PREVIEW_LEASE_STORAGE_KEY} from "@/review/preview-lease-store";
import {BlockedStorage, MemoryStorage} from "@/testing/memory-storage";

const hour = 60 * 60 * 1_000;
const lease = (versionId: string, expiresAt: number) => ({
  baseUrl: `https://review-${versionId}.content.test/`,
  expiresAt: new Date(expiresAt).toISOString(),
  versionId,
});

describe("preview lease store", () => {
  test("reuses a stored lease only while at least thirty minutes remain", () => {
    let now = 0;
    const store = createPreviewLeaseStore(new MemoryStorage(), () => now);
    store.setPrincipal("p-a");
    store.remember(lease("v1", 12 * hour));
    expect(store.reusableBaseUrl("v1")).toBe("https://review-v1.content.test/");
    now = 12 * hour - 31 * 60 * 1_000;
    expect(store.reusableBaseUrl("v1")).toBe("https://review-v1.content.test/");
    now = 12 * hour - 29 * 60 * 1_000;
    expect(store.reusableBaseUrl("v1")).toBeNull();
  });

  test("survives a reload through storage, but never across principals", () => {
    const storage = new MemoryStorage();
    const first = createPreviewLeaseStore(storage, () => 0);
    first.setPrincipal("p-a");
    first.remember(lease("v1", 12 * hour));
    const reloaded = createPreviewLeaseStore(storage, () => 0);
    reloaded.setPrincipal("p-a");
    expect(reloaded.reusableBaseUrl("v1")).toBe("https://review-v1.content.test/");
    reloaded.setPrincipal("p-b");
    expect(reloaded.reusableBaseUrl("v1")).toBeNull();
    expect(storage.getItem(PREVIEW_LEASE_STORAGE_KEY) ?? "").not.toContain("p-a");
  });

  test("logout forgets the principal's leases and remembers nothing until a principal is set", () => {
    const storage = new MemoryStorage();
    const store = createPreviewLeaseStore(storage, () => 0);
    store.setPrincipal("p-a");
    store.remember(lease("v1", 12 * hour));
    store.forgetPrincipal();
    expect(storage.getItem(PREVIEW_LEASE_STORAGE_KEY)).toBeNull();
    store.remember(lease("v2", 12 * hour));
    expect(store.reusableBaseUrl("v2")).toBeNull();
  });

  test("blocked, absent, or corrupt storage degrades to memory or a fresh lease", () => {
    for (const storage of [new BlockedStorage(), null]) {
      const store = createPreviewLeaseStore(storage, () => 0);
      store.setPrincipal("p-a");
      store.remember(lease("v1", 12 * hour));
      expect(store.reusableBaseUrl("v1")).toBe("https://review-v1.content.test/");
      store.forgetPrincipal();
      expect(store.reusableBaseUrl("v1")).toBeNull();
    }

    const corrupt = new MemoryStorage();
    corrupt.setItem(PREVIEW_LEASE_STORAGE_KEY, "{not json");
    const store = createPreviewLeaseStore(corrupt, () => 0);
    store.setPrincipal("p-a");
    expect(store.reusableBaseUrl("v1")).toBeNull();
    expect(corrupt.getItem(PREVIEW_LEASE_STORAGE_KEY)).toBeNull();
  });
});
