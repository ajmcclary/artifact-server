export interface QualificationFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type QualificationFetch = (
  url: URL,
  options?: {
    readonly body?: string | Uint8Array;
    readonly headers?: Record<string, string>;
    readonly method?: string;
  },
) => Promise<QualificationFetchResponse>;

export interface PreparingPass {
  readonly installed: number;
  readonly total: number;
}

export interface QualificationEvidence {
  readonly artifactIdSha256: string | null;
  readonly commit: number | string | null;
  readonly failureBodies: Record<string, string>;
  readonly health: number | null;
  readonly list: number | null;
  readonly mcp: Readonly<Record<string, number | null>> | null;
  readonly multiArtifactIdSha256: string | null;
  readonly multiCommit: number | string | null;
  readonly multiFileUploads: number | null;
  readonly multiList: number | null;
  readonly multiPreparingPasses: readonly PreparingPass[] | null;
  readonly multiReplay: number | null;
  readonly multiUpload: number | null;
  readonly ready: number | null;
  readonly replay: number | null;
  readonly unauthorized: number | null;
  readonly upload: number | null;
  readonly uploadFile: number | null;
}

export interface QualificationResult {
  readonly evidence: QualificationEvidence;
  readonly passed: boolean;
}

export const qualifyRuntime: (
  qualificationUrl: URL,
  apiToken: string,
  fetchLike?: QualificationFetch,
) => Promise<QualificationResult>;
