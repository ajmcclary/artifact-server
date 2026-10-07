import {createHash} from "node:crypto";

import {z} from "zod";

import {
  type ApiTarget,
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

/**
 * One immutable published version this suite reads, never writes. A pin names
 * a version, not "current", so a producer's republish cannot silently change
 * what the suite tests; re-pinning is a deliberate edit.
 */
export interface VersionPin {
  readonly artifactId: string;
  readonly label: string;
  readonly versionId: string;
}

/** A pinned version's bytes, each checked against the source manifest's digest. */
export interface PinnedCopy {
  readonly entryPath: string;
  readonly files: readonly TestSiteFile[];
  readonly routingMode: "spa" | "static";
}

const artifactSchema = z.object({artifact: z.object({projectId: z.string()}).loose()}).loose();
const versionSchema = z.object({
  manifest: z.object({
    entries: z.array(z.object({
      mediaType: z.string(),
      path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      size: z.number().int().nonnegative(),
    }).loose()).min(1),
    entryPath: z.string(),
    routingMode: z.enum(["spa", "static"]),
  }).loose(),
}).loose();

/** Files fetched at once; enough to finish a few megabytes quickly without crowding the server. */
const fetchConcurrency = 6;

async function getJson<Output>(source: ApiTarget, path: string, output: z.ZodType<Output>): Promise<Output> {
  const response = await fetch(`${source.server.baseUrl}${path}`, {
    headers: {Authorization: `Bearer ${source.installation.apiToken}`},
  });
  if (response.status !== 200) throw new Error(`GET ${path} returned HTTP ${response.status}.`);
  return output.parse(await response.json());
}

/** Read every file of a pinned version and refuse any whose bytes differ from its manifest entry. */
export async function readPinnedVersion(source: ApiTarget, pin: VersionPin): Promise<PinnedCopy> {
  const {artifact} = await getJson(source, `/api/v1/artifacts/${pin.artifactId}`, artifactSchema);
  const base = `/api/v1/artifacts/${pin.artifactId}/versions/${pin.versionId}`;
  const {manifest} = await getJson(source, `${base}?projectId=${artifact.projectId}`, versionSchema);
  const files: TestSiteFile[] = [];
  const queue = [...manifest.entries];
  async function worker(): Promise<void> {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      const query = new URLSearchParams({path: entry.path, projectId: artifact.projectId});
      // eslint-disable-next-line no-await-in-loop -- each worker reads one file at a time
      const response = await fetch(`${source.server.baseUrl}${base}/file?${query.toString()}`, {
        headers: {Authorization: `Bearer ${source.installation.apiToken}`},
      });
      if (response.status !== 200) throw new Error(`${pin.label}: ${entry.path} returned HTTP ${response.status}.`);
      // eslint-disable-next-line no-await-in-loop -- the body belongs to the response just read
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== entry.sha256 || bytes.byteLength !== entry.size) {
        throw new Error(`${pin.label}: ${entry.path} does not match its manifest digest.`);
      }
      files.push({bytes, mediaType: entry.mediaType, path: entry.path});
    }
  }
  await Promise.all(Array.from({length: fetchConcurrency}, worker));
  return {entryPath: manifest.entryPath, files, routingMode: manifest.routingMode};
}

/** Publish a pinned copy as a new private artifact the caller owns and must delete. */
export async function publishPinnedCopy(
  target: ApiTarget,
  copy: PinnedCopy,
  name: string,
  idempotencyKey: string,
): Promise<PublishResponse> {
  const upload = await createStagedUpload(target.server, target.installation, copy.entryPath, copy.files, undefined, copy.routingMode);
  const uploads = await uploadEveryStagedFile(target.installation, upload.body, copy.files);
  const failed = uploads.find((response) => !response.ok);
  if (failed !== undefined) throw new Error(`A staged upload returned HTTP ${failed.status}.`);
  return (await commitStagedUpload(target.installation, upload.body, idempotencyKey, {
    accessSetting: "account_required",
    kind: "new_artifact",
    name,
    tags: [],
  })).body;
}
