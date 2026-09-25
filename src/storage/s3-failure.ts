import {Schema} from "effect";

const s3FailureSchema = Schema.Struct({
  $metadata: Schema.optional(Schema.Struct({
    httpStatusCode: Schema.optional(Schema.Number),
  })),
});

/** Decode an unknown value into the small S3 failure shape we recover from. */
export const parseS3Failure = Schema.decodeUnknownOption(s3FailureSchema);
