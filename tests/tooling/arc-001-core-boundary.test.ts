import {glob, readFile} from "node:fs/promises";
import path from "node:path";

import {describe, expect, test} from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

/**
 * The only packages product logic may reach: the Effect runtime, pure
 * Node primitives, and pure data libraries. A database, blob store, login
 * provider, background-job system, Git provider, HTTP framework, MCP SDK, or
 * deployment framework is an infrastructure provider and belongs in an
 * adapter.
 */
const permittedPackages = new Set([
  "effect",
  "node:crypto",
  "node:path",
  "unicode-case-folding",
  "zod",
]);

/** Directories that hold concrete adapters, runtimes, and entry points. */
const adapterDirectories = [
  "src/cli/",
  "src/client/",
  "src/deployment/",
  "src/external-storage/",
  "src/http/",
  "src/identity/",
  "src/lifecycle/",
  "src/local/",
  "src/mcp/",
  "src/storage/",
];

const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(?\s*)"([^"]+)"/gu;

function specifiersOf(source: string): readonly string[] {
  return [...source.matchAll(importSpecifier)].map((match) => match[1] ?? "");
}

function resolveRelative(fromFile: string, specifier: string): string {
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  ).replace(/\.js$/u, ".ts");
}

/**
 * Follows every import reachable from the product core and reports each
 * package or adapter module it reaches that product logic may not depend on.
 */
function boundaryViolations(
  roots: readonly string[],
  sources: ReadonlyMap<string, string>,
): readonly string[] {
  const violations = new Set<string>();
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop() ?? "";
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of specifiersOf(sources.get(file) ?? "")) {
      if (specifier.startsWith(".")) {
        const target = resolveRelative(file, specifier);
        if (adapterDirectories.some((directory) => target.startsWith(directory))) {
          violations.add(`${file} -> ${target}`);
        } else {
          pending.push(target);
        }
      } else if (!permittedPackages.has(specifier)) {
        violations.add(`${file} -> ${specifier}`);
      }
    }
  }
  return [...violations].toSorted();
}

describe("product core dependency boundary", () => {
  test("ARC-001-F: product core never reaches a concrete infrastructure provider or deployment framework", async () => {
    const sources = new Map<string, string>();
    for await (const relativePath of glob("src/**/*.ts", {cwd: repositoryRoot})) {
      const posixPath = relativePath.split(path.sep).join("/");
      sources.set(posixPath, await readFile(path.join(repositoryRoot, relativePath), "utf8"));
    }
    const roots = [...sources.keys()].filter((file) =>
      file.startsWith("src/core/") || file.startsWith("src/application/")
    );
    expect(roots.length).toBeGreaterThan(20);
    expect(boundaryViolations(roots, sources)).toEqual([]);

    // The check fails for each kind of forbidden dependency, including one
    // reached indirectly through an otherwise permitted module.
    const hostile = new Map([
      ["src/core/ports.ts", 'import {Database} from "better-sqlite3";'],
      ["src/application/publish.ts", 'import {S3Client} from "@aws-sdk/client-s3";\nimport {helper} from "../manifest/helper.js";'],
      ["src/manifest/helper.ts", 'import {Hono} from "hono";\nimport {store} from "../storage/sqlite-artifact-repository.js";'],
      ["src/application/deploy.ts", 'const pulumi = await import("@pulumi/pulumi");'],
      ["src/application/clean.ts", 'import {Effect} from "effect";\nimport {hash} from "./hash.js";'],
      ["src/application/hash.ts", 'import {createHash} from "node:crypto";'],
    ]);
    expect(boundaryViolations([...hostile.keys()], hostile)).toEqual([
      "src/application/deploy.ts -> @pulumi/pulumi",
      "src/application/publish.ts -> @aws-sdk/client-s3",
      "src/core/ports.ts -> better-sqlite3",
      "src/manifest/helper.ts -> hono",
      "src/manifest/helper.ts -> src/storage/sqlite-artifact-repository.ts",
    ]);
  });
});
