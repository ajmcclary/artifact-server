import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {build} from "esbuild";
import type {Plugin} from "vite";

const themeBootEntry = fileURLToPath(new URL("../src/theme/theme-boot.ts", import.meta.url));
const developmentScriptPath = "/assets/theme-boot.js";

interface ThemeBootScript {
  readonly code: string;
  readonly fileName: string;
}

async function bundleThemeBoot(minify: boolean): Promise<string> {
  const result = await build({
    bundle: true,
    entryPoints: [themeBootEntry],
    format: "iife",
    legalComments: "none",
    logLevel: "error",
    minify,
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error("esbuild produced no theme-boot output.");
  return output.text;
}

/**
 * Loads `src/theme/theme-boot.ts` as a classic same-origin script before the
 * application bundle in `review.html` only. A module script is deferred and
 * could paint first; an inline script would break `script-src 'self'`.
 */
export function themeBootPlugin(): Plugin {
  let script: ThemeBootScript | null = null;
  return {
    async buildStart() {
      this.addWatchFile(themeBootEntry);
      const code = await bundleThemeBoot(true);
      const hash = createHash("sha256").update(code).digest("hex").slice(0, 10);
      script = {code, fileName: `assets/theme-boot-${hash}.js`};
    },
    configureServer(server) {
      server.middlewares.use(developmentScriptPath, (_request, response, next) => {
        void bundleThemeBoot(false).then(
          (code) => response.setHeader("Content-Type", "text/javascript; charset=utf-8").end(code),
          next,
        );
      });
    },
    generateBundle() {
      if (script !== null) this.emitFile({fileName: script.fileName, source: script.code, type: "asset"});
    },
    name: "artifact-server-theme-boot",
    transformIndexHtml: {
      handler(_html, context) {
        if (path.basename(context.filename) !== "review.html") return undefined;
        const source = context.server === undefined && script !== null ? `/${script.fileName}` : developmentScriptPath;
        return [{attrs: {src: source}, injectTo: "head-prepend", tag: "script"}];
      },
      order: "post",
    },
  };
}
