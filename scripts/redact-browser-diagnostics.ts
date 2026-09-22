import {readdir, readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";

import {unzipSync, zipSync} from "fflate";
import {z} from "zod";

const defaultDiagnosticsDir = "test-results/browser";
const redactedValue = "[REDACTED]";

/**
 * Object keys whose string values are secrets when captured in traces,
 * screenshots metadata, or the JSON report.
 */
const secretKeyPattern = /cookie|set-cookie|authorization|bearer|token|session|secret|signed|api[-_]?key|password/i;

/**
 * Signed-URL and credential query/fragment parameter names. Their values are
 * replaced while the URL structure (parameter presence and order) is kept so
 * failure evidence stays readable.
 */
const secretParamPattern = /^(sig(nature)?|se|st|spr|sv|sr|sp|token|key|api[-_]?key|sessionid|auth)$/i;

interface ScrubbedUrl {
  readonly redacted: number;
  readonly text: string;
}

const diagnosticsJsonSchema: z.ZodType = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(diagnosticsJsonSchema),
  z.record(z.string(), diagnosticsJsonSchema),
]));

type DiagnosticsJson = z.infer<typeof diagnosticsJsonSchema>;

const jsonStringSchema = z.string();
const jsonRecordSchema = z.record(z.string(), diagnosticsJsonSchema);

export interface RedactionSummary {
  readonly diagnosticsDir: string;
  readonly filesRewritten: number;
  readonly filesScanned: number;
  readonly traceEntriesRewritten: number;
  readonly valuesRedacted: number;
  readonly warnings: readonly string[];
}

interface RedactionCounters {
  redacted: number;
}

function redactUrlText(value: string): ScrubbedUrl {
  let redacted = 0;
  const scrubbed = value.replace(
    /([?&#;])([^?&#;=\s]+)=([^?&#;\s]*)/gu,
    (match, separator: string, name: string, paramValue: string) => {
      if (paramValue === redactedValue) return match;
      if (!secretParamPattern.test(name) || paramValue.length === 0) return match;
      redacted += 1;
      return `${separator}${name}=${redactedValue}`;
    },
  );
  return {redacted, text: scrubbed};
}

function redactJsonValue(value: DiagnosticsJson, counters: RedactionCounters): DiagnosticsJson {
  const asString = jsonStringSchema.safeParse(value);
  if (asString.success) {
    const scrubbed = redactUrlText(asString.data);
    counters.redacted += scrubbed.redacted;
    return scrubbed.text;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, counters));
  }
  const asRecord = jsonRecordSchema.safeParse(value);
  if (asRecord.success) {
    const redactedEntries = Object.entries(asRecord.data).map(([key, entry]) => {
      const entryString = jsonStringSchema.safeParse(entry);
      if (entryString.success && entryString.data !== redactedValue && secretKeyPattern.test(key)) {
        counters.redacted += 1;
        return [key, redactedValue] as const;
      }
      return [key, redactJsonValue(entry, counters)] as const;
    });
    return Object.fromEntries(redactedEntries);
  }
  return value;
}

function redactJsonText(content: string, counters: RedactionCounters): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const decoded = diagnosticsJsonSchema.safeParse(parsed);
  if (!decoded.success) return null;
  const redacted = redactJsonValue(decoded.data, counters);
  return `${JSON.stringify(redacted)}\n`;
}

function isZipBuffer(content: Uint8Array): boolean {
  return content.length >= 4
    && content[0] === 0x50
    && content[1] === 0x4b
    && content[2] === 0x03
    && content[3] === 0x04;
}

const fatalDecoder = new TextDecoder("utf-8", {fatal: true});

function redactTraceZip(content: Uint8Array, counters: RedactionCounters): Uint8Array | null {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(content);
  } catch {
    return null;
  }
  // Each entry is decoded on its own: JSON text entries are redacted and
  // re-encoded, while binary entries fail the fatal decode and pass through.
  let rewroteEntry = false;
  const redactedEntries: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  for (const [name, entry] of Object.entries(entries)) {
    let text: string;
    try {
      text = fatalDecoder.decode(entry);
    } catch {
      redactedEntries[name] = entry;
      continue;
    }
    const before = counters.redacted;
    const redactedText = redactJsonText(text, counters);
    if (redactedText === null || counters.redacted === before) {
      redactedEntries[name] = entry;
      continue;
    }
    redactedEntries[name] = encoder.encode(redactedText);
    rewroteEntry = true;
  }
  if (!rewroteEntry) return content;
  return zipSync(redactedEntries);
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  const nested = await Promise.all(entries.map((entry): Promise<string[]> => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(entryPath);
    if (entry.isFile()) return Promise.resolve([entryPath]);
    return Promise.resolve([]);
  }));
  return nested.flat().toSorted();
}

