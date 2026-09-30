/**
 * The document the vendored ArkCase components inject runtime styles through.
 *
 * `scripts/sync-arkcase-ds.mjs` rewrites `document.getElementById(`,
 * `document.createElement(` and `document.head.appendChild(` to this object in
 * every vendored file that injects a style element. A `<style>` element would
 * be blocked by the application's `style-src 'self'` policy, so a created
 * style is an in-memory handle, and appending it adopts its text as a
 * constructable stylesheet, which that policy allows. Every other call reaches
 * the real document unchanged.
 */

/** A style element that exists only until it is appended. */
export class ArkStyleHandle {
  id = "";
  textContent: string | null = null;
}

export type ArkStyleNode = ArkStyleHandle | Node;

export interface ArkStyleDocument {
  createElement(tagName: string): ArkStyleHandle | HTMLElement;
  getElementById(id: string): ArkStyleHandle | HTMLElement | null;
  readonly head: {appendChild(node: ArkStyleNode): ArkStyleNode};
}

const adopted = new Map<string, ArkStyleHandle>();

function adopt(handle: ArkStyleHandle): void {
  if (handle.id !== "" && adopted.has(handle.id)) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(handle.textContent ?? "");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  if (handle.id !== "") adopted.set(handle.id, handle);
}

export const akStyleDocument: ArkStyleDocument = {
  createElement(tagName) {
    return tagName.toLowerCase() === "style" ? new ArkStyleHandle() : document.createElement(tagName);
  },
  getElementById(id) {
    return adopted.get(id) ?? document.getElementById(id);
  },
  head: {
    appendChild(node) {
      if (node instanceof ArkStyleHandle) {
        adopt(node);
        return node;
      }
      return document.head.appendChild(node);
    },
  },
};

/** The ids adopted so far, in adoption order. */
export function adoptedStyleIds(): readonly string[] {
  return [...adopted.keys()];
}
