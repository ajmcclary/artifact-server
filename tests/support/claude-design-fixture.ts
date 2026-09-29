import {mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import path from "node:path";

/** Small dependency-free exports with the layouts used by ArkCase and Apple Systems. */
export async function writeClaudeDesignFixture(directory: string, nested = false): Promise<string> {
  const root = nested ? path.join(directory, "project") : directory;
  await mkdir(path.join(root, "components"), {recursive: true});
  await mkdir(path.join(root, "templates"), {recursive: true});
  await Promise.all([
    writeFile(path.join(root, "_ds_manifest.json"), JSON.stringify({
      namespace: "Example_System",
      cards: [{path: "components/card-button.html", name: "Primary button", group: "Actions", viewport: "640x110", subtitle: "An interactive component"}],
      templates: [{entryPath: "templates/Screen.dc.html", name: "Screen", description: "A complete screen"}],
    })),
    writeFile(path.join(root, "styles.css"), "button { background: rgb(20, 90, 60); color: white; }"),
    writeFile(path.join(root, "support.js"), "document.querySelector('button').onclick = () => { document.querySelector('output').textContent = 'Clicked'; };"),
    writeFile(path.join(root, "components/card-button.html"), '<!doctype html><html><head><link rel="stylesheet" href="../styles.css"></head><body><button>Try button</button><output>Ready</output><script src="../support.js"></script></body></html>'),
    writeFile(path.join(root, "templates/Screen.dc.html"), '<!doctype html><h1>Template screen</h1>'),
    writeFile(path.join(root, "font.woff2"), "font fixture bytes"),
  ]);
  return root;
}

/** Portable card exports carry their catalog metadata in a leading HTML comment. */
export async function writeDesignCardFixture(directory: string, nested = false): Promise<string> {
  const root = await writeClaudeDesignFixture(directory, nested);
  await rm(path.join(root, "_ds_manifest.json"));
  const original = path.join(root, "components/card-button.html");
  const card = path.join(root, "components/buttons.card.html");
  await rename(original, card);
  await writeFile(card, `<!-- @dsCard group="Actions" viewport="640x110" name="Primary button" subtitle="An interactive component" -->\n${await readFile(card, "utf8")}`);
  await writeFile(path.join(root, "components/plain.card.html"), "<!doctype html><h1>Plain component</h1>");
  return root;
}
