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
  const {code, message, name} = redactedLevel(cause);
  const codeText = code === undefined ? "" : ` ${code}`;
  return message === "" ? `${name}${codeText}` : `${name}${codeText}: ${message}`;
}

/** What one level of a cause chain may say once redacted. */
interface RedactedLevel {
  readonly code: string | undefined;
  readonly message: string;
  readonly name: string;
}

function redactedLevel(cause: Error): RedactedLevel {
  return {
    code: Predicate.hasProperty(cause, "code") &&
        Predicate.isString(cause.code) &&
        errorCodePattern.test(cause.code)
      ? cause.code
      : undefined,
    message: redactFailureMessage(cause.message),
    name: errorNamePattern.test(cause.name) ? cause.name : "Error",
  };
}

/**
 * Replace a provider or transport error with a copy that keeps only what
 * {@link summarizeFailureCause} would print: each level's name, stable code,
 * and redacted message, to the same depth, with no stack frames or other
 * properties.
 *
 * A failure's cause travels further than the log line. The tracer renders it
 * into every failed span's exception event, so a storage failure is built
 * from this copy rather than from the raw error that names the staged path.
 */
export function redactedFailureCause(cause: unknown): Error {
  return redactedCauseLevel(cause, maximumCauseDepth);
}

function redactedCauseLevel(cause: unknown, remainingDepth: number): Error {
  if (!(cause instanceof Error)) {
    return new Error("non-error value");
  }
  const {code, message, name} = redactedLevel(cause);
  const next = Predicate.hasProperty(cause, "cause") ? cause.cause : undefined;
  const redacted = remainingDepth > 1 && next !== undefined
    ? new Error(message, {cause: redactedCauseLevel(next, remainingDepth - 1)})
    : new Error(message);
  redacted.name = name;
  redacted.stack = message === "" ? name : `${name}: ${message}`;
  return code === undefined ? redacted : Object.assign(redacted, {code});
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
