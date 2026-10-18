import {lstat, readFile, realpath} from "node:fs/promises";
import path from "node:path";
import {Schema} from "effect";

import {parseManifestPath} from "../manifest/create-manifest.js";

const inventorySchema = Schema.Struct({
  format: Schema.Literal("artifact-server.local-files"),
  version: Schema.Literal(1),
  root: Schema.String,
  name: Schema.optional(Schema.String),
  entryPath: Schema.optional(Schema.String),
  files: Schema.Array(Schema.Struct({
    path: Schema.String,
    source: Schema.String,
    sha256: Schema.String,
    size: Schema.Number,
  })),
});

/** Resolve only named regular files inside the inventory's declared source root. */
export async function readLocalPublicationInventory(file: string, maximumFiles: number) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) {
    throw new Error("A local publication inventory must be a regular JSON file of at most 16 MiB.");
  }
  const inventory = Schema.decodeUnknownSync(inventorySchema)(JSON.parse(await readFile(file, "utf8")));
  if (inventory.files.length === 0 || inventory.files.length > maximumFiles) {
    throw new Error(`A local publication inventory must declare between 1 and ${maximumFiles} files.`);
  }
  if (path.isAbsolute(inventory.root) || path.win32.isAbsolute(inventory.root)) {
    throw new Error("The inventory source root must be relative to its JSON file.");
  }
  const root = await realpath(path.resolve(path.dirname(file), inventory.root));
  if (!(await lstat(root)).isDirectory()) throw new Error("The inventory source root must be a directory.");
  const files = [];
  for (const entry of inventory.files) {
    parseManifestPath(entry.path);
    parseManifestPath(entry.source);
    let source = root;
    const segments = entry.source.split("/");
    for (const [index, segment] of segments.entries()) {
      source = path.join(source, segment);
      // eslint-disable-next-line no-await-in-loop -- refuse symlinks at every source-path segment before opening bytes
      const part = await lstat(source);
      if (part.isSymbolicLink() || (index < segments.length - 1 ? !part.isDirectory() : !part.isFile())) {
        throw new Error(`Inventory source is not a regular path: ${entry.source}`);
      }
    }
    files.push({...entry, source});
  }
  return {...inventory, files};
}
