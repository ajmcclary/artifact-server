// Vendors the ArkCase design system into apps/web/src/arkcase and verifies
// that tree. `node scripts/sync-arkcase-ds.mjs` regenerates it from a pinned,
// committed design-system checkout; `--check` proves the checked-in tree is
// exactly what that sync produced, without needing the checkout.
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {z} from "zod";

const GENERATOR = "scripts/sync-arkcase-ds.mjs";
const ENTRIES_FILE = "scripts/arkcase-ds-entries.json";
const VENDOR_DIRECTORY = "apps/web/src/arkcase";
const WEB_DIRECTORY = "apps/web";
const COMPONENTS_ROOT = "arkcase/project/components";
const TOKENS_ROOT = "arkcase/project/tokens";
const BRAND_ROOT = "arkcase/project/assets/brand";
const TOKEN_SHEETS = [
  "fonts.css",
  "icons.css",
  "colors.css",
  "typography.css",
  "spacing.css",
  "elevation.css",
  "base.css",
];
const FONT_FILE = /(?:\.woff2|-OFL\.txt)$/u;
const RUNTIME_MODULE = /\.jsx?$/u;
const SCANNED_SOURCE = /\.(?:css|html|jsx?|tsx?)$/u;
const ALLOWED_PACKAGES = new Set(["react"]);
const IMPORT_SPECIFIER =
  /\b(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu;
const DOCUMENT_STYLE_ELEMENT = /(?<![\w$.])document\.createElement\(\s*['"]style['"]\s*\)/u;
const DOCUMENT_STYLE_CALL = /(?<![\w$.])document\.(getElementById|createElement|head\.appendChild)\(/gu;
const UNREWRITTEN_STYLE_ELEMENT = /(?<!akStyleDocument\.)createElement\(\s*['"]style['"]/u;
const JSX_STYLE_ELEMENT = /<style[\s>]/u;
const STYLE_IMPORT = "import { akStyleDocument } from '@/arkcase-style';\n";
const ICON_CLASS = /\bbi-[a-z0-9]+(?:-[a-z0-9]+)*/gu;
const ICON_VARIABLE_USE = /var\((--[a-z0-9-]+)/gu;
const ICON_RULE = /((?:\/\*[\s\S]*?\*\/\s*)*)([^{}]+?)\s*\{([^{}]*)\}/gu;
const DECLARED_EXPORT =
  /^export\s+(?:declare\s+)?(function|const|let|class|enum|namespace|interface|type)\s+([A-Za-z_$][\w$]*)/gmu;
const VALUE_KINDS = new Set(["class", "const", "enum", "function", "let"]);

const entriesSchema = z.object({
  brand: z.array(z.string().regex(/^[a-z0-9-]+\.svg$/u)).min(1),
  components: z.array(z.string().regex(/^[a-z-]+\/[A-Za-z0-9-]+\.jsx?$/u)).min(1),
  reviewUi: z.string().regex(/^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.jsx$/u),
}).strict();

const sourceRecordSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  entriesSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  files: z.record(z.string(), z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    source: z.string().nullable(),
  }).strict()),
  generator: z.literal(GENERATOR),
  icons: z.object({
    kept: z.array(z.string()),
    unmapped: z.array(z.string()),
  }).strict(),
  repository: z.string().min(1),
}).strict();

class SyncFailure extends Error {}

function fail(message) {
  throw new SyncFailure(message);
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

/** Code-point order, so every platform and locale writes the same files. */
function byText(left, right) {
  return left < right ? -1 : Number(left > right);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sameBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function parseArguments(argv) {
  const options = {
    check: false,
    repository: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    source: process.env["ARKCASE_DESIGN_ROOT"] ?? path.join(homedir(), "Dev", "Design"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
    } else if (argument === "--source" || argument === "--repository") {
      const value = argv[index + 1];
      if (value === undefined) fail(`${argument} needs a directory.`);
      options[argument.slice(2)] = path.resolve(value);
      index += 1;
    } else {
      fail(`unknown argument ${argument}; usage is sync-arkcase-ds.mjs [--check] [--source <dir>] [--repository <dir>].`);
    }
  }
  return options;
}

function git(source, argumentsList) {
  return execFileSync("git", ["-C", source, ...argumentsList], {encoding: "utf8"}).trim();
}

function listFiles(directory, skip) {
  const found = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      const absolute = path.join(current, entry.name);
      if (skip.has(absolute) || entry.name === "node_modules") continue;
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) found.push(absolute);
    }
  }
  return found.toSorted(byText);
}

function importSpecifiers(text) {
  return [...text.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? match[2]);
}

/** Walks relative imports from the entries; every file must stay inside `root`. */
function importClosure(root, entries, label) {
  const files = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const relative = pending.pop();
    if (files.has(relative)) continue;
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) fail(`${label}/${relative} does not exist.`);
    files.add(relative);
    for (const specifier of importSpecifiers(readFileSync(absolute, "utf8"))) {
      if (!specifier.startsWith(".")) {
        if (!ALLOWED_PACKAGES.has(specifier)) {
          fail(`${label}/${relative} imports ${specifier}; vendored code may import only react.`);
        }
        continue;
      }
      const target = toPosix(path.relative(root, path.resolve(path.dirname(absolute), specifier)));
      if (target.startsWith("..") || path.isAbsolute(target)) {
        fail(`${label}/${relative} imports ${specifier}, which is outside ${label}.`);
      }
      pending.push(target);
    }
  }
  return [...files].toSorted(byText);
}

