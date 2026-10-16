import {Effect, Schema} from "effect";

import {InvalidArtifactName} from "../core/errors.js";

const artifactName = Schema.String.check(
  Schema.isPattern(/^[^\p{Cc}\p{Cf}\p{Cs}]*$/u),
).pipe(Schema.decodeTo(Schema.Trim.check(Schema.isLengthBetween(1, 200))));

/** Validate human-facing rename metadata before it reaches persistence. */
export const parseRenamedArtifactName = (candidate: string) =>
  Schema.decodeUnknownEffect(artifactName)(candidate).pipe(
    Effect.mapError(() => new InvalidArtifactName({
      message: "Artifact names must be well-formed Unicode with 1 to 200 characters and no control or format characters.",
    })),
  );
