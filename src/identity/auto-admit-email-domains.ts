import {Schema} from "effect";

/** Domains eligible for optional, explicitly verified first-login admission. */
export const autoAdmitEmailDomainsSchema = Schema.Array(
  Schema.String.check(Schema.isPattern(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
  )),
).check(Schema.isUnique());

/** Parse the operator's comma-separated setting, refusing malformed domains. */
export function parseAutoAdmitEmailDomains(
  value: string | undefined,
): ReadonlyArray<string> | undefined {
  if (value === undefined) return undefined;
  return Schema.decodeUnknownSync(autoAdmitEmailDomainsSchema)(
    value.split(",").map((domain) => domain.trim().toLowerCase()),
  );
}
