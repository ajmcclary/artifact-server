import type {KeyValueStorage} from "@/lib/key-value-storage";

/** An in-memory Web Storage area, for tests that run without a browser. */
export class MemoryStorage implements KeyValueStorage {
  readonly #items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  keys(): readonly string[] {
    return [...this.#items.keys()].toSorted();
  }
}

/** A storage area the browser has blocked: every access throws, as in a sandboxed or private context. */
export class BlockedStorage implements KeyValueStorage {
  getItem(): string | null {
    throw new DOMException("The operation is insecure.", "SecurityError");
  }

  removeItem(): void {
    throw new DOMException("The operation is insecure.", "SecurityError");
  }

  setItem(): void {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  }
}
