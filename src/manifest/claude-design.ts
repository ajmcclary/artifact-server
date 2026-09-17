import {Schema} from "effect";

import {parseManifestPath} from "./create-manifest.js";

/** The extra immutable entry page created for a recognized Claude export. */
export const claudeDesignCatalogPath = "artifact-server-design.html";

const cardSchema = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  group: Schema.optional(Schema.String),
  subtitle: Schema.optional(Schema.String),
  viewport: Schema.optional(Schema.String),
});
const templateSchema = Schema.Struct({
  entryPath: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
});
const designSystemSchema = Schema.Struct({
  namespace: Schema.NonEmptyString,
  cards: Schema.Array(cardSchema),
  templates: Schema.optional(Schema.Array(templateSchema)),
});

interface DesignPreview {
  readonly path: string;
  readonly name: string;
  readonly group: string;
  readonly description: string;
  readonly width: number;
  readonly height: number;
}

/** Recognize the two observed export layouts without searching unrelated subtrees. */
export function claudeDesignManifestPath(paths: readonly string[]): string | undefined {
  return ["_ds_manifest.json", "project/_ds_manifest.json"]
    .find((candidate) => paths.includes(candidate));
}

/** Build a deterministic catalog using only paths present in the publication. */
export function createClaudeDesignCatalog(
  paths: readonly string[],
  manifestPath?: string,
  manifestText?: string,
): string | undefined {
  if (manifestPath !== undefined && manifestText !== undefined) {
    const manifest = Schema.decodeUnknownSync(designSystemSchema)(JSON.parse(manifestText));
    const prefix = manifestPath.slice(0, -"_ds_manifest.json".length);
    const cards = manifest.cards.map((card): DesignPreview => ({
      path: previewPath(prefix, card.path, paths),
      name: card.name,
      group: card.group ?? "Components",
      description: card.subtitle ?? "",
      ...viewport(card.viewport),
    }));
    const templates = (manifest.templates ?? []).map((template): DesignPreview => ({
      path: previewPath(prefix, template.entryPath, paths),
      name: template.name,
      group: "Templates",
      description: template.description ?? "",
      width: 1280,
      height: 900,
    }));
    return renderCatalog("Claude Design System", manifest.namespace, [...cards, ...templates]);
  }
  const artboards = paths.filter((candidate) => candidate.endsWith(".dc.html"));
  if (artboards.length === 0) return undefined;
  return renderCatalog("Claude Design Project", "Artboards", artboards.map((candidate) => ({
    path: candidate,
    name: candidate.split("/").at(-1)?.slice(0, -".dc.html".length) ?? candidate,
    group: "Artboards",
    description: candidate,
    width: 1280,
    height: 900,
  })));
}

function previewPath(prefix: string, candidate: string, paths: readonly string[]): string {
  // Validate before joining: normalizing '..' would conceal an escaping reference.
  const relativePath = parseManifestPath(candidate);
  const result = `${prefix}${relativePath}`;
  if (!/\.html?$/iu.test(result) || !paths.includes(result)) {
    throw new Error("Claude Design preview must reference a published HTML file.");
  }
  return result;
}

function viewport(value: string | undefined) {
  const match = /^(\d{1,4})x(\d{1,4})$/u.exec(value ?? "");
  return {
    width: Math.min(4096, Math.max(1, Number(match?.[1] ?? 1100))),
    height: Math.min(4096, Math.max(1, Number(match?.[2] ?? 700))),
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderCatalog(kind: string, title: string, previews: readonly DesignPreview[]): string {
  if (previews.length === 0) throw new Error("Claude Design export has no previews or templates.");
  const groups = [...new Set(previews.map((preview) => preview.group))];
  const navigation = groups.map((group) => `<section><h2>${escapeHtml(group)}</h2>${previews
    .filter((preview) => preview.group === group)
    .map((preview) => `<a href="./${escapeHtml(preview.path.split("/").map(encodeURIComponent).join("/"))}" target="design-preview" data-width="${preview.width}" data-height="${preview.height}" data-description="${escapeHtml(preview.description)}">${escapeHtml(preview.name)}</a>`)
    .join("\n")}</section>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="artifact-server-preview" content="claude-design-catalog">
<title>${escapeHtml(title)} · ${kind}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f4;color:#202322;font:14px/1.5 system-ui,sans-serif}
header{padding:20px 28px;border-bottom:1px solid #d6dad7;background:white}header p{margin:0;color:#59635e}h1{font-size:24px;margin:4px 0;overflow-wrap:anywhere}
main{display:grid;grid-template-columns:280px minmax(0,1fr)}nav{padding:20px;max-height:calc(100vh - 125px);overflow:auto;background:#fff;border-right:1px solid #d6dad7}
label{display:block;font-weight:600}input{width:100%;padding:9px;border:1px solid #8b9690;border-radius:4px;margin:8px 0 16px;font:inherit}h2{font-size:12px;color:#59635e;margin:20px 0 6px}
nav a{display:block;padding:8px;border-radius:4px;color:inherit;text-decoration:none;overflow-wrap:anywhere}nav a:hover,nav a[aria-current=true]{background:#e6eee9;color:#174e35}a:focus-visible,input:focus-visible{outline:2px solid #174e35;outline-offset:2px}
article{min-width:0;padding:24px}article h2{font-size:20px;color:inherit;margin:0}#description{min-height:21px;color:#59635e}#open{color:#174e35}#stage{margin-top:20px;overflow:auto;border:1px solid #d6dad7;background:#e9eae8;padding:16px}iframe{display:block;border:0;background:white}small{color:#59635e}[hidden]{display:none!important}
@media(max-width:700px){main{grid-template-columns:1fr}nav{max-height:280px;border-right:0;border-bottom:1px solid #d6dad7}article{padding:16px}}
</style></head><body><header><p>${kind}</p><h1>${escapeHtml(title)}</h1><p>${previews.length} previews · original export files</p></header>
<main><nav aria-label="Design previews"><label for="search">Find a preview</label><input id="search" type="search" placeholder="Name or group"><p id="empty" hidden>No matching previews.</p>${navigation}</nav>
<article><h2 id="selected">Select a preview</h2><p id="description"></p><a id="open" target="_self">Open full preview</a> · <small id="size"></small><div id="stage"><iframe name="design-preview" title="Design preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"></iframe></div></article></main>
<script>
const links = Array.from(document.querySelectorAll('nav a'));
const frame = document.querySelector('iframe');
function select(link) {
  for (const item of links) item.removeAttribute('aria-current');
  link.setAttribute('aria-current', 'true');
  document.getElementById('selected').textContent = link.textContent;
  document.getElementById('description').textContent = link.dataset.description;
  document.getElementById('open').href = link.href;
  frame.title = link.textContent;
  frame.width = link.dataset.width;
  frame.height = link.dataset.height;
  document.getElementById('size').textContent = frame.width + ' × ' + frame.height;
}
for (const link of links) link.addEventListener('click', () => select(link));
document.getElementById('search').addEventListener('input', (event) => {
  const query = event.target.value.toLocaleLowerCase();
  for (const section of document.querySelectorAll('nav section')) {
    for (const link of section.querySelectorAll('a')) link.hidden = !(link.textContent + ' ' + section.querySelector('h2').textContent).toLocaleLowerCase().includes(query);
    section.hidden = Array.from(section.querySelectorAll('a')).every(link => link.hidden);
  }
  document.getElementById('empty').hidden = links.some(link => !link.hidden);
});
select(links[0]); frame.src = links[0].href;
</script></body></html>\n`;
}