/** Contract correction 3: runtime style injection goes through akStyleDocument. */
function rewriteStyleInjection(text) {
  if (!DOCUMENT_STYLE_ELEMENT.test(text)) return text;
  return STYLE_IMPORT + text.replace(DOCUMENT_STYLE_CALL, "akStyleDocument.$1(");
}

function styleProblems(file, text) {
  const problems = [];
  if (UNREWRITTEN_STYLE_ELEMENT.test(text)) {
    problems.push(`${file} creates a style element outside akStyleDocument.`);
  }
  if (JSX_STYLE_ELEMENT.test(text)) {
    problems.push(`${file} renders a JSX <style> element, which the application policy blocks.`);
  }
  return problems;
}

function iconClasses(text) {
  return new Set(text.match(ICON_CLASS) ?? []);
}

function parseIconSheet(css) {
  const rootStart = css.indexOf(":root {");
  const rootEnd = css.indexOf("\n}", rootStart);
  if (rootStart < 0 || rootEnd < 0) fail("icons.css has no :root block.");
  const variables = css.slice(rootStart + ":root {".length, rootEnd)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = /^\s*(--[a-z0-9-]+):/u.exec(line);
      if (match === null) fail(`icons.css :root has an unexpected line: ${line.slice(0, 80)}`);
      return {line, name: match[1]};
    });
  const body = css.slice(rootEnd + 2);
  if (body.replace(ICON_RULE, "").trim() !== "") {
    fail("icons.css has content outside plain rules; the pruner cannot keep it safely.");
  }
  const rules = [...body.matchAll(ICON_RULE)].map((match) => ({
    block: match[3],
    comment: match[1],
    selectors: match[2].split(",").map((selector) => selector.trim()),
  }));
  return {header: css.slice(0, rootStart), rules, variables};
}

function definedIconClasses(css) {
  const defined = new Set();
  for (const rule of parseIconSheet(css).rules) {
    for (const selector of rule.selectors) {
      for (const name of iconClasses(selector)) defined.add(name);
    }
  }
  return defined;
}

/** Keeps structural rules, rules whose icon classes are all referenced, and the variables they use. */
function pruneIconSheet(css, referenced) {
  const sheet = parseIconSheet(css);
  const rules = sheet.rules
    .map((rule) => ({
      ...rule,
      selectors: rule.selectors.filter((selector) =>
        [...iconClasses(selector)].every((name) => referenced.has(name))),
    }))
    .filter((rule) => rule.selectors.length > 0);
  const used = new Set();
  for (const rule of rules) {
    for (const match of rule.block.matchAll(ICON_VARIABLE_USE)) used.add(match[1]);
  }
  const kept = new Set();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      for (const name of iconClasses(selector)) kept.add(name);
    }
  }
  const variables = sheet.variables.filter((variable) => used.has(variable.name));
  const text = `${sheet.header.trimEnd()}\n`
    + `/* Pruned by ${GENERATOR} to the ${kept.size} bi-* classes that application and vendored source reference. */\n\n`
    + `:root {\n${variables.map((variable) => variable.line).join("\n")}\n}\n`
    + rules.map((rule) => `\n${rule.comment}${rule.selectors.join(", ")} {${rule.block}}\n`).join("");
  return {kept: [...kept].toSorted(byText), text};
}

