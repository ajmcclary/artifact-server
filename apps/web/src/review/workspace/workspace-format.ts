/** A short, stable label for a prefixed identifier (`ver_…` loses its prefix). */
export function compactId(value: string): string {
  const unprefixed = value.startsWith("ver_") ? value.slice(4) : value;
  return unprefixed.slice(0, 8);
}
