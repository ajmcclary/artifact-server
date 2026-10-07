/**
 * The server-side copy of the agent-bridge bundle render contract.
 *
 * `@plannotator/agent-bridge` owns the canonical template and sanitization
 * for bundle messages, but the server cannot import that client package:
 * the compiled server build is rooted at `src/`, and the package's own
 * conformance gate (BRP-001-F) forbids its module graph from reaching out
 * of the published `@plannotator/agent-bridge` package. So the mailbox tier carries this exact
 * mirror. The pinned package is patched in this repository to sanitize all
 * rendered header fields, and BRP-002-B pins the two renders byte-for-byte against the
 * same bundle — any drift between the copies fails that test.
 */

import {z} from "zod";

/**
 * Bidirectional controls (U+202A–202E, U+2066–2069) and zero-width or
 * otherwise invisible characters (U+200B–200F, U+2060, U+FEFF) that hostile
 * comment text could use to reorder or hide what the reading agent sees.
 */
const invisibleDirectivePattern =
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF]/gu;

/**
 * Strip bidirectional-override and invisible Unicode from one piece of
 * untrusted text before it is composed into a bundle message. Pure and
 * idempotent; every visible character passes through unchanged.
 */
export function sanitizeBundleText(text: string): string {
  return text.replace(invisibleDirectivePattern, "");
}

/**
 * The review client's stored `view` block, checked exactly as strictly as the
 * client reads it, so an agent never sees a location the reviewer's page
 * would have treated as absent.
 */
const bundleParameterValueSchema = z.union([z.string().max(256), z.number().finite(), z.boolean()]);
const bundleViewBlockSchema = z.object({
  regionId: z.string().max(128).regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/u).optional(),
  regionLabel: z.string().max(64).optional(),
  scenarioId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u),
  scenarioLabel: z.string().max(200),
  sourceRef: z.object({
    line: z.number().int().min(1).optional(),
    path: z.string().min(1).max(1_024),
  }).strict(),
  state: z.object({
    direction: z.enum(["ltr", "rtl"]),
    locale: z.string().max(64).nullable(),
    parameters: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u), bundleParameterValueSchema),
    theme: z.enum(["light", "dark", "high-contrast"]),
    viewport: z.object({
      height: z.number().int().min(0).max(100_000),
      width: z.number().int().min(0).max(100_000),
    }).strict(),
  }).strict(),
  viewFormat: z.literal(1),
  viewId: z.string().min(1).max(128),
}).strict();

/** Reads a thread's opaque anchor for the design review `view` block a location line names. */
export const bundleAnchorSchema = z.object({view: bundleViewBlockSchema}).loose();
export type BundleViewBlock = z.infer<typeof bundleViewBlockSchema>;

/**
 * The one-line location of a comment made on a designed page, built from its
 * anchor's view block alone so every renderer produces it without another
 * request.
 */
export function bundleLocationLine(view: BundleViewBlock): string {
  const parts = [`at ${view.scenarioLabel} (scenario ${view.scenarioId})`];
  if (view.regionId !== undefined) {
    parts.push(view.regionLabel === undefined ? `region ${view.regionId}` : `region ${view.regionId} "${view.regionLabel}"`);
  }
  parts.push(`source ${view.sourceRef.path}${view.sourceRef.line === undefined ? "" : `:${view.sourceRef.line}`}`);
  // A stored anchor is untrusted: control characters (a newline, an escape
  // sequence) in a label or source path must not reach the agent either.
  return sanitizeBundleText(parts.join(" · ")).replace(/[\s\p{Cc}]+/gu, " ").trim();
}

// ---------------------------------------------------------------------------
// Bundle rendering
// ---------------------------------------------------------------------------

/** Longest quoted selection the rendered message reproduces. */
export const maximumQuotedSelectionCharacters = 300;

/** One rendered line item of a bundle. */
export interface BundleItem {
  readonly artifactName: string;
  readonly body: string;
  readonly path: string | null;
  readonly quotedSelection: string | null;
  /** The comment's designed-page location, when its anchor has one. */
  readonly location?: string | null;
  readonly threadId: string;
  readonly versionNumber: number;
}

/** Everything the message template needs, already fetched and ordered. */
export interface RenderableBundle {
  readonly items: readonly BundleItem[];
  readonly note: string | null;
  readonly senderDisplayName: string;
}

/** The comment-tool surface named in one rendered bundle. */
export type BundleRenderProfile = "mailbox" | "native";

const completionInstructions = {
  mailbox: [
    "When each item is done: use comment_reply to reply to its thread with what you did,",
    "then use comment_resolve to resolve it. Do not wait for confirmation.",
  ],
  native: [
    "When each item is done: use the artifact_comments tool to reply to its thread",
    "with what you did, then resolve it. Do not wait for confirmation.",
  ],
} as const satisfies Record<
  BundleRenderProfile,
  readonly [string, string]
>;

function quotedSelectionFragment(selection: string): string {
  const collapsed = sanitizeBundleText(selection).replace(/\s+/gu, " ").trim();
  const bounded = collapsed.length <= maximumQuotedSelectionCharacters
    ? collapsed
    : `${collapsed.slice(0, maximumQuotedSelectionCharacters - 1)}…`;
  return `"${bounded}"`;
}

/**
 * Render one bundle as one message in the recorded template. The message
 * always starts with the constant `Artifact Server:` prefix, so no rendered
 * message can ever begin with a slash and be intercepted as a host command,
 * and every untrusted field is stripped of bidirectional and invisible
 * Unicode before composition.
 *
 * @param bundle - The fetched, ordered bundle to render.
 * @param profile - The comment-tool surface available to the receiving agent.
 * @returns One sanitized message for the receiving agent.
 */
export function renderBundleMessage(
  bundle: RenderableBundle,
  profile: BundleRenderProfile = "native",
): string {
  const lines: string[] = [];
  lines.push(
    `Artifact Server: ${sanitizeBundleText(bundle.senderDisplayName)} sent ` +
      `${bundle.items.length} annotation(s) to address.`,
  );
  const note = sanitizeBundleText(bundle.note ?? "").trim();
  if (note !== "") lines.push(note);
  lines.push("");
  bundle.items.forEach((item, index) => {
    const place = sanitizeBundleText(item.path === null
      ? `[${item.artifactName} · version ${item.versionNumber}]`
      : `[${item.artifactName} · version ${item.versionNumber} · ${item.path}]`);
    const quoted = item.quotedSelection === null
      ? ""
      : ` ${quotedSelectionFragment(item.quotedSelection)}`;
    lines.push(`${index + 1}. ${place}${quoted}`);
    const location = item.location === undefined || item.location === null
      ? ""
      : sanitizeBundleText(item.location).replace(/\s+/gu, " ").trim();
    if (location !== "") lines.push(`   ${location}`);
    for (const bodyLine of sanitizeBundleText(item.body).split("\n")) {
      lines.push(`   ${bodyLine}`);
    }
    lines.push(`   (thread ${item.threadId})`);
  });
  lines.push("");
  lines.push(...completionInstructions[profile]);
  return lines.join("\n");
}
