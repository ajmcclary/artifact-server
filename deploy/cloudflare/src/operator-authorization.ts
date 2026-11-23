import {createHash, timingSafeEqual} from "node:crypto";

/** The shortest bearer secret a transient operator Worker accepts. */
export const minimumOperatorSecretLength = 32;

const bearerPrefix = "Bearer ";

/**
 * Whether a request carries exactly the operator Worker's configured bearer
 * secret.
 *
 * A Worker deployed without its secret binding, or with an empty or short
 * one, refuses every request: the comparison never runs against a literal
 * such as `Bearer undefined`. Both sides are compared as SHA-256 digests so
 * the constant-time comparison does not reveal the secret's length.
 */
export function authorizedOperatorRequest(
  request: Request,
  configuredSecret: string | undefined,
): boolean {
  if (
    configuredSecret === undefined ||
    configuredSecret.length < minimumOperatorSecretLength ||
    configuredSecret.trim() !== configuredSecret
  ) return false;
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith(bearerPrefix)) return false;
  const provided = header.slice(bearerPrefix.length);
  if (provided.length === 0) return false;
  return timingSafeEqual(digest(provided), digest(configuredSecret));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
