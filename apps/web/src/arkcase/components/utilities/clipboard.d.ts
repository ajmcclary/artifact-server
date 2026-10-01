/**
 * The one clipboard write every copy control shares. Resolves `true` once the text is on the
 * clipboard and `false` when the browser refuses — no Clipboard API, an insecure context or a
 * denied permission — so a host never confirms a copy that did not happen. Never throws; a
 * `null` or `undefined` text resolves `false` without touching the clipboard.
 */
export function writeClipboard(text: string | number | null | undefined): Promise<boolean>;
