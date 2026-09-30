import {describe, expect, test} from "vitest";

import {BlockedStorage, MemoryStorage} from "@/testing/memory-storage";

import {DENSITY_STORAGE_KEY, defaultOrCompact, readStoredDensity, storeDensity} from "./density-model.ts";

describe("review density preference", () => {
  test("nothing stored reads as comfortable and writes nothing", () => {
    const storage = new MemoryStorage();
    expect(readStoredDensity(storage)).toBe("comfortable");
    expect(storage.keys()).toEqual([]);
  });

  test("a stored choice round-trips under the density key", () => {
    const storage = new MemoryStorage();
    expect(storeDensity(storage, "compact")).toBe(true);
    expect(storage.keys()).toEqual([DENSITY_STORAGE_KEY]);
    expect(readStoredDensity(storage)).toBe("compact");
    expect(storeDensity(storage, "comfortable")).toBe(true);
    expect(readStoredDensity(storage)).toBe("comfortable");
  });

  test("a hand-edited value falls back to comfortable", () => {
    const storage = new MemoryStorage();
    storage.setItem(DENSITY_STORAGE_KEY, "cozy");
    expect(readStoredDensity(storage)).toBe("comfortable");
  });

  test("blocked or missing storage reads comfortable and reports the lost write", () => {
    expect(readStoredDensity(new BlockedStorage())).toBe("comfortable");
    expect(storeDensity(new BlockedStorage(), "compact")).toBe(false);
    expect(readStoredDensity(null)).toBe("comfortable");
    expect(storeDensity(null, "compact")).toBe(false);
  });

  test("DS components with a default/compact density receive the matching value", () => {
    expect(defaultOrCompact("comfortable")).toBe("default");
    expect(defaultOrCompact("compact")).toBe("compact");
  });
});
