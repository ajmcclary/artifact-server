import {Schema} from "effect";

/** Azure Blob metadata key storing the verified SHA-256 fingerprint. */
export const azureDigestMetadataName = "artifactsha256";

/** Azure Blob metadata key distinguishing immutable blobs from staged upload bytes. */
export const azureKindMetadataName = "artifactkind";

const azureFailureSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  statusCode: Schema.optional(Schema.Number),
});

export const parseAzureFailure = Schema.decodeUnknownOption(azureFailureSchema);
