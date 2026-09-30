import {execFileSync, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

const syncScript = fileURLToPath(new URL("../../scripts/sync-arkcase-ds.mjs", import.meta.url));

const sourceRecord = z.object({
  commit: z.string(),
  files: z.record(z.string(), z.object({sha256: z.string(), source: z.string().nullable()})),
  icons: z.object({kept: z.array(z.string()), unmapped: z.array(z.string())}),
  repository: z.string(),
});

const iconSheet = `/* fixture icons */

:root {
  --ark-icon-alpha: url("data:image/svg+xml,alpha");
  --ark-icon-beta: url("data:image/svg+xml,beta");
  --ark-icon-gamma: url("data:image/svg+xml,gamma");
}

/* Base glyph box. */
.bi::before, .bi::after {
  content: "";
}
.bi-alpha::before {
  mask: var(--ark-icon-alpha) center / contain no-repeat;
}
.bi-beta::before, .bi-gamma::before {
  mask: var(--ark-icon-beta) center / contain no-repeat;
}
.bi-gamma::after {
  mask: var(--ark-icon-gamma) center / contain no-repeat;
}
`;

const styleInjection = `import React from 'react';
import { Spinner } from '../feedback/Spinner.jsx';

function ensureButtonStyles() {
  if (typeof document === 'undefined' || document.getElementById('ak-button-css')) return;
  const s = document.createElement('style');
  s.id = 'ak-button-css';
  s.textContent = '[data-ak-button]{cursor:pointer}';
  document.head.appendChild(s);
}

export function Button({ icon = 'bi-alpha' }) {
  React.useEffect(ensureButtonStyles, []);
  return <button data-ak-button=""><i className={'bi ' + icon} /><Spinner /></button>;
}
`;

interface Workspace {
  readonly design: string;
  readonly repository: string;
  readonly root: string;
}

function write(root: string, relativePath: string, content: string | Uint8Array): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), {recursive: true});
  writeFileSync(target, content);
}

function git(directory: string, argumentsList: readonly string[]): string {
  return execFileSync("git", [
    "-c", "user.name=ArkCase fixture",
    "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=",
    ...argumentsList,
  ], {cwd: directory, encoding: "utf8"}).trim();
}

function commitDesign(design: string): string {
  git(design, ["add", "-A"]);
  git(design, ["commit", "-q", "--no-verify", "-m", "fixture"]);
  return git(design, ["rev-parse", "HEAD"]);
}

