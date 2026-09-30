import {NAV_BOOT_WIDTH_KEY, navigationWidth} from "./shell-layout-keys.ts";

/**
 * Before first paint, size the loading skeleton's navigation column like the
 * pinned navigation that replaces it, instead of a rail that then jumps open.
 * The key holds whole pixels only while the navigation is pinned.
 */
export function bootShellLayout(root: HTMLElement, storage: Storage): void {
  const stored = Number.parseInt(storage.getItem(NAV_BOOT_WIDTH_KEY) ?? "", 10);
  if (Number.isNaN(stored)) return;
  const width = Math.min(navigationWidth.maximum, Math.max(navigationWidth.minimum, stored));
  root.dataset["navPinned"] = "true";
  root.style.setProperty("--boot-nav-width", `${width}px`);
}
