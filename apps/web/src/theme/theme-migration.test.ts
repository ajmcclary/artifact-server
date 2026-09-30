import {describe, expect, test} from "vitest";

import {BlockedStorage, MemoryStorage} from "@/testing/memory-storage";

import {LEGACY_THEME_KEY, migrateLegacyTheme} from "./theme-migration.ts";

const themeModeKey = "arkcase.theme.v1";

describe("legacy theme migration", () => {
  test("moon becomes the Dark mode and the legacy key is removed", () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_THEME_KEY, "moon");
    migrateLegacyTheme(storage);
    expect(storage.getItem(themeModeKey)).toBe(JSON.stringify("dark"));
    expect(storage.keys()).toEqual([themeModeKey]);
  });

  test("dawn becomes the Light (default) mode", () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_THEME_KEY, "dawn");
    migrateLegacyTheme(storage);
    expect(storage.getItem(themeModeKey)).toBe(JSON.stringify("default"));
    expect(storage.getItem(LEGACY_THEME_KEY)).toBeNull();
  });

  test("a mode already chosen in the new menu wins over the legacy value", () => {
    const storage = new MemoryStorage();
    storage.setItem(themeModeKey, JSON.stringify("high-contrast"));
    storage.setItem(LEGACY_THEME_KEY, "moon");
    migrateLegacyTheme(storage);
    expect(storage.getItem(themeModeKey)).toBe(JSON.stringify("high-contrast"));
    expect(storage.getItem(LEGACY_THEME_KEY)).toBeNull();
  });

  test("an unknown legacy value is removed without choosing a mode", () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_THEME_KEY, "sepia");
    migrateLegacyTheme(storage);
    expect(storage.keys()).toEqual([]);
  });

  test("no legacy key and blocked storage are both no-ops", () => {
    const storage = new MemoryStorage();
    migrateLegacyTheme(storage);
    expect(storage.keys()).toEqual([]);
    expect(() => migrateLegacyTheme(new BlockedStorage())).not.toThrow();
  });
});
