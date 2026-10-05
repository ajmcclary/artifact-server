import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

/**
 * Sizes follow the ExtractionKit files named in PLAN.md: the DS bundle, the icon
 * CSS and three eagerly loaded data scripts. The text is seeded and JSON-like, so
 * it compresses like code but not like the real fixtures. The entry is not
 * `index.html` because the publish client builds a gallery only without one.
 */
const bundleBytes = 1_740_000;
const iconBytes = 1_040_000;
const dataFiles = [
  {bytes: 6_500_000, path: "data/ek-data-design-record.js"},
  {bytes: 3_900_000, path: "data/ek-data-viewer.js"},
  {bytes: 2_600_000, path: "data/ek-data-record.js"},
] as const;

const words = [
  "claim", "record", "field", "review", "status", "panel", "viewer", "extract",
  "amount", "party", "address", "court", "filing", "docket", "exhibit", "invoice",
  "signature", "page", "region", "anchor", "summary", "detail", "history", "owner",
  "assignee", "due", "date", "total", "balance", "payment", "schedule", "notice",
  "evidence", "witness", "hearing", "motion", "order", "appeal", "judgment", "lien",
  "policy", "carrier", "injury", "employer", "benefit", "medical", "wage", "award",
] as const;
const statuses = ["awaiting-review", "accepted", "rejected", "needs-source"] as const;
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Mulberry32: a small deterministic generator so every run publishes identical bytes. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(values: readonly T[], random: () => number): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("The fixture vocabulary is empty.");
  return value;
}

function generateText(targetBytes: number, prelude: string, line: (index: number) => string): string {
  const parts = [prelude];
  let length = prelude.length;
  for (let index = 0; length < targetBytes; index += 1) {
    const next = line(index);
    parts.push(next);
    length += next.length;
  }
  return parts.join("");
}

function base64Run(random: () => number): string {
  const length = 48 + Math.floor(random() * 72);
  return Array.from({length}, () => base64Alphabet.charAt(Math.floor(random() * base64Alphabet.length))).join("");
}

export async function writeSyntheticPrototype(directory: string): Promise<void> {
  const random = seededRandom(0x5e_ed);
  const word = () => pick(words, random);
  await mkdir(path.join(directory, "tokens"), {recursive: true});
  await mkdir(path.join(directory, "data"), {recursive: true});
  const bundle = generateText(bundleBytes, "window.SyntheticDs = {};\n", (index) =>
    `window.SyntheticDs.c${index} = function (props) { return "<div class=\\"ds-${word()}-${word()}\\" data-tone=\\"" + props.tone + "\\">" + props.${word()} + "</div>"; };\n`);
  const icons = generateText(iconBytes, "", (index) =>
    `.icon-${word()}-${index}{mask-image:url("data:image/svg+xml;base64,${base64Run(random)}")}\n`);
  await writeFile(path.join(directory, "ds-bundle.js"), bundle);
  await writeFile(path.join(directory, "tokens/icons.css"), icons);
  for (const file of dataFiles) {
    const rows = generateText(file.bytes, "window.SyntheticRows = window.SyntheticRows || [];\n", (index) =>
      `window.SyntheticRows.push({"id":"r${index}","field":"${word()}","status":"${pick(statuses, random)}","confidence":${random().toFixed(3)},"value":"${word()} ${word()} ${word()}"});\n`);
    // eslint-disable-next-line no-await-in-loop -- one file at a time bounds the fixture's memory
    await writeFile(path.join(directory, file.path), rows);
  }
  const scripts = ["ds-bundle.js", ...dataFiles.map((file) => file.path)]
    .map((source) => `<script src="${source}"></script>`)
    .join("");
  await writeFile(
    path.join(directory, "prototype.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic prototype</title><link rel="stylesheet" href="tokens/icons.css"></head><body><main>Synthetic prototype</main>${scripts}</body></html>`,
  );
  await writeFile(path.join(directory, "artifactserver.previews.json"), JSON.stringify({
    description: "Shaped like ExtractionKit for delivery measurement.",
    format: "artifact-server.preview-source",
    items: [{
      description: "One entry loading a bundle, icon CSS and eager data.",
      kind: "prototype",
      path: "prototype.html",
      section: "Prototypes",
      title: "Synthetic prototype",
      viewport: {height: 900, width: 1440},
    }],
    title: "Synthetic delivery prototype",
    version: 2,
  }, null, 2));
}
