import {readFile} from "node:fs/promises";

import {describe, expect, test} from "vitest";

import {designDocumentSchemas} from "../../scripts/write-design-document-schemas.js";

describe("published design document schemas", () => {
  test("match the validators they are generated from", async () => {
    const generated = designDocumentSchemas();
    const committed = Object.fromEntries(await Promise.all(Object.keys(generated).map(async (path) => {
      const text = await readFile(path, "utf8");
      const parsed: unknown = JSON.parse(text);
      return [path, parsed] as const;
    })));
    expect(committed).toEqual(generated);
  });
});
