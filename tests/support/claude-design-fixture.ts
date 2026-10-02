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

/** Portable card exports carry their gallery metadata in a leading HTML comment. */
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

/** A decodable 16 × 10 JPEG cover and PNG thumbnail, small enough to inline. */
export const fixtureCoverJpeg = Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAACgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACgAQAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/Syiiiv5XP4rP//Z", "base64");
/** The smallest valid lossless WebP (1 × 1). */
export const fixtureThumbnailWebp = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
export const fixtureThumbnailPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAACgAAAAAeBf7RAAAAHklEQVQoFWNk+M9Qz0ABYKJAL1jrqAEMDKNhwMAAAOINAZLMvqZfAAAAAElFTkSuQmCC", "base64");

/**
 * A producer-declared gallery like the ArkCase Design repository generates: project
 * prototypes, a reusable template, a component card, an extensionless Claude cover
 * and one directly referenced PNG thumbnail.
 */
export async function writePreviewSourceFixture(directory: string): Promise<string> {
  const root = await writeDesignCardFixture(directory, true);
  await mkdir(path.join(directory, "project/thumbnails"), {recursive: true});
  await Promise.all([
    writeFile(path.join(directory, "project/App.dc.html"), '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Examiner app</h1><button>Try button</button><output>Ready</output><script src="support.js"></script></body></html>'),
    writeFile(path.join(directory, "project/Portal.dc.html"), "<!doctype html><h1>Claimant portal</h1>"),
    writeFile(path.join(directory, "project/.thumbnail"), fixtureCoverJpeg),
    writeFile(path.join(directory, "project/thumbnails/app.png"), fixtureThumbnailPng),
    writeFile(path.join(directory, "project/thumbnails/button.webp"), fixtureThumbnailWebp),
    writeFile(path.join(directory, "project/components/Button.README.md"), "# Button\n\nUse one primary button per view.\n"),
    writeFile(path.join(directory, "project/components/Button.tokens.md"), "# Button tokens\n\nPrimary fill uses the brand green.\n"),
    writeFile(path.join(directory, "artifactserver.previews.json"), JSON.stringify(previewSourceFixture(), null, 2)),
  ]);
  return root;
}

export function previewSourceFixture() {
  return {
    format: "artifact-server.preview-source",
    version: 2,
    title: "Claims Workspace",
    description: "Examiner app, portal and starter screens.",
    cover: "project/.thumbnail",
    items: [
      {kind: "prototype", section: "Prototypes", title: "Examiner App", description: "Claim record with panels.", path: "project/App.dc.html", viewport: {width: 1440, height: 900}, thumbnail: "project/thumbnails/app.png"},
      {kind: "prototype", section: "Portal", title: "Claimant Portal", path: "project/Portal.dc.html"},
      {kind: "template", section: "Starter templates", title: "Screen", description: "A complete screen", path: "project/templates/Screen.dc.html", viewport: {width: 1100, height: 900}},
      {kind: "component", section: "Actions", title: "Primary button", description: "An interactive component", path: "project/components/buttons.card.html", viewport: {width: 640, height: 110}, thumbnail: "project/thumbnails/button.webp", related: [{title: "Button guide", path: "project/components/Button.README.md"}, {title: "Button tokens", path: "project/components/Button.tokens.md"}]},
    ],
  };
}
