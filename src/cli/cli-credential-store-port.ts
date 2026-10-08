import type {Effect, Redacted} from "effect";
import {Schema} from "effect";

/** Expected failure while reading or changing a user credential store. */
export class CliCredentialStoreError extends Schema.TaggedError<CliCredentialStoreError>()(
  "CliCredentialStoreError",
  {
    message: Schema.String,
    operation: Schema.Literals(["delete", "read", "write"]),
    reason: Schema.Literals([
      "backend_unavailable",
      "credential_missing",
      "operation_failed",
    ]),
  },
) {}

/** Secret persistence required by authenticated CLI profiles. */
export interface CliCredentialStoreOperations {
  readonly delete: (
    account: string,
  ) => Effect.Effect<boolean, CliCredentialStoreError>;
  readonly read: (
    account: string,
  ) => Effect.Effect<Redacted.Redacted, CliCredentialStoreError>;
  readonly write: (
    account: string,
    secret: Redacted.Redacted,
  ) => Effect.Effect<void, CliCredentialStoreError>;
}
