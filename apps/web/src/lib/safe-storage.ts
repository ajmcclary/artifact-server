/**
 * Best-effort Web Storage access. Private windows, blocked site data and full
 * quotas make `localStorage`/`sessionStorage` throw; every preference in this
 * application is a convenience, so a refused read is "nothing stored" and a
 * refused write is dropped.
 */
export type StorageArea = "local" | "session";

function area(which: StorageArea): Storage | null {
  try {
    return which === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStored(which: StorageArea, key: string): string | null {
  try {
    return area(which)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(which: StorageArea, key: string, value: string): void {
  try {
    area(which)?.setItem(key, value);
  } catch {
    // A refused write keeps the in-memory value only.
  }
}

export function removeStored(which: StorageArea, key: string): void {
  try {
    area(which)?.removeItem(key);
  } catch {
    // Nothing to remove from an unavailable store.
  }
}
