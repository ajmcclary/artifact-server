import type {ArtifactVersion, ManifestEntry} from "../core/model.js";
import type {BlobStore} from "../core/ports.js";
import {
  invalidProvenanceRecord,
  maximumProvenanceRecordBytes,
  provenanceRecordPath,
  readProvenanceRecord,
  type ProvenanceOutcome,
} from "../manifest/provenance-record.js";
import {
  invalidViewsDocument,
  maximumViewsDocumentBytes,
  readViewsDocument,
  viewsDocumentPath,
  type ViewsOutcome,
} from "../manifest/views-document.js";

/** Reads a version's producer documents once and keeps each outcome per version. */
export interface VersionDocuments {
  readonly provenance: (saved: ArtifactVersion) => Promise<ProvenanceOutcome>;
  readonly views: (saved: ArtifactVersion) => Promise<ViewsOutcome>;
}

export interface VersionDocumentsDependencies {
  readonly blobs: Pick<BlobStore, "open">;
  /** Outcomes kept per process and kind; versions are immutable, so only memory bounds this. */
  readonly maximumCachedOutcomes?: number;
  /** Stored document bytes whose outcomes one kind may keep; parsed outcomes grow with them. */
  readonly maximumCachedBytes?: number;
}

const defaultMaximumCachedOutcomes = 1_024;
const defaultMaximumCachedBytes = 32 * 1_048_576;

type DocumentText =
  | {readonly kind: "absent"}
  | {readonly kind: "oversized"}
  | {readonly kind: "not-utf8"}
  | {readonly kind: "text"; readonly text: string};

/**
 * A bounded least-recently-used map of in-flight or settled outcomes. Storing
 * the promise lets concurrent first reads share one blob open; a rejected
 * promise is a storage fault, not a property of the version, so it is
 * forgotten and the next read retries.
 */
class OutcomeCache<Outcome> {
  readonly #entries = new Map<string, {readonly outcome: Promise<Outcome>; readonly weight: number}>();
  readonly #limit: number;
  readonly #maximumWeight: number;
  #weight = 0;

  constructor(limit: number, maximumWeight: number) {
    this.#limit = limit;
    this.#maximumWeight = maximumWeight;
  }

  /** `weight` is the stored size of the document the outcome is parsed from. */
  read(key: string, weight: number, load: () => Promise<Outcome>): Promise<Outcome> {
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return existing.outcome;
    }
    const loading = load();
    this.#entries.set(key, {outcome: loading, weight});
    this.#weight += weight;
    loading.catch(() => {
      if (this.#entries.get(key)?.outcome === loading) this.#forget(key);
    });
    while (this.#entries.size > this.#limit || (this.#weight > this.#maximumWeight && this.#entries.size > 1)) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#forget(oldest.value);
    }
    return loading;
  }

  #forget(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#weight -= entry.weight;
  }
}

/** Build the reader over the deployment's blob store. */
export function createVersionDocuments(
  dependencies: VersionDocumentsDependencies,
): VersionDocuments {
  const limit = dependencies.maximumCachedOutcomes ?? defaultMaximumCachedOutcomes;
  const cacheBytes = dependencies.maximumCachedBytes ?? defaultMaximumCachedBytes;
  const viewsCache = new OutcomeCache<ViewsOutcome>(limit, cacheBytes);
  const provenanceCache = new OutcomeCache<ProvenanceOutcome>(limit, cacheBytes);

  async function documentText(
    saved: ArtifactVersion,
    path: string,
    maximumBytes: number,
  ): Promise<DocumentText> {
    const entry = saved.manifest.entries.find((candidate) => candidate.path === path);
    if (entry === undefined) return {kind: "absent"};
    if (entry.size > maximumBytes) return {kind: "oversized"};
    const bytes = await readEntryBytes(dependencies.blobs, entry);
    try {
      return {kind: "text", text: new TextDecoder("utf-8", {fatal: true}).decode(bytes)};
    } catch {
      return {kind: "not-utf8"};
    }
  }

  async function loadProvenance(saved: ArtifactVersion): Promise<ProvenanceOutcome> {
    const read = await documentText(saved, provenanceRecordPath, maximumProvenanceRecordBytes);
    if (read.kind === "oversized") return invalidProvenanceRecord("The provenance record is larger than 4 MiB.");
    if (read.kind === "not-utf8") return invalidProvenanceRecord("The provenance record is not UTF-8 text.");
    return readProvenanceRecord(read.kind === "text" ? read.text : null, saved.manifest.entries);
  }

  async function loadViews(saved: ArtifactVersion): Promise<ViewsOutcome> {
    const read = await documentText(saved, viewsDocumentPath, maximumViewsDocumentBytes);
    if (read.kind === "oversized") return invalidViewsDocument("The views document is larger than 1 MiB.");
    if (read.kind === "not-utf8") return invalidViewsDocument("The views document is not UTF-8 text.");
    return readViewsDocument(read.kind === "text" ? read.text : null, saved.manifest.entries);
  }

  return {
    provenance: (saved) => provenanceCache.read(
      saved.version.id,
      storedSize(saved, provenanceRecordPath),
      () => loadProvenance(saved),
    ),
    views: (saved) => viewsCache.read(
      saved.version.id,
      storedSize(saved, viewsDocumentPath),
      () => loadViews(saved),
    ),
  };
}

/** The stored size of one producer document, or 0 when the version has none. */
function storedSize(saved: ArtifactVersion, path: string): number {
  return saved.manifest.entries.find((entry) => entry.path === path)?.size ?? 0;
}

async function readEntryBytes(
  blobs: Pick<BlobStore, "open">,
  entry: ManifestEntry,
): Promise<Uint8Array> {
  const blob = await blobs.open(entry.sha256);
  const bytes = new Uint8Array(await new Response(blob.body).arrayBuffer());
  if (bytes.byteLength !== entry.size) {
    throw new Error(
      `Stored blob ${entry.sha256} has ${bytes.byteLength} bytes; the manifest declares ${entry.size}.`,
    );
  }
  return bytes;
}