function applicationIconClasses(repository) {
  const vendor = path.join(repository, VENDOR_DIRECTORY);
  const web = path.join(repository, WEB_DIRECTORY);
  const files = [
    ...listFiles(path.join(web, "src"), new Set([vendor])),
    ...readdirSync(web).filter((name) => name.endsWith(".html")).map((name) => path.join(web, name)),
  ].filter((file) => SCANNED_SOURCE.test(file));
  const classes = new Set();
  for (const file of files) {
    for (const name of iconClasses(readFileSync(file, "utf8"))) classes.add(name);
  }
  return classes;
}

function vendoredIconClasses(files) {
  const classes = new Set();
  for (const [file, content] of files) {
    if (!file.startsWith("tokens/") && RUNTIME_MODULE.test(file)) {
      for (const name of iconClasses(content.toString())) classes.add(name);
    }
  }
  return classes;
}

function barrel(files, source) {
  const owners = new Map();
  const lines = [
    `// Generated by ${GENERATOR} from ${source.repository} at ${source.commit}. Do not edit.`,
    "// Values come from the vendored .jsx modules; types come from their shipped .d.ts files.",
  ];
  const declarations = [...files.keys()]
    .filter((file) => file.startsWith("components/") && file.endsWith(".d.ts"))
    .toSorted(byText);
  for (const declaration of declarations) {
    const moduleFile = [".jsx", ".js"]
      .map((extension) => declaration.replace(/\.d\.ts$/u, extension))
      .find((candidate) => files.has(candidate));
    if (moduleFile === undefined) fail(`${declaration} has no runtime module beside it.`);
    const kinds = new Map();
    for (const match of files.get(declaration).toString().matchAll(DECLARED_EXPORT)) {
      kinds.set(match[2], [...(kinds.get(match[2]) ?? []), match[1]]);
    }
    const values = [];
    const types = [];
    for (const [name, declaredKinds] of [...kinds].toSorted(([left], [right]) => byText(left, right))) {
      const owner = owners.get(name);
      if (owner !== undefined) fail(`${name} is exported by both ${owner} and ${moduleFile}.`);
      owners.set(name, moduleFile);
      if (declaredKinds.some((kind) => VALUE_KINDS.has(kind))) values.push(name);
      else types.push(name);
    }
    const specifier = `./${moduleFile}`;
    if (values.length > 0) lines.push(`export {${values.join(", ")}} from "${specifier}";`);
    if (types.length > 0) lines.push(`export type {${types.join(", ")}} from "${specifier}";`);
  }
  return `${lines.join("\n")}\n`;
}

function readme(source) {
  return [
    "# Vendored ArkCase design system",
    "",
    `Generated by \`${GENERATOR}\` from ${source.repository}. Do not edit anything in this`,
    "directory: change the design system upstream, commit it, and re-run the sync.",
    "",
    "- Refresh: `pnpm sync:arkcase-ds` reads `~/Dev/Design`, `ARKCASE_DESIGN_ROOT`, or `--source <dir>`.",
    "- Verify: `pnpm check:arkcase-ds` runs in `pnpm check` and needs no design checkout.",
    `- Entries: \`${ENTRIES_FILE}\` lists the components; their relative imports come along.`,
    "- `SOURCE.json` records the pinned commit and a SHA-256 for every file here.",
    "",
    "The sync copies the entry components with their `.d.ts` declarations, the",
    "project-owned review UI, the token sheets and fonts, and the brand marks. It",
    "routes runtime style injection through `akStyleDocument`",
    "(`apps/web/src/arkcase-style.ts`), which adopts constructable stylesheets that",
    "the application's `style-src 'self'` policy allows. It prunes",
    "`tokens/icons.css` to the `bi-*` classes that application and vendored source",
    "reference: use a new icon class, then re-run the sync.",
    "",
  ].join("\n");
}

function readEntries(repository) {
  const text = readFileSync(path.join(repository, ENTRIES_FILE), "utf8");
  return {entries: entriesSchema.parse(JSON.parse(text)), sha256: sha256(text)};
}

