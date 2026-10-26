const invisibleDirectivePattern =
  /[‪-‮⁦-⁩​-‏⁠﻿]/gu;

/**
 * Strip bidirectional-override and invisible Unicode from one piece of
 * untrusted human text. Pure and idempotent; every visible character passes
 * through unchanged.
 */
export function stripInvisibleControls(text: string): string {
  return text.replace(invisibleDirectivePattern, "");
}
