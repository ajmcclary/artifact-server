import {lstat, readFile, realpath} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

import {hasFileError, publicationSource} from "./publication-registry.js";

export const publicationGroupsFilename = "artifactserver.publish.json";
const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
const destinationSchema = z.object({profile: z.string().min(1).optional(), project: z.string().startsWith("prj_").optional()}).strict();
const targetSchema = z.object({path: z.string().min(1)}).strict();
const groupSchema = destinationSchema.extend({targets: z.array(nameSchema).min(1)}).strict();
const configSchema = z.object({
  schemaVersion: z.literal(1),
  defaults: destinationSchema.default({}),
  targets: z.record(nameSchema, targetSchema),
  groups: z.record(nameSchema, groupSchema),
}).strict();
export interface PublicationGroupsConfig {
  readonly file: string;
  readonly root: string;
  readonly definition: z.infer<typeof configSchema>;
}

export async function readPublicationGroups(configFile?: string, cwd = process.cwd()): Promise<PublicationGroupsConfig> {
  const file = configFile === undefined ? await discoverConfig(cwd) : path.resolve(cwd, configFile);
  if (!(await lstat(file)).isFile()) throw new Error("Publication group configuration must be a regular file, not a symbolic link.");
  const canonical = await realpath(file);
  const definition = configSchema.parse(JSON.parse(await readFile(canonical, "utf8")));
  for (const [name, group] of Object.entries(definition.groups)) {
    if (new Set(group.targets).size !== group.targets.length) throw new Error(`Group ${name} repeats a target.`);
    for (const target of group.targets) {
      if (!Object.hasOwn(definition.targets, target)) throw new Error(`Group ${name} references unknown target ${target}.`);
    }
  }
  return {file: canonical, root: path.dirname(canonical), definition};
}

export function selectPublicationGroup(config: PublicationGroupsConfig, name: string) {
  nameSchema.parse(name);
  const group = Object.hasOwn(config.definition.groups, name) ? config.definition.groups[name] : undefined;
  if (group === undefined) throw new Error(`Unknown publication group ${name}. Use publications groups to list available groups.`);
  return group;
}

export function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function groupSource(config: PublicationGroupsConfig, name: string): Promise<string> {
  const target = Object.hasOwn(config.definition.targets, name) ? config.definition.targets[name] : undefined;
  if (target === undefined) throw new Error(`Unknown publication target ${name}.`);
  if (path.isAbsolute(target.path) || path.win32.isAbsolute(target.path)) throw new Error(`Target ${name} must use a relative path.`);
  const lexical = path.resolve(config.root, target.path);
  if (!pathContains(config.root, lexical)) throw new Error(`Target ${name} escapes the configuration directory.`);
  const source = await publicationSource(lexical);
  if (!pathContains(config.root, source)) throw new Error(`Target ${name} resolves outside the configuration directory.`);
  if (pathContains(source, config.file)) throw new Error(`Target ${name} would publish the group configuration itself. Move the configuration above its sources.`);
  return source;
}

async function discoverConfig(cwd: string): Promise<string> {
  let directory = await realpath(cwd);
  while (true) {
    const candidate = path.join(directory, publicationGroupsFilename);
    // eslint-disable-next-line no-await-in-loop -- nearest ancestor wins and checkout boundaries stop discovery
    if (await exists(candidate)) return candidate;
    // eslint-disable-next-line no-await-in-loop -- inspect this checkout boundary before ascending
    if (await exists(path.join(directory, ".git")) || path.dirname(directory) === directory) break;
    directory = path.dirname(directory);
  }
  throw new Error(`No ${publicationGroupsFilename} found in this checkout. Supply --config <file>.`);
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if (error instanceof Error && hasFileError(error, "ENOENT")) return false;
    throw error;
  }
}