function designSource(sourceRoot, entries) {
  if (!existsSync(path.join(sourceRoot, COMPONENTS_ROOT))) return null;
  const reviewUiDirectory = path.posix.dirname(entries.reviewUi);
  const status = git(sourceRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    COMPONENTS_ROOT,
    TOKENS_ROOT,
    BRAND_ROOT,
    reviewUiDirectory,
  ]);
  return {
    clean: status === "",
    commit: git(sourceRoot, ["rev-parse", "HEAD"]),
    repository: git(sourceRoot, ["remote", "get-url", "origin"]),
    root: sourceRoot,
  };
}

/** Everything the vendored tree holds, keyed by path relative to it. */
function generate(repository, source, entries, entriesSha256) {
  const files = new Map();
  const origins = new Map();
  const add = (file, content, origin) => {
    files.set(file, content);
    origins.set(file, origin);
  };
  const componentsRoot = path.join(source.root, COMPONENTS_ROOT);
  for (const relative of importClosure(componentsRoot, entries.components, COMPONENTS_ROOT)) {
    const text = readFileSync(path.join(componentsRoot, relative), "utf8");
    add(`components/${relative}`, rewriteStyleInjection(text), `${COMPONENTS_ROOT}/${relative}`);
    const declaration = relative.replace(RUNTIME_MODULE, ".d.ts");
    if (existsSync(path.join(componentsRoot, declaration))) {
      add(`components/${declaration}`, readFileSync(path.join(componentsRoot, declaration), "utf8"),
        `${COMPONENTS_ROOT}/${declaration}`);
    }
  }
  const reviewUiDirectory = path.posix.dirname(entries.reviewUi);
  const reviewUiRoot = path.join(source.root, reviewUiDirectory);
  const reviewUiEntry = path.posix.basename(entries.reviewUi);
  const reviewUiFiles = [
    ...importClosure(reviewUiRoot, [reviewUiEntry], reviewUiDirectory),
    reviewUiEntry.replace(RUNTIME_MODULE, ".d.ts"),
  ];
  for (const relative of reviewUiFiles) {
    add(`review-ui/${relative}`, readFileSync(path.join(reviewUiRoot, relative), "utf8"),
      `${reviewUiDirectory}/${relative}`);
  }
  const tokensRoot = path.join(source.root, TOKENS_ROOT);
  for (const sheet of TOKEN_SHEETS) {
    add(`tokens/${sheet}`, readFileSync(path.join(tokensRoot, sheet), "utf8"), `${TOKENS_ROOT}/${sheet}`);
  }
  for (const font of readdirSync(path.join(tokensRoot, "fonts")).filter((name) => FONT_FILE.test(name)).toSorted(byText)) {
    add(`tokens/fonts/${font}`, readFileSync(path.join(tokensRoot, "fonts", font)), `${TOKENS_ROOT}/fonts/${font}`);
  }
  for (const mark of entries.brand) {
    add(`brand/${mark}`, readFileSync(path.join(source.root, BRAND_ROOT, mark), "utf8"), `${BRAND_ROOT}/${mark}`);
  }

  const problems = [...files]
    .filter(([file]) => RUNTIME_MODULE.test(file))
    .flatMap(([file, content]) => styleProblems(file, content.toString()));
  if (problems.length > 0) fail(problems.join("\n"));

  const fullIconSheet = files.get("tokens/icons.css");
  const defined = definedIconClasses(fullIconSheet);
  const application = applicationIconClasses(repository);
  const unknownInApplication = [...application].filter((name) => !defined.has(name)).toSorted(byText);
  if (unknownInApplication.length > 0) {
    fail(`application source uses icon classes the design system does not define: ${unknownInApplication.join(", ")}.`);
  }
  const vendored = vendoredIconClasses(files);
  const referenced = new Set([...application, ...vendored]);
  const pruned = pruneIconSheet(fullIconSheet, referenced);
  files.set("tokens/icons.css", pruned.text);
  const unmapped = [...vendored].filter((name) => !defined.has(name)).toSorted(byText);

  add("index.ts", barrel(files, source), null);
  add("README.md", readme(source), null);
  const record = {
    commit: source.commit,
    entriesSha256,
    files: Object.fromEntries([...files.keys()].toSorted(byText).map((file) => [
      file,
      {sha256: sha256(files.get(file)), source: origins.get(file)},
    ])),
    generator: GENERATOR,
    icons: {kept: pruned.kept, unmapped},
    repository: source.repository,
  };
  files.set("SOURCE.json", `${JSON.stringify(record, null, 2)}\n`);
  return files;
}

