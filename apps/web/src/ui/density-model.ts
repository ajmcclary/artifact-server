import type {KeyValueStorage} from "@/lib/key-value-storage";

/** How much room the review UI gives each row, the user's own choice. */
export type Density = "comfortable" | "compact";

export const DENSITY_STORAGE_KEY = "artifact-review-density";

/** Reads the stored choice; anything missing, unknown or unreadable is comfortable. */
export function readStoredDensity(storage: KeyValueStorage | null): Density {
  if (storage === null) return "comfortable";
  try {
    return storage.getItem(DENSITY_STORAGE_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

/** Stores the user's choice; false when the browser refuses the write. */
export function storeDensity(storage: KeyValueStorage | null, density: Density): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(DENSITY_STORAGE_KEY, density);
    return true;
  } catch {
    return false;
  }
}

/** The value for DS components whose `density` prop is `'default' | 'compact'` (Menu, Alert). */
export function defaultOrCompact(density: Density): "default" | "compact" {
  return density === "compact" ? "compact" : "default";
}

/** `window.localStorage`, or null where the browser blocks it. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
