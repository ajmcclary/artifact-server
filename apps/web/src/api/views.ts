import {z} from "zod";

/** Client mirrors of the server's per-version views and provenance outcomes. */
const propValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const reviewScenarioSchema = z.object({
  label: z.string(),
  props: z.record(z.string(), propValueSchema),
  scenarioId: z.string(),
}).strict();

export const reviewViewSchema = z.object({
  defaultScenarioId: z.string(),
  label: z.string(),
  parameters: z.array(z.object({
    default: propValueSchema,
    name: z.string(),
    prop: z.string(),
    values: z.array(z.object({propValue: propValueSchema, value: propValueSchema}).strict()),
  }).strict()),
  path: z.string(),
  scenarios: z.array(reviewScenarioSchema),
  sourceRef: z.object({line: z.number().int().optional(), path: z.string()}).strict(),
  viewId: z.string(),
}).strict();

export const viewsOutcomeSchema = z.discriminatedUnion("status", [
  z.object({status: z.literal("valid"), views: z.array(reviewViewSchema)}).strict(),
  z.object({status: z.literal("absent")}).strict(),
  z.object({status: z.literal("unsupported-version"), version: z.number()}).strict(),
  z.object({diagnostic: z.string(), status: z.literal("invalid")}).strict(),
]);

const coverageSchema = z.object({
  declaredOutputs: z.number(),
  dependencyEdges: z.enum(["complete", "none", "partial"]),
  externalVariability: z.array(z.string()),
  manifestFiles: z.number(),
}).strict();
const provenanceRecordSchema = z.object({
  source: z.object({
    commit: z.string(),
    descriptorId: z.string(),
    dirty: z.boolean(),
    repository: z.string(),
  }).strict(),
}).loose();

export const provenanceOutcomeSchema = z.discriminatedUnion("status", [
  z.object({coverage: coverageSchema, record: provenanceRecordSchema, status: z.literal("verified")}).strict(),
  z.object({
    coverage: coverageSchema,
    mismatchCount: z.number(),
    mismatches: z.array(z.object({path: z.string(), reason: z.enum(["digest", "missing"])}).strict()),
    record: provenanceRecordSchema,
    status: z.literal("mismatch"),
  }).strict(),
  z.object({diagnostic: z.string(), status: z.literal("invalid")}).strict(),
  z.object({status: z.literal("unsupported-version"), version: z.number()}).strict(),
  z.object({status: z.literal("not-recorded")}).strict(),
]);

export type ViewsOutcome = z.infer<typeof viewsOutcomeSchema>;
export type ReviewView = z.infer<typeof reviewViewSchema>;
export type ReviewScenario = z.infer<typeof reviewScenarioSchema>;
export type ProvenanceOutcome = z.infer<typeof provenanceOutcomeSchema>;
