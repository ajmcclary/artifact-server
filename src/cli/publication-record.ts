import {z} from "zod";

import type {FilePublicationIntent, FilePublicationTarget} from "../client/file-publication-client.js";

const artifactSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link"]),
  createdAt: z.string(),
  currentVersionId: z.string().startsWith("ver_"),
  deletedAt: z.string().nullable(),
  id: z.string().startsWith("art_"),
  name: z.string(),
  projectId: z.string().startsWith("prj_"),
  tags: z.array(z.string()),
});
const versionSchema = z.object({
  artifactId: z.string().startsWith("art_"),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string().startsWith("ver_"),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  number: z.number().int().positive(),
  publisherPrincipalId: z.string(),
  projectId: z.string().startsWith("prj_"),
  routingMode: z.enum(["static", "spa"]),
});
const linksSchema = z.object({artifact: z.url(), review: z.url(), version: z.url()});

export const publicationReceiptSchema = z.object({
  artifact: artifactSchema,
  links: linksSchema,
  replayed: z.boolean(),
  version: versionSchema,
}).refine((receipt) =>
  receipt.artifact.id === receipt.version.artifactId &&
  receipt.artifact.projectId === receipt.version.projectId &&
  receipt.artifact.currentVersionId === receipt.version.id &&
  receipt.artifact.deletedAt === null,
  "The publication receipt contains inconsistent artifact or version identities.",
);
export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;

export const publicationDetailsSchema = z.object({
  artifact: artifactSchema,
  current: z.object({
    version: versionSchema,
    links: z.object({review: z.url(), version: z.url()}),
  }),
  links: z.object({artifact: z.url()}),
});

const targetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new_artifact"),
    name: z.string().optional(),
    accessSetting: z.enum(["account_required", "public_link"]),
    tags: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("new_version"),
    artifactId: z.string().startsWith("art_"),
    expectedCurrentVersionId: z.string().startsWith("ver_"),
  }),
]);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const legacyPublicationSchema = z.object({
  operationScopeDigest: digestSchema,
  operationDigest: digestSchema,
});
export type LegacyPublication = z.infer<typeof legacyPublicationSchema>;
export const publicationIntentSchema = z.object({
  inputPath: z.string(),
  projectId: z.string().optional(),
  entryPath: z.string().optional(),
  routingMode: z.enum(["static", "spa"]).optional(),
  target: targetSchema,
}).transform((value): FilePublicationIntent => {
  let target: FilePublicationTarget;
  if (value.target.kind === "new_version") target = value.target;
  else {
    target = {kind: "new_artifact", accessSetting: value.target.accessSetting, tags: value.target.tags};
    if (value.target.name !== undefined) target = {...target, name: value.target.name};
  }
  let intent: FilePublicationIntent = {inputPath: value.inputPath, target};
  if (value.projectId !== undefined) intent = {...intent, projectId: value.projectId};
  if (value.entryPath !== undefined) intent = {...intent, entryPath: value.entryPath};
  if (value.routingMode !== undefined) intent = {...intent, routingMode: value.routingMode};
  return intent;
});
export const publicationScopeSchema = z.object({
  sourcePath: z.string(),
  origin: z.url(),
  installationId: z.string().min(1),
  principalId: z.string().min(1),
  projectId: z.string().startsWith("prj_"),
});
export type PublicationScope = z.infer<typeof publicationScopeSchema>;
const preferencesSchema = z.object({
  entry: z.string().optional(),
  routing: z.enum(["static", "spa"]).optional(),
});
export type PublicationPreferences = z.infer<typeof preferencesSchema>;
export const publicationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  scope: publicationScopeSchema,
  preferences: preferencesSchema,
  receipt: publicationReceiptSchema.nullable(),
  pending: z.object({
    intent: publicationIntentSchema,
    selection: z.string(),
    operationDigest: digestSchema,
    idempotencyKey: z.string().min(16).max(200),
    legacy: legacyPublicationSchema.nullable(),
  }).nullable(),
  retiredLegacy: legacyPublicationSchema.nullable(),
  unreported: z.object({
    intent: publicationIntentSchema,
    selection: z.string(),
    operationDigest: digestSchema,
  }).nullable().default(null),
}).strict();
export type PublicationRecord = z.infer<typeof publicationRecordSchema>;

/** Receipt links may use the server's configured public origin behind a port forward. */
export function validatePublicationReceipt(
  receipt: PublicationReceipt,
  scope: PublicationScope,
): void {
  if (receipt.artifact.projectId !== scope.projectId ||
    new URL(receipt.links.artifact).origin !== new URL(receipt.links.review).origin) {
    throw new Error("The publication receipt does not belong to the selected destination and project.");
  }
}
