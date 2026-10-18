import type {CanonicalManifest} from "../core/model.js";
import {createManifest} from "../manifest/create-manifest.js";

/** Keep the last version's provenance when its delivered content is unchanged. */
export function samePublicationContent(
  local: CanonicalManifest,
  remote: CanonicalManifest,
  identity: "package" | "content" = "package",
): boolean {
  if (local.digest === remote.digest) return true;
  if (identity !== "content" || local.entryPath === "artifactserver.provenance.json" ||
    remote.entryPath === "artifactserver.provenance.json") return false;
  return contentManifest(local).digest === contentManifest(remote).digest;
}

function contentManifest(manifest: CanonicalManifest) {
  return createManifest({
    entryPath: manifest.entryPath,
    routingMode: manifest.routingMode,
    files: manifest.entries.filter((file) => file.path !== "artifactserver.provenance.json"),
  });
}
