export interface PanelStoreOptions {
  /** One key per host — `arkcase.panels.v1`, `ek.panels.v1`. Two hosts on one page must not share one. */
  key: string;
  /** Storage to use instead of `window.localStorage` (tests, a session store). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

/** The record under the key: `<id>` a pin, `<id>.w` a width, anything else the host's. */
export type PanelStoreRecord = Record<string, boolean | number | string | null | undefined>;

export interface PanelStoreApi {
  /** The storage key this host owns. */
  key: string;
  /** The whole record, or `{}` when nothing valid is stored or storage failed. */
  read(): PanelStoreRecord;
  /**
   * The one writer: read, mutate, store. Returns false when the write failed (quota,
   * private mode, no storage) so the caller can keep its state and say so; the reason
   * goes to console.warn with the key.
   */
  write(mutate: (record: PanelStoreRecord) => void): boolean;
  /** The stored pin for `id`; `fallback` (false when omitted) unless a boolean is stored. */
  pinned(id: string, fallback?: boolean): boolean;
  setPinned(id: string, value: boolean): boolean;
  /** The stored width under `<id>.w`; `fallback` unless a finite positive number is stored. */
  width(id: string, fallback?: number): number | undefined;
  /** Store a width, or `null` to forget it so the panel's default applies again. */
  setWidth(id: string, value: number | null): boolean;
  /** Any other host state that belongs with the panels — the menu pin, a chosen layout. */
  get<T = unknown>(name: string, fallback?: T): T;
  set(name: string, value: unknown): boolean;
  /** Forget everything under this key. */
  clear(): boolean;
}

/**
 * A factory, not a component: the workstation's panel store promoted. One key per
 * host, one writer, `{}` on any read failure, and a `false` return on any write
 * failure. The panel props stay controlled by the host; this only remembers them.
 */
export function PanelStore(options: PanelStoreOptions): PanelStoreApi;
