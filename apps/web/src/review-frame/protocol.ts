import { z } from "zod";

import type {
  HtmlAnnotationTarget,
  HtmlElementAnchor,
} from "@plannotator/ui/components/html-viewer";

import {
  pagePropsSchema,
  pageRegionSchema,
  pageStateSchema,
  pageThemeSchema,
  propNameSchema,
  regionIdSchema,
  scenarioIdSchema,
} from "./page-protocol.ts";

/** Protocol version carried by every host <-> review-frame message. */
export const reviewProtocolVersion = 1;

const versionSchema = z.literal(reviewProtocolVersion);

const anchorPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

/**
 * Trust-boundary caps mirror @plannotator/ui's own parent-side validation
 * (useHtmlAnnotation.ts:120-140) so a stored anchor can never be larger than
 * one the viewer would have produced.
 */
const htmlElementAnchorSchema = z.object({
  point: anchorPointSchema.optional(),
  selector: z.string().min(1).max(1_024),
  tagName: z.string().min(1).max(64),
  text: z.string().max(400).optional(),
});

const htmlAnnotationTargetSchema = z.object({
  anchor: htmlElementAnchorSchema.optional(),
  label: z.string().max(64).optional(),
  text: z.string().max(10_000),
});

const parameterValueSchema = z.union([z.string().max(256), z.number().finite(), z.boolean()]);

/**
 * Where on a designed page a comment was made. Copied from the version's
 * validated views document and the page's confirmed state at capture time,
 * so the anchor describes its own location without another lookup.
 */
export const viewAnchorSchema = z.object({
  regionId: regionIdSchema.optional(),
  regionLabel: z.string().max(64).optional(),
  scenarioId: scenarioIdSchema,
  scenarioLabel: z.string().max(200),
  sourceRef: z.object({
    line: z.number().int().min(1).optional(),
    path: z.string().min(1).max(1_024),
  }).strict(),
  state: z.object({
    direction: z.enum(["ltr", "rtl"]),
    locale: z.string().max(64).nullable(),
    parameters: z.record(propNameSchema, parameterValueSchema),
    theme: pageThemeSchema,
    viewport: z.object({
      height: z.number().int().min(0).max(100_000),
      width: z.number().int().min(0).max(100_000),
    }).strict(),
  }).strict(),
  viewFormat: z.literal(1),
  viewId: z.string().min(1).max(128),
}).strict();

export type ViewAnchor = z.infer<typeof viewAnchorSchema>;

/**
 * The anchor shape this client stores on a comment thread. The server treats
 * it as opaque, so the frame is its only reader: anything it does not
 * recognise (a whole-file `{kind: "page"}` anchor, an anchor written by a
 * future client) becomes `null` and the thread simply gets no page marker,
 * which is the same fail-closed outcome the bridge's own anchor builder uses.
 * The parse is loose so a later field survives a read, and an invalid `view`
 * block reads as absent rather than breaking the whole anchor.
 */
export const reviewAnchorSchema = z.object({
  htmlAdditionalTargets: z.array(htmlAnnotationTargetSchema).max(16).optional(),
  htmlAnchor: htmlElementAnchorSchema.nullable(),
  originalText: z.string().max(10_000),
  view: viewAnchorSchema.optional().catch(undefined),
}).loose();

const optionalAnchorSchema = reviewAnchorSchema.nullable().catch(null);

/** One comment thread as the host projects it into the page. */
export const reviewAnnotationSchema = z.object({
  anchor: optionalAnchorSchema,
  body: z.string(),
  state: z.enum(["open", "resolved"]),
  threadId: z.string().min(1),
});

const themeTokensSchema = z.record(
  z.string().regex(/^--[a-z0-9-]+$/iu),
  z.string().max(256),
);

