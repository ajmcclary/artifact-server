import {mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

import {Schema} from "effect";

import {provenanceRecordSchema} from "../src/manifest/provenance-record.js";
import {viewsDocumentSchema} from "../src/manifest/views-document.js";

/**
 * JSON Schemas a producer such as Design checks its generated documents
 * against before publishing. Semantic rules (paths published in the version,
 * unique ids, digest matches) are enforced by Artifact Server on read.
 */
export function designDocumentSchemas() {
  return {
    "docs/schemas/artifact-server.source-provenance.v1.schema.json":
      jsonSchema(provenanceRecordSchema, "artifact-server.source-provenance.v1"),
    "docs/schemas/artifact-server.views.v1.schema.json":
      jsonSchema(viewsDocumentSchema, "artifact-server.views.v1"),
  };
}

function jsonSchema(schema: Schema.Constraint, id: string) {
  // Match the validators, which decode with onExcessProperty: "error".
  const document = Schema.toJsonSchemaDocument(schema, {onExcessProperty: "error"});
  return {
    $defs: document.definitions,
    $id: `urn:artifact-server:schema:${id}`,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const schemas = designDocumentSchemas();
  await mkdir("docs/schemas", {recursive: true});
  await Promise.all(Object.entries(schemas).map(([file, schema]) =>
    writeFile(file, `${JSON.stringify(schema, null, 2)}\n`)
  ));
}
