import {Schema} from "effect";

const gcsFailureSchema = Schema.Struct({
  code: Schema.optional(Schema.Number),
});

/** Decode an unknown value into the small GCS failure shape we recover from. */
export const parseGcsFailure = Schema.decodeUnknownOption(gcsFailureSchema);
