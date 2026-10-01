/**
 * ArkCase writeClipboard — the one clipboard write every copy control shares. It resolves
 * `true` once the text is on the clipboard and `false` when the browser refuses (no Clipboard
 * API, an insecure context, a denied permission), so a host never confirms a copy that did
 * not happen. It never throws and never touches the DOM beyond the Clipboard API.
 */
export async function writeClipboard(text) {
  if (text == null) return false;
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return false;
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch (_error) {
    return false;
  }
}