/** Every message the host is allowed to send into the review frame. */
export const hostMessageSchema = z.discriminatedUnion("type", [
  z.object({
    annotateModeActive: z.boolean().optional(),
    annotations: z.array(reviewAnnotationSchema),
    baseHref: z.string().nullable(),
    entryPath: z.string(),
    html: z.string(),
    isLight: z.boolean(),
    readOnly: z.boolean(),
    themeTokens: themeTokensSchema,
    type: z.literal("as-review-init"),
    v: versionSchema,
  }),
  z.object({
    annotations: z.array(reviewAnnotationSchema),
    type: z.literal("as-review-annotations"),
    v: versionSchema,
  }),
  z.object({
    isLight: z.boolean(),
    themeTokens: themeTokensSchema,
    type: z.literal("as-review-theme"),
    v: versionSchema,
  }),
  z.object({
    active: z.boolean(),
    type: z.literal("as-review-annotate-mode"),
    v: versionSchema,
  }),
  z.object({
    threadId: z.string().nullable(),
    type: z.literal("as-review-focus"),
    v: versionSchema,
  }),
  z.object({
    props: pagePropsSchema,
    requestId: z.string().min(1).max(64),
    scenarioId: scenarioIdSchema,
    type: z.literal("as-review-restore"),
    v: versionSchema,
    viewId: z.string().min(1).max(128),
  }),
  z.object({
    props: z.array(propNameSchema).max(16),
    requestId: z.string().min(1).max(64),
    type: z.literal("as-review-capture"),
    v: versionSchema,
  }),
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;
export type ReviewAnnotation = z.infer<typeof reviewAnnotationSchema>;
export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;
export type ReviewInit = Extract<HostMessage, {type: "as-review-init"}>;
export type ReviewTheme = Extract<HostMessage, {type: "as-review-theme"}>;

/** Every message the review frame sends back to the host. */
export const frameMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("as-review-ready"),
    v: versionSchema,
  }),
  z.object({
    anchor: optionalAnchorSchema,
    body: z.string(),
    capture: z.object({
      region: pageRegionSchema.nullable(),
      state: pageStateSchema.nullable(),
    }).strict().optional(),
    originalText: z.string(),
    type: z.literal("as-review-submit"),
    v: versionSchema,
  }),
  z.object({
    threadId: z.string().nullable(),
    type: z.literal("as-review-select"),
    v: versionSchema,
  }),
  z.object({
    active: z.boolean(),
    type: z.literal("as-review-annotate-mode-request"),
    v: versionSchema,
  }),
  z.object({
    reasons: z.record(z.string(), z.enum(["region-ambiguous", "region-missing"])).optional(),
    threadIds: z.array(z.string()),
    type: z.literal("as-review-unanchored"),
    v: versionSchema,
  }),
  z.object({
    outcome: z.enum(["failed", "restored", "unsupported"]),
    reason: z.enum(["adapter-error", "no-adapter", "scenario-mismatch", "timeout"]).optional(),
    requestId: z.string().min(1).max(64).nullable(),
    state: pageStateSchema.nullable(),
    type: z.literal("as-review-view-state"),
    v: versionSchema,
  }),
]);

export type FrameMessage = z.infer<typeof frameMessageSchema>;
export type ViewStateMessage = Extract<FrameMessage, {type: "as-review-view-state"}>;
export type UnanchoredReason = "region-ambiguous" | "region-missing";
export type RestoreRequest = Extract<HostMessage, {type: "as-review-restore"}>;
export type CaptureRequest = Extract<HostMessage, {type: "as-review-capture"}>;

/** Build the anchor stored on a thread from what the viewer emitted. */
export function reviewAnchorFrom(
  originalText: string,
  htmlAnchor: HtmlElementAnchor | undefined,
  htmlAdditionalTargets: HtmlAnnotationTarget[] | undefined,
): ReviewAnchor {
  const anchor: ReviewAnchor = {
    htmlAnchor: htmlAnchor ?? null,
    originalText,
  };
  if (htmlAdditionalTargets !== undefined && htmlAdditionalTargets.length > 0) {
    return {...anchor, htmlAdditionalTargets};
  }
  return anchor;
}
