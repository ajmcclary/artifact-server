/** The slice of Web Storage that preference code reads and writes. */
export type KeyValueStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;