function sync(options) {
  const {entries, sha256: entriesSha256} = readEntries(options.repository);
  const source = designSource(options.source, entries);
  if (source === null) fail(`no ArkCase design system at ${options.source}; pass --source or set ARKCASE_DESIGN_ROOT.`);
  if (!source.clean) fail(`${options.source} has uncommitted design-system changes; commit them so the vendored tree can be pinned.`);
  const files = generate(options.repository, source, entries, entriesSha256);
  const vendor = path.join(options.repository, VENDOR_DIRECTORY);
  rmSync(vendor, {force: true, recursive: true});
  for (const [file, content] of files) {
    const target = path.join(vendor, file);
    mkdirSync(path.dirname(target), {recursive: true});
    writeFileSync(target, content);
  }
  process.stdout.write(`Vendored ${files.size} ArkCase files from ${source.commit} into ${VENDOR_DIRECTORY}.\n`);
}

function check(options) {
  const vendor = path.join(options.repository, VENDOR_DIRECTORY);
  const recordPath = path.join(vendor, "SOURCE.json");
  if (!existsSync(recordPath)) fail(`${VENDOR_DIRECTORY}/SOURCE.json is missing; run pnpm sync:arkcase-ds.`);
  const record = sourceRecordSchema.parse(JSON.parse(readFileSync(recordPath, "utf8")));
  const problems = [];
  const {entries, sha256: entriesSha256} = readEntries(options.repository);
  if (entriesSha256 !== record.entriesSha256) problems.push(`${ENTRIES_FILE} changed since the last sync.`);

  const onDisk = new Map(listFiles(vendor, new Set())
    .map((file) => [toPosix(path.relative(vendor, file)), readFileSync(file)])
    .filter(([file]) => file !== "SOURCE.json"));
  for (const file of Object.keys(record.files)) {
    if (!onDisk.has(file)) problems.push(`${file} is recorded in SOURCE.json but missing.`);
  }
  for (const [file, content] of onDisk) {
    const recorded = record.files[file];
    if (recorded === undefined) problems.push(`${file} is not produced by the sync.`);
    else if (recorded.sha256 !== sha256(content)) problems.push(`${file} differs from its recorded SHA-256.`);
    if (RUNTIME_MODULE.test(file)) problems.push(...styleProblems(file, content.toString()));
  }

  const iconSheet = onDisk.get("tokens/icons.css");
  if (iconSheet !== undefined) {
    const available = definedIconClasses(iconSheet.toString());
    const unmapped = new Set(record.icons.unmapped);
    const referenced = new Set([...applicationIconClasses(options.repository), ...vendoredIconClasses(onDisk)]);
    const missing = [...referenced].filter((name) => !available.has(name) && !unmapped.has(name)).toSorted(byText);
    if (missing.length > 0) {
      problems.push(`tokens/icons.css lacks referenced icon classes ${missing.join(", ")}; run pnpm sync:arkcase-ds.`);
    }
  }

  const source = designSource(options.source, entries);
  if (source === null) {
    process.stdout.write(`No design checkout at ${options.source}; verified the vendored tree against SOURCE.json.\n`);
  } else if (source.commit !== record.commit || !source.clean) {
    process.stdout.write(`Design checkout is at ${source.commit}${source.clean ? "" : " with uncommitted changes"}; the vendored tree is pinned to ${record.commit} and was not regenerated.\n`);
  } else if (problems.length === 0) {
    const expected = generate(options.repository, source, entries, entriesSha256);
    for (const [file, content] of expected) {
      const actual = file === "SOURCE.json" ? readFileSync(recordPath) : onDisk.get(file);
      if (actual === undefined || !sameBytes(actual, content)) {
        problems.push(`${file} differs from what the pinned source produces; run pnpm sync:arkcase-ds.`);
      }
    }
  }
  if (problems.length > 0) fail(problems.join("\n"));
  process.stdout.write(`ArkCase vendored tree matches ${record.commit} (${onDisk.size} files).\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.check) check(options);
  else sync(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sync-arkcase-ds: ${message}\n`);
  process.exitCode = 1;
}
