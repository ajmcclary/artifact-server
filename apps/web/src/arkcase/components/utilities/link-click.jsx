/**
 * ArkCase isModifiedClick — the one test every link-or-button row makes before it handles a
 * click itself. A modified or non-primary click (Cmd/Ctrl for a new tab, Shift for a new window,
 * Alt to download, the middle or right button) belongs to the browser: the row lets the native
 * link follow its `href` and selects nothing. A plain primary click is the row's to handle
 * (`preventDefault()` and select). Promoted from SideNav's private `leftToBrowser` and the
 * ArkCase Artifacts Library's `plainClick`, which were the same test inverted.
 */
export const isModifiedClick = (event) => !!(event && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey));
