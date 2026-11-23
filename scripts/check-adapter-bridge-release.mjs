#!/usr/bin/env node

/**
 * Release gate: refuse to publish an adapter that would resolve an
 * unpatched `@plannotator/agent-bridge` from the public registry.
 *
 * This repository patches the bridge locally (root `pnpm.patchedDependencies`).
 * A pnpm patch applies only inside this workspace: an adapter installed from
 * npm resolves its bridge range against the registry and receives the
 * upstream bytes, without the guest markers, sanitization, and request bounds
 * the patch adds. An adapter is publishable only when its declared bridge
 * range cannot admit any version this repository still patches, which means
 * the patched behavior has been released upstream and the range raised past
 * it.
 *
 * Dependency-free on purpose: the npm publish job runs it without installing
 * the workspace.
 *
 * Usage:
 *   check-adapter-bridge-release.mjs [--root <dir>]
 *   check-adapter-bridge-release.mjs [--root <dir>] --packed <dir> --version <x.y.z>
 *
 * Without --packed it reads each adapter's source package.json. With it, it
 * reads the package.json inside each packed release tarball. Exit status 1
 * lists every refusal; 0 means every adapter is publishable.
 */

import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const bridgePackage = "@plannotator/agent-bridge";
const adapters = ["pi", "opencode", "omp", "claude-channel"];
const plainVersionPattern = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;
const rangePattern = /^(?<operator>\^|~|>=)?(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "usage: check-adapter-bridge-release.mjs [--root <dir>] " +
      "[--packed <dir> --version <x.y.z>]\n",
  );
  process.exit(2);
}

function parseArguments(cliArguments) {
  const options = {
    packed: null,
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    version: null,
  };
  for (let index = 0; index < cliArguments.length; index += 2) {
    const flag = cliArguments[index];
    const value = cliArguments[index + 1];
    if (value === undefined) usage(`${flag} needs a value.`);
    if (flag === "--root") options.root = path.resolve(value);
    else if (flag === "--packed") options.packed = path.resolve(value);
    else if (flag === "--version") options.version = value;
    else usage(`Unknown argument ${flag}.`);
  }
  if ((options.packed === null) !== (options.version === null)) {
    usage("--packed and --version go together.");
  }
  return options;
}

function versionParts(version) {
  const groups = version.match(plainVersionPattern)?.groups;
  if (groups === undefined) return null;
  return [Number(groups.major), Number(groups.minor), Number(groups.patch)];
}

function compareParts(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** [lower, upper) bounds of the range forms adapters use, or null. */
function rangeBounds(range) {
  const groups = String(range).trim().match(rangePattern)?.groups;
  if (groups === undefined) return null;
  const lower = versionParts(groups.version);
  if (lower === null) return null;
  const [major, minor, patch] = lower;
  switch (groups.operator) {
    case "^": {
      if (major > 0) return {lower, upper: [major + 1, 0, 0]};
      if (minor > 0) return {lower, upper: [0, minor + 1, 0]};
      return {lower, upper: [0, 0, patch + 1]};
    }
    case "~": {
      return {lower, upper: [major, minor + 1, 0]};
    }
    case ">=": {
      return {lower, upper: null};
    }
    default: {
      return {lower, upper: [major, minor, patch + 1]};
    }
  }
}

function admits(bounds, version) {
  if (compareParts(version, bounds.lower) < 0) return false;
  return bounds.upper === null || compareParts(version, bounds.upper) < 0;
}

/** Bridge versions this repository patches, as recorded in the root manifest. */
function patchedBridgeVersions(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const patched = manifest.pnpm?.patchedDependencies ?? {};
  const versions = [];
  for (const key of Object.keys(patched)) {
    if (!key.startsWith(`${bridgePackage}@`)) continue;
    versions.push(key.slice(bridgePackage.length + 1));
  }
  return versions;
}

function adapterManifest(options, adapter) {
  if (options.packed === null) {
    const source = path.join(options.root, "integrations", adapter, "package.json");
    return {label: path.relative(options.root, source), manifest: JSON.parse(readFileSync(source, "utf8"))};
  }
  const archive = path.join(
    options.packed,
    `plannotator-artifact-server-${adapter}-${options.version}.tgz`,
  );
  const text = execFileSync("tar", ["-xzOf", archive, "package/package.json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {label: path.basename(archive), manifest: JSON.parse(text)};
}

function refusalsFor(options) {
  const patchedVersions = patchedBridgeVersions(options.root);
  const refusals = [];
  for (const adapter of adapters) {
    const {label, manifest} = adapterManifest(options, adapter);
    const range = manifest.dependencies?.[bridgePackage];
    if (range === undefined) {
      refusals.push(`${label} declares no ${bridgePackage} dependency; the gate cannot prove which bridge it ships.`);
      continue;
    }
    const bounds = rangeBounds(range);
    if (bounds === null) {
      refusals.push(`${label} declares ${bridgePackage} "${range}", a range form this gate does not evaluate; it fails closed.`);
      continue;
    }
    for (const version of patchedVersions) {
      const parts = versionParts(version);
      if (parts === null) {
        refusals.push(`The root patch for ${bridgePackage}@${version} names no plain version; the gate fails closed.`);
        continue;
      }
      if (!admits(bounds, parts)) continue;
      refusals.push(
        `${label} declares ${bridgePackage} "${range}", which admits ${version}. ` +
          `This repository patches ${version} locally, so an npm install of the ` +
          "adapter resolves the unpatched registry copy. Release the patched " +
          `bridge upstream, raise the adapter range past ${version}, and drop the local patch.`,
      );
    }
  }
  return refusals;
}

const options = parseArguments(process.argv.slice(2));
const refusals = refusalsFor(options);
if (refusals.length > 0) {
  process.stderr.write("Adapter bridge release gate refused publication:\n");
  for (const refusal of refusals) process.stderr.write(`- ${refusal}\n`);
  process.exit(1);
}
process.stdout.write(
  `Adapter bridge release gate passed for ${adapters.length} adapters.\n`,
);
