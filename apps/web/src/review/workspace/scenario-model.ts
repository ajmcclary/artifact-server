import type {ReviewView, ViewsOutcome} from "../../api/views.ts";
import type {PageProps, PageRegion, PageState} from "../../review-frame/page-protocol.ts";
import type {
  ReviewAnchor,
  ReviewAnnotation,
  ViewAnchor,
  ViewStateMessage,
} from "../../review-frame/protocol.ts";

export type ParameterValue = string | number | boolean;

export type ThreadPlacement =
  | {readonly kind: "place"}
  | {readonly kind: "other-scenario"; readonly scenarioId: string; readonly scenarioLabel: string};

export interface ScenarioStatus {
  readonly reason: string | null;
  /** The restore or capture this state is waiting on; only its reply may settle it. */
  readonly requestId: string | null;
  readonly scenarioId: string | null;
  readonly status: "failed" | "idle" | "ready" | "restoring" | "unsupported";
}

const invisibleOrControl = /[\p{Cc}\p{Cf}]/gu;

/** The valid view whose page is open, or null. */
export function viewForPath(outcome: ViewsOutcome | null, path: string | null): ReviewView | null {
  if (outcome?.status !== "valid" || path === null) return null;
  return outcome.views.find((view) => view.path === path) ?? null;
}

/** The props that reproduce one declared scenario with the given parameters. */
export function restorePropsFor(
  view: ReviewView,
  scenarioId: string,
  parameters: Readonly<Record<string, ParameterValue>>,
): PageProps | null {
  const scenario = view.scenarios.find((candidate) => candidate.scenarioId === scenarioId);
  if (scenario === undefined) return null;
  const parameterProps = view.parameters.flatMap((parameter) => {
    const chosen = parameters[parameter.name] ?? parameter.default;
    const option = parameter.values.find((candidate) => candidate.value === chosen)
      ?? parameter.values.find((candidate) => candidate.value === parameter.default);
    return option === undefined ? [] : [[parameter.prop, option.propValue] as const];
  });
  return {...scenario.props, ...Object.fromEntries(parameterProps)};
}

/** Every prop name the view declares, scenario props first. */
export function captureProps(view: ReviewView): readonly string[] {
  const names = new Set<string>();
  for (const scenario of view.scenarios) for (const name of Object.keys(scenario.props)) names.add(name);
  for (const parameter of view.parameters) names.add(parameter.prop);
  return [...names];
}

/** Map captured prop values back to the view's declared parameter values. */
export function parametersFromProps(view: ReviewView, props: PageProps) {
  return Object.fromEntries(view.parameters.flatMap((parameter) => {
    const option = parameter.values.find((candidate) => candidate.propValue === props[parameter.prop]);
    return option === undefined ? [] : [[parameter.name, option.value] as const];
  }));
}