function isRedactionTarget(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".json")
    || lower.endsWith(".zip");
}

/**
 * Redact cookie/session/signed-URL secrets from browser diagnostics in place.
 * Screenshots and videos carry no parseable payload, so they are left intact.
 * Never throws for a missing directory: there is nothing to upload then.
 */
export async function redactDiagnostics(directory: string): Promise<RedactionSummary> {
  let rootStat;
  try {
    rootStat = await stat(directory);
  } catch {
    return {
      diagnosticsDir: directory,
      filesRewritten: 0,
      filesScanned: 0,
      traceEntriesRewritten: 0,
      valuesRedacted: 0,
      warnings: [`Diagnostics directory ${directory} does not exist; nothing to redact.`],
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      diagnosticsDir: directory,
      filesRewritten: 0,
      filesScanned: 0,
      traceEntriesRewritten: 0,
      valuesRedacted: 0,
      warnings: [`Diagnostics path ${directory} is not a directory; nothing to redact.`],
    };
  }

  const counters: RedactionCounters = {redacted: 0};
  const warnings: string[] = [];
  let filesRewritten = 0;
  let traceEntriesRewritten = 0;
  const files = (await collectFiles(directory)).filter(isRedactionTarget);
  const contents = await Promise.all(files.map(async (filePath) => ({
    content: await readFile(filePath),
    filePath,
  })));

  type PendingRewrite =
    | {readonly bytes: Uint8Array; readonly filePath: string; readonly kind: "trace"}
    | {readonly filePath: string; readonly kind: "report"; readonly text: string};
  const pendingRewrites: PendingRewrite[] = [];
  for (const {content, filePath} of contents) {
    if (filePath.toLowerCase().endsWith(".zip") || isZipBuffer(content)) {
      const before = counters.redacted;
      const redacted = redactTraceZip(content, counters);
      if (redacted === null) {
        warnings.push(`Trace ${filePath} is not a readable zip; left intact.`);
        continue;
      }
      if (counters.redacted > before) {
        traceEntriesRewritten += 1;
        filesRewritten += 1;
        pendingRewrites.push({bytes: redacted, filePath, kind: "trace"});
      }
      continue;
    }
    const before = counters.redacted;
    const redactedText = redactJsonText(new TextDecoder().decode(content), counters);
    if (redactedText === null) {
      warnings.push(`JSON file ${filePath} is not valid JSON; left intact.`);
      continue;
    }
    if (counters.redacted > before) {
      filesRewritten += 1;
      pendingRewrites.push({filePath, kind: "report", text: redactedText});
    }
  }
  await Promise.all(pendingRewrites.map((rewrite) =>
    rewrite.kind === "trace"
      ? writeFile(rewrite.filePath, rewrite.bytes)
      : writeFile(rewrite.filePath, rewrite.text, "utf8"),
  ));

  return {
    diagnosticsDir: directory,
    filesRewritten,
    filesScanned: files.length,
    traceEntriesRewritten,
    valuesRedacted: counters.redacted,
    warnings,
  };
}

function readDiagnosticsDir(): string {
  const fromArgv = process.argv[2];
  if (fromArgv !== undefined && fromArgv.length > 0) return fromArgv;
  const fromEnv = process.env["BROWSER_DIAGNOSTICS_DIR"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return defaultDiagnosticsDir;
}

async function main(): Promise<void> {
  const summary = await redactDiagnostics(readDiagnosticsDir());
  process.stdout.write(
    `Redacted ${summary.valuesRedacted} secret value(s) in ${summary.filesRewritten} of ${summary.filesScanned} file(s) under ${summary.diagnosticsDir} (${summary.traceEntriesRewritten} trace archive(s) rewritten).\n`,
  );
  for (const warning of summary.warnings) {
    process.stdout.write(`warning: ${warning}\n`);
  }
  process.exit(0);
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (invokedDirectly) {
  main().catch((error) => {
    // Redaction must never fail the build: log and let the upload proceed.
    process.stderr.write(`Browser diagnostics redaction failed: ${String(error)}\n`);
    process.exit(0);
  });
}
