// Records the size of the built web application (dist/web) in
// project/evidence/web-bundle-size.json. The ArkCase redesign records a
// baseline before its first slice and a measurement after each slice, and
// stops when the build grows by more than 25 percent over the baseline.
//
//   node scripts/measure-web-bundle.mjs --label <label> [--baseline <label>]
import {execFileSync} from "node:child_process";
import {existsSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {gzipSync} from "node:zlib";

import {z} from "zod";

const maximumGrowth = 0.25;
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repository, "dist", "web");
const evidencePath = path.join(repository, "project", "evidence", "web-bundle-size.json");

const measurementSchema = z.object({
  bytesByExtension: z.record(z.string(), z.number().int().nonnegative()),
  commit: z.string(),
  dirty: z.boolean(),
  gzipBytes: z.object({css: z.number().int(), html: z.number().int(), js: z.number().int()}).strict(),
  label: z.string().min(1),
  measuredAt: z.string(),
  node: z.string(),
  totalBytes: z.number().int().nonnegative(),
}).strict();
const evidenceSchema = z.object({
  description: z.string(),
  maximumGrowth: z.number(),
  measurements: z.array(measurementSchema),
}).strict();

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function builtFiles(directory) {
  const found = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) found.push(absolute);
    }
  }
  return found;
}

function measure(label) {
  const bytesByExtension = {};
  const gzipBytes = {css: 0, html: 0, js: 0};
  let totalBytes = 0;
  for (const file of builtFiles(webRoot)) {
    const bytes = readFileSync(file);
    const extension = path.extname(file).slice(1) || "none";
    bytesByExtension[extension] = (bytesByExtension[extension] ?? 0) + bytes.byteLength;
    totalBytes += bytes.byteLength;
    if (extension === "css" || extension === "html" || extension === "js") {
      gzipBytes[extension] += gzipSync(bytes, {level: 9}).byteLength;
    }
  }
  return measurementSchema.parse({
    bytesByExtension: Object.fromEntries(Object.entries(bytesByExtension).toSorted(([left], [right]) => (left < right ? -1 : 1))),
    commit: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
    dirty: execFileSync("git", ["-C", repository, "status", "--porcelain"], {encoding: "utf8"}).trim() !== "",
    gzipBytes,
    label,
    measuredAt: new Date().toISOString(),
    node: process.version,
    totalBytes,
  });
}

const label = option("--label");
if (label === null) throw new Error("usage: measure-web-bundle.mjs --label <label> [--baseline <label>]");
if (!existsSync(path.join(webRoot, "review.html"))) throw new Error("dist/web is not built; run pnpm build first.");

const evidence = existsSync(evidencePath)
  ? evidenceSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")))
  : {
    description: "Size of dist/web for the ArkCase redesign; see docs/superpowers/specs/2026-09-29-arkcase-artifacts-redesign-design.md (Risks).",
    maximumGrowth,
    measurements: [],
  };
const measurement = measure(label);
const measurements = [...evidence.measurements.filter((entry) => entry.label !== label), measurement];
writeFileSync(evidencePath, `${JSON.stringify({...evidence, measurements}, null, 2)}\n`);
process.stdout.write(`${label}: ${measurement.totalBytes} bytes; gzip js ${measurement.gzipBytes.js}, css ${measurement.gzipBytes.css}.\n`);

const baselineLabel = option("--baseline");
if (baselineLabel !== null) {
  const baseline = measurements.find((entry) => entry.label === baselineLabel);
  if (baseline === undefined) throw new Error(`no measurement labelled ${baselineLabel}.`);
  const growth = measurement.totalBytes / baseline.totalBytes - 1;
  process.stdout.write(`Growth over ${baselineLabel}: ${(growth * 100).toFixed(1)} percent.\n`);
  if (growth > maximumGrowth) {
    process.stderr.write(`dist/web grew by more than ${maximumGrowth * 100} percent; stop and report (spec Risks).\n`);
    process.exitCode = 1;
  }
}