/** Strip control, format (bidi and zero-width) characters, collapse spaces and bound. */
export function sanitizeLabel(text: string, maximum: number): string {
  return text.replace(invisibleOrControl, "").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

/** The stored view block, or undefined when the page did not confirm a declared scenario. */
export function viewAnchorFrom(
  view: ReviewView,
  capture: {readonly region: PageRegion | null; readonly state: PageState | null} | undefined,
): ViewAnchor | undefined {
  const state = capture?.state ?? null;
  if (state === null || state.scenarioId === null) return undefined;
  const scenario = view.scenarios.find((candidate) => candidate.scenarioId === state.scenarioId);
  if (scenario === undefined) return undefined;
  const anchor: ViewAnchor = {
    scenarioId: scenario.scenarioId,
    scenarioLabel: sanitizeLabel(scenario.label, 200),
    sourceRef: view.sourceRef,
    state: {
      direction: state.direction,
      locale: state.locale,
      parameters: parametersFromProps(view, state.props),
      theme: state.theme,
      viewport: state.viewport,
    },
    viewFormat: 1,
    viewId: view.viewId,
  };
  const region = capture?.region ?? null;
  if (region === null) return anchor;
  const label = sanitizeLabel(region.label, 64);
  return label === ""
    ? {...anchor, regionId: region.regionId}
    : {...anchor, regionId: region.regionId, regionLabel: label};
}

/** Whether a thread belongs on the page as it is now. */
export function threadPlacement(
  anchor: ReviewAnchor | null,
  view: ReviewView | null,
  onScreenScenarioId: string | null,
): ThreadPlacement {
  const located = anchor?.view;
  if (view === null || located === undefined || located.viewId !== view.viewId) return {kind: "place"};
  if (located.scenarioId === onScreenScenarioId) return {kind: "place"};
  return {kind: "other-scenario", scenarioId: located.scenarioId, scenarioLabel: located.scenarioLabel};
}

const capturedThemes = new Map<string, string>([
  ["dark", "Made in the dark theme"],
  ["high-contrast", "Made in high contrast"],
]);

/**
 * The theme a comment was made in, when it was not the light default. A
 * restore sets the scenario and props, never the theme: the reviewer's own
 * theme may be an accessibility setting. Saying so keeps a reopened comment
 * from showing a different theme silently.
 */
export function capturedThemeText(anchor: ReviewAnchor | null, view: ReviewView | null): string | null {
  const located = anchor?.view;
  if (view === null || located === undefined || located.viewId !== view.viewId) return null;
  return capturedThemes.get(located.state.theme) ?? null;
}

/**
 * The annotations the frame should place for the scenario on screen. A view
 * block is passed on only when it belongs to the view on screen; otherwise it
 * is dropped so the frame falls back to its ordinary placement and never
 * places a thread by region in a scenario nobody confirmed.
 */
export function annotationsForScenario(
  annotations: readonly ReviewAnnotation[],
  view: ReviewView | null,
  onScreenScenarioId: string | null,
): ReviewAnnotation[] {
  return annotations
    .filter((annotation) => threadPlacement(annotation.anchor, view, onScreenScenarioId).kind === "place")
    .map((annotation) => {
      const anchor = annotation.anchor;
      if (anchor?.view === undefined || (view !== null && anchor.view.viewId === view.viewId)) return annotation;
      const {view: _unused, ...legacy} = anchor;
      return {anchor: legacy, body: annotation.body, state: annotation.state, threadId: annotation.threadId};
    });
}

const restoreFailureReasons = new Map<string, string>([
  ["adapter-error", "the page reported an error while switching"],
  ["no-adapter", "this page can't be told which scenario to show"],
  ["scenario-mismatch", "the page showed a different scenario"],
  ["timeout", "the page didn't confirm it in time"],
]);

/** The toolbar's sentence for a restore that did not reach the requested scenario. */
export function scenarioFailureText(scenarioId: string, reason: string | null): string {
  const explained = reason === null ? undefined : restoreFailureReasons.get(reason);
  return `Couldn't open scenario ${scenarioId}: ${explained ?? "the page didn't say why"}.`;
}

/** Settle the on-screen scenario from one frame report; stale replies change nothing. */
export function reduceViewState(
  current: ScenarioStatus,
  message: ViewStateMessage,
  view: ReviewView,
): ScenarioStatus {
  if (message.requestId !== null && message.requestId !== current.requestId) return current;
  const confirmed = message.state?.scenarioId ?? null;
  const declared = confirmed !== null && view.scenarios.some((scenario) => scenario.scenarioId === confirmed)
    ? confirmed
    : null;
  // A page reports its own scenario changes, including the one a restore
  // causes, before it answers the restore: track it, but keep waiting.
  if (message.requestId === null && current.status === "restoring") {
    return {...current, scenarioId: declared};
  }
  if (message.outcome === "restored") {
    return {reason: null, requestId: null, scenarioId: declared, status: "ready"};
  }
  if (message.outcome === "unsupported") {
    return {reason: message.reason ?? "no-adapter", requestId: null, scenarioId: null, status: "unsupported"};
  }
  return {reason: message.reason ?? "adapter-error", requestId: null, scenarioId: declared, status: "failed"};
}
