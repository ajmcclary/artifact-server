const invisibleDirectivePattern =
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF]/gu;

/**
 * Strip bidirectional-override and invisible Unicode from one piece of
 * untrusted human text. Pure and idempotent; every visible character passes
 * through unchanged.
 */
export function stripInvisibleControls(text: string): string {
  return text.replace(invisibleDirectivePattern, "");
}
