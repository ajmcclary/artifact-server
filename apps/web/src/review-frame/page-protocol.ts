import {z} from "zod";

/**
 * The review frame ↔ page adapter channel. The page runs in an opaque-origin
 * `srcdoc` sandbox inside the review frame and is untrusted: every message it
 * sends is validated here, and the frame never reads its document.
 */
export const pageProtocolVersion = 1;

export const scenarioIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u);
export const regionIdSchema = z.string().max(128).regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/u);
export const propNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u);
const requestIdSchema = z.string().min(1).max(64);
const propValueSchema = z.union([z.string().max(256), z.number().finite(), z.boolean()]);

export const pagePropsSchema = z.record(propNameSchema, propValueSchema)
  .refine((props) => Object.keys(props).length <= 16, "At most 16 props.");
export type PageProps = z.infer<typeof pagePropsSchema>;

export const pageStateSchema = z.object({
  direction: z.enum(["ltr", "rtl"]),
  locale: z.string().max(64).nullable(),
  pageVersion: z.number().int().min(1).max(1_000),
  props: pagePropsSchema,
  scenarioId: scenarioIdSchema.nullable(),
  theme: z.enum(["light", "dark"]),
  viewport: z.object({
    height: z.number().int().min(0).max(100_000),
    width: z.number().int().min(0).max(100_000),
  }).strict(),
}).strict();
export type PageState = z.infer<typeof pageStateSchema>;

export const pageRegionSchema = z.object({
  label: z.string().max(256),
  regionId: regionIdSchema,
  tagName: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
}).strict();
export type PageRegion = z.infer<typeof pageRegionSchema>;

/** Every message a page adapter may send to the review frame. */
export const pageMessageSchema = z.discriminatedUnion("type", [
  z.object({
    capabilities: z.array(z.enum(["capture", "regions", "restore"])).max(8),
    pageVersion: z.number().int().min(1).max(1_000),
    type: z.literal("as-page-hello"),
  }).strict(),
  z.object({
    ok: z.boolean(),
    // "superseded" is additive under pageVersion 1: a later restore replaced this one.
    reason: z.enum(["adapter-error", "superseded", "timeout"]).optional(),
    requestId: requestIdSchema,
    state: pageStateSchema.nullable(),
    type: z.literal("as-page-restored"),
  }).strict(),
  z.object({
    requestId: requestIdSchema.nullable(),
    state: pageStateSchema,
    type: z.literal("as-page-state"),
  }).strict(),
  z.object({
    reason: z.enum(["ambiguous", "none"]).optional(),
    region: pageRegionSchema.nullable(),
    requestId: requestIdSchema,
    type: z.literal("as-page-region"),
  }).strict(),
  z.object({
    requestId: requestIdSchema,
    results: z.array(z.object({
      count: z.number().int().min(0).max(10_000),
      regionId: regionIdSchema,
      tagName: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u).nullable(),
    }).strict()).max(64),
    type: z.literal("as-page-regions"),
  }).strict(),
]);
export type PageMessage = z.infer<typeof pageMessageSchema>;

/** Every message the review frame sends to a page adapter. */
export type FrameToPageMessage =
  | {readonly pageVersion: number; readonly type: "as-page-welcome"}
  | {readonly props: PageProps; readonly requestId: string; readonly type: "as-page-restore"}
  | {readonly props: readonly string[]; readonly requestId: string; readonly type: "as-page-capture"}
  | {readonly requestId: string; readonly selector: string; readonly type: "as-page-region-at"}
  | {readonly regionIds: readonly string[]; readonly requestId: string; readonly type: "as-page-region-find"};
