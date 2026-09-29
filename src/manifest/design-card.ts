import {Schema} from "effect";

const designCardSchema = Schema.Struct({
  path: Schema.String,
  name: Schema.NonEmptyString,
  group: Schema.optional(Schema.NonEmptyString),
  subtitle: Schema.optional(Schema.String),
  viewport: Schema.optional(Schema.String.check(Schema.isPattern(/^[1-9]\d{0,3}x[1-9]\d{0,3}$/u))),
});

export type DesignCard = typeof designCardSchema.Type;

/** Read the leading export annotation as data; never evaluate preview source. */
export function parseDesignCard(filePath: string, source: string): DesignCard {
  const annotation = /^\s*<!--\s*@dsCard\b([\s\S]*?)-->/u.exec(source);
  if (annotation === null && /^\s*<!--\s*@dsCard\b/u.test(source)) {
    throw new Error(`Unterminated @dsCard annotation in ${filePath}.`);
  }
  const attributes = new Map<string, string>();
  let remaining = annotation?.[1]?.trim() ?? "";
  while (remaining.length > 0) {
    const attribute = /^(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')(?:\s+|$)/u.exec(remaining);
    if (attribute === null) throw new Error(`Malformed @dsCard annotation in ${filePath}.`);
    const key = attribute[1] ?? "";
    if (attributes.has(key)) throw new Error(`Duplicate @dsCard attribute in ${filePath}: ${key}.`);
    attributes.set(key, attribute[2] ?? attribute[3] ?? "");
    remaining = remaining.slice(attribute[0].length);
  }
  return Schema.decodeUnknownSync(designCardSchema)({
    ...Object.fromEntries(attributes),
    path: filePath,
    name: attributes.get("name") ?? filePath.split("/").at(-1)?.slice(0, -".card.html".length),
  });
}