/** A design-system checkout with the directory layout of ~/Dev/Design. */
function createDesign(design: string): void {
  const components = "arkcase/project/components";
  write(design, `${components}/actions/Button.jsx`, styleInjection);
  write(design, `${components}/actions/Button.d.ts`,
    "export interface ButtonProps { icon?: string }\nexport function Button(props: ButtonProps): null;\n");
  write(design, `${components}/feedback/Spinner.jsx`, "export function Spinner() { return null; }\n");
  write(design, `${components}/feedback/Spinner.d.ts`, "export function Spinner(): null;\n");
  write(design, `${components}/feedback/Unused.jsx`, "export const unusedIcon = 'bi-gamma';\n");
  write(design, `${components}/data-display/ListCard.jsx`,
    "export function ListCard() { return <style>{'[data-list]{}'}</style>; }\n");
  write(design, `${components}/escape/Outside.jsx`, "import { secret } from '../../../../outside.js';\n");
  write(design, "arkcase/project/tokens/icons.css", iconSheet);
  for (const sheet of ["fonts", "colors", "typography", "spacing", "elevation", "base"]) {
    write(design, `arkcase/project/tokens/${sheet}.css`, `/* ${sheet} */\n`);
  }
  write(design, "arkcase/project/tokens/fonts/publicsans.woff2", new Uint8Array([0x77, 0x4f, 0x46, 0x32]));
  write(design, "arkcase/project/tokens/fonts/publicsans-OFL.txt", "SIL Open Font License\n");
  write(design, "arkcase/project/tokens/fonts/manifest.json", "{\"source\": \"https://fonts.example.invalid\"}\n");
  write(design, "arkcase/project/assets/brand/arkcase-emblem.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
  write(design, "arkcase/project/assets/brand/favicon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
  write(design, "workspace/projects/arkcase-artifacts/review-ui.jsx",
    "import { filterPages } from './page-model.js';\nexport function createReviewUI() { return { filterPages }; }\n");
  write(design, "workspace/projects/arkcase-artifacts/review-ui.d.ts",
    "export function createReviewUI(): Record<string, never>;\n");
  write(design, "workspace/projects/arkcase-artifacts/page-model.js", "export function filterPages() { return []; }\n");
  git(design, ["init", "-q"]);
  git(design, ["remote", "add", "origin", "https://example.invalid/arkcase-design.git"]);
  commitDesign(design);
}

function writeEntries(repository: string, components: readonly string[]): void {
  write(repository, "scripts/arkcase-ds-entries.json", `${JSON.stringify({
    brand: ["arkcase-emblem.svg", "favicon.svg"],
    components,
    reviewUi: "workspace/projects/arkcase-artifacts/review-ui.jsx",
  }, null, 2)}\n`);
}

interface SyncRun {
  readonly output: string;
  readonly status: number | null;
}

function runSync(workspace: Workspace, argumentsList: readonly string[] = []): SyncRun {
  const result = spawnSync(process.execPath, [
    syncScript,
    "--repository", workspace.repository,
    "--source", workspace.design,
    ...argumentsList,
  ], {encoding: "utf8"});
  return {output: `${result.stdout}${result.stderr}`, status: result.status};
}

function vendored(workspace: Workspace, relativePath: string): string {
  return readFileSync(path.join(workspace.repository, "apps/web/src/arkcase", relativePath), "utf8");
}

function vendoredFiles(workspace: Workspace): readonly string[] {
  const root = path.join(workspace.repository, "apps/web/src/arkcase");
  return readdirSync(root, {recursive: true, withFileTypes: true})
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .toSorted();
}

function readRecord(workspace: Workspace): z.infer<typeof sourceRecord> {
  return sourceRecord.parse(JSON.parse(vendored(workspace, "SOURCE.json")));
}

const editableRecord = z.object({
  files: z.record(z.string(), z.object({sha256: z.string()}).loose()),
}).loose();

/** Rewrites one vendored file and its SOURCE.json hash, as a careful hand edit would. */
function handEdit(workspace: Workspace, relativePath: string, content: string): void {
  const vendorRoot = path.join(workspace.repository, "apps/web/src/arkcase");
  write(vendorRoot, relativePath, content);
  const record = editableRecord.parse(JSON.parse(vendored(workspace, "SOURCE.json")));
  const entry = record.files[relativePath];
  if (entry === undefined) throw new Error(`${relativePath} is not in SOURCE.json`);
  entry.sha256 = createHash("sha256").update(content).digest("hex");
  write(vendorRoot, "SOURCE.json", `${JSON.stringify(record, null, 2)}\n`);
}

describe("ArkCase design-system sync", () => {
  let workspace: Workspace;

  beforeEach(() => {
    const root = mkdtempSync(path.join(tmpdir(), "artifact-server-arkcase-sync-"));
    workspace = {design: path.join(root, "Design"), repository: path.join(root, "repository"), root};
    createDesign(workspace.design);
    writeEntries(workspace.repository, ["actions/Button.jsx"]);
    write(workspace.repository, "apps/web/src/review/app.tsx", "export const reviewIcon = \"bi-beta\";\n");
    write(workspace.repository, "apps/web/review.html", "<!doctype html><title>Artifact Server</title>\n");
  });

  afterEach(() => {
    rmSync(workspace.root, {force: true, recursive: true});
  });

  test("copies the entry closure with declarations, tokens, fonts and brand marks, and nothing else", () => {
    expect(runSync(workspace)).toMatchObject({status: 0});
    expect(vendoredFiles(workspace)).toEqual([
      "README.md",
      "SOURCE.json",
      "brand/arkcase-emblem.svg",
      "brand/favicon.svg",
      "components/actions/Button.d.ts",
      "components/actions/Button.jsx",
      "components/feedback/Spinner.d.ts",
      "components/feedback/Spinner.jsx",
      "index.ts",
      "review-ui/page-model.js",
      "review-ui/review-ui.d.ts",
      "review-ui/review-ui.jsx",
      "tokens/base.css",
      "tokens/colors.css",
      "tokens/elevation.css",
      "tokens/fonts.css",
      "tokens/fonts/publicsans-OFL.txt",
      "tokens/fonts/publicsans.woff2",
      "tokens/icons.css",
      "tokens/spacing.css",
      "tokens/typography.css",
    ]);
    expect(vendored(workspace, "index.ts")).toContain(
      "export type {ButtonProps} from \"./components/actions/Button.jsx\";",
    );
    expect(vendored(workspace, "index.ts")).toContain(
      "export {Spinner} from \"./components/feedback/Spinner.jsx\";",
    );
  });

  test("SOURCE.json pins the design commit and hashes every vendored file", () => {
    const commit = git(workspace.design, ["rev-parse", "HEAD"]);
    expect(runSync(workspace)).toMatchObject({status: 0});
    const record = readRecord(workspace);
    expect(record.commit).toBe(commit);
    expect(record.repository).toBe("https://example.invalid/arkcase-design.git");
    expect(Object.keys(record.files).toSorted()).toEqual(
      vendoredFiles(workspace).filter((file) => file !== "SOURCE.json"),
    );
    const recorded = Object.fromEntries(Object.entries(record.files).map(([file, entry]) => [file, entry.sha256]));
    const actual = Object.fromEntries(Object.keys(record.files).map((file) => [
      file,
      createHash("sha256").update(readFileSync(path.join(workspace.repository, "apps/web/src/arkcase", file))).digest("hex"),
    ]));
    expect(actual).toEqual(recorded);
    expect(record.files["components/actions/Button.jsx"]?.source)
      .toBe("arkcase/project/components/actions/Button.jsx");
  });

  test("style injection is routed through akStyleDocument", () => {
    expect(runSync(workspace)).toMatchObject({status: 0});
    const button = vendored(workspace, "components/actions/Button.jsx");
    expect(button.startsWith("import { akStyleDocument } from '@/arkcase-style';\n")).toBe(true);
    expect(button).toContain("akStyleDocument.getElementById('ak-button-css')");
    expect(button).toContain("const s = akStyleDocument.createElement('style');");
    expect(button).toContain("akStyleDocument.head.appendChild(s);");
    expect(button).not.toMatch(/(?<![\w$.])document\.(?:getElementById|createElement|head)/u);
    expect(vendored(workspace, "components/feedback/Spinner.jsx")).not.toContain("akStyleDocument");
  });

  test("the icon sheet keeps only referenced classes and the variables they use", () => {
    expect(runSync(workspace)).toMatchObject({status: 0});
    const icons = vendored(workspace, "tokens/icons.css");
    expect(icons).toContain(".bi::before, .bi::after {");
    expect(icons).toContain(".bi-alpha::before {");
    expect(icons).toContain(".bi-beta::before {");
    expect(icons).not.toContain("bi-gamma");
    expect(icons).toContain("--ark-icon-alpha:");
    expect(icons).toContain("--ark-icon-beta:");
    expect(icons).not.toContain("--ark-icon-gamma");
    expect(readRecord(workspace).icons).toEqual({kept: ["bi-alpha", "bi-beta"], unmapped: []});
  });

  test("--check passes on a fresh sync, with or without the design checkout", () => {
    expect(runSync(workspace)).toMatchObject({status: 0});
    expect(runSync(workspace, ["--check"])).toMatchObject({status: 0});
    const offline = spawnSync(process.execPath, [
      syncScript,
      "--check",
      "--repository", workspace.repository,
      "--source", path.join(workspace.root, "no-design-checkout"),
    ], {encoding: "utf8"});
    expect(offline.status).toBe(0);
    expect(offline.stdout).toContain("verified the vendored tree against SOURCE.json");
  });

  test("--check fails when a vendored file drifts from its recorded hash", () => {
    expect(runSync(workspace)).toMatchObject({status: 0});
    write(path.join(workspace.repository, "apps/web/src/arkcase"), "components/feedback/Spinner.jsx",
      "export function Spinner() { return 'edited'; }\n");
    const checked = runSync(workspace, ["--check"]);
    expect(checked.status).toBe(1);
    expect(checked.output).toContain("components/feedback/Spinner.jsx differs from its recorded SHA-256.");
  });

  test("--check regenerates from the pinned commit and fails on a re-hashed hand edit", () => {
    expect(runSync(workspace)).toMatchObject({status: 0});
    handEdit(workspace, "components/feedback/Spinner.jsx", "export function Spinner() { return 'edited'; }\n");
    const checked = runSync(workspace, ["--check"]);
    expect(checked.status).toBe(1);
    expect(checked.output).toContain("components/feedback/Spinner.jsx differs from what the pinned source produces");
  });

  test("a leftover style element fails both the sync and --check", () => {
    writeEntries(workspace.repository, ["actions/Button.jsx", "data-display/ListCard.jsx"]);
    const refused = runSync(workspace);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("components/data-display/ListCard.jsx renders a JSX <style> element");

    writeEntries(workspace.repository, ["actions/Button.jsx"]);
    expect(runSync(workspace)).toMatchObject({status: 0});
    handEdit(workspace, "components/feedback/Spinner.jsx",
      "export function Spinner() { const s = document.createElement('style'); return s; }\n");
    const checked = runSync(workspace, ["--check"]);
    expect(checked.status).toBe(1);
    expect(checked.output).toContain("components/feedback/Spinner.jsx creates a style element outside akStyleDocument.");
  });

  test("--check fails when application code uses an icon the pruned sheet lacks", () => {
    expect(runSync(workspace)).toMatchObject({status: 0});
    write(workspace.repository, "apps/web/src/review/new-icon.tsx", "export const icon = \"bi-gamma\";\n");
    const checked = runSync(workspace, ["--check"]);
    expect(checked.status).toBe(1);
    expect(checked.output).toContain("tokens/icons.css lacks referenced icon classes bi-gamma");
    expect(runSync(workspace)).toMatchObject({status: 0});
    expect(vendored(workspace, "tokens/icons.css")).toContain(".bi-gamma::after {");
  });

  test("an icon the design system does not define is refused", () => {
    write(workspace.repository, "apps/web/src/review/typo.tsx", "export const icon = \"bi-alhpa\";\n");
    const refused = runSync(workspace);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("icon classes the design system does not define: bi-alhpa");
  });

  test("imports outside the component tree and uncommitted design changes are refused", () => {
    writeEntries(workspace.repository, ["escape/Outside.jsx"]);
    const escaped = runSync(workspace);
    expect(escaped.status).toBe(1);
    expect(escaped.output).toContain("which is outside arkcase/project/components");

    writeEntries(workspace.repository, ["actions/Button.jsx"]);
    write(workspace.design, "arkcase/project/components/feedback/Spinner.jsx", "export function Spinner() { return 1; }\n");
    const dirty = runSync(workspace);
    expect(dirty.status).toBe(1);
    expect(dirty.output).toContain("has uncommitted design-system changes");
  });
});
