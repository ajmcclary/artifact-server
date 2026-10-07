import {Predicate} from "effect";

const maximumCauseDepth = 3;
const maximumMessageCharacters = 120;
const maximumSummaryCharacters = 400;
const errorCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/u;
const errorNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/**
 * A bounded, secret-free description of one failure's cause chain for an
 * operator log line: each level's error name, its stable `code`, and its
 * message with every quoted value, URL, path, and opaque identifier removed.
 *
 * Provider messages routinely name the object or file they touched, and a
 * staged slot's location carries the upload's storage token, which is a write
 * capability. Headers, request URLs, and credentials never reach this text.
 */
export function summarizeFailureCause(cause: unknown): string {
  const levels: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < maximumCauseDepth && current !== undefined; depth += 1) {
    levels.push(describeLevel(current));
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  const summary = levels.join(" <- ");
  return summary.length > maximumSummaryCharacters
    ? `${summary.slice(0, maximumSummaryCharacters - 1)}…`
    : summary;
}

function describeLevel(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return "non-error value";
  }
  const name = errorNamePattern.test(cause.name) ? cause.name : "Error";
  const code = Predicate.hasProperty(cause, "code") &&
      Predicate.isString(cause.code) &&
      errorCodePattern.test(cause.code)
    ? ` ${cause.code}`
    : "";
  const message = redactFailureMessage(cause.message);
  return message === "" ? `${name}${code}` : `${name}${code}: ${message}`;
}

/** Remove quoted values, URLs, paths, and opaque identifiers from one error message. */
export function redactFailureMessage(message: string): string {
  const redacted = message
    .replaceAll(/\p{Cc}+/gu, " ")
    .replaceAll(/(["'`]).*?\1/gu, "[value]")
    .replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, "[url]")
    .replaceAll(/(?<![A-Za-z0-9_])(?:[A-Za-z]:)?[\\/][^\s,;)]*/gu, "[path]")
    .replaceAll(/[A-Za-z0-9_.~+=-]{20,}/gu, "[id]")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return redacted.length > maximumMessageCharacters
    ? `${redacted.slice(0, maximumMessageCharacters - 1)}…`
    : redacted;
}
