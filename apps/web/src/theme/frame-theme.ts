/**
 * ArkCase design tokens mapped onto the token names @plannotator/ui's
 * stylesheet reads inside the isolated review frame. The frame writes every
 * received token onto its own :root, so the viewer chrome and the sandboxed
 * artifact's comment surfaces follow the shell's theme.
 */
const tokenSources = [
  ["--accent", "--tint-primary-selected"],
  ["--accent-foreground", "--text-body"],
  ["--background", "--surface-card"],
  ["--border", "--border-color"],
  ["--card", "--surface-card"],
  ["--card-foreground", "--text-body"],
  ["--code-bg", "--surface-secondary"],
  ["--destructive", "--bs-danger"],
  ["--destructive-foreground", "--text-on-primary"],
  ["--focus-highlight", "--tint-primary-selected"],
  ["--font-mono", "--font-data"],
  ["--font-sans", "--font-sans"],
  ["--foreground", "--text-body"],
  ["--input", "--border-color-strong"],
  ["--muted", "--surface-secondary"],
  ["--muted-foreground", "--text-secondary"],
  ["--popover", "--surface-card"],
  ["--popover-foreground", "--text-body"],
  ["--primary", "--bs-primary"],
  ["--primary-foreground", "--text-on-primary"],
  ["--radius", "--radius-md"],
  ["--ring", "--bs-primary"],
  ["--secondary", "--surface-tertiary"],
  ["--secondary-foreground", "--text-body"],
  ["--success", "--bs-success"],
  ["--success-foreground", "--text-strong"],
  ["--warning", "--bs-warning"],
  ["--warning-foreground", "--text-strong"],
] as const;

/** The resolved ArkCase values for the frame, skipping any token the sheet does not define. */
export function arkcaseFrameTokens(root: HTMLElement = document.documentElement): Record<string, string> {
  const style = getComputedStyle(root);
  const tokens = new Map<string, string>();
  for (const [target, source] of tokenSources) {
    const value = style.getPropertyValue(source).trim();
    if (value !== "") tokens.set(target, value);
  }
  return Object.fromEntries(tokens);
}

/** Plannotator's `light` class: every ArkCase theme but Dark paints light surfaces. */
export function frameIsLight(root: HTMLElement = document.documentElement): boolean {
  return root.dataset["theme"] !== "dark";
}
