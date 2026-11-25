/* Designed scenarios and live configuration (Artifact Server 10/06–10/18/2026), as a pure model. A
   version's `artifactserver.views.json` declares views: each names a page (`path`, plus up to eight
   `aliases`), its scenarios and optional parameters (a Theme, say). An `interactive` view is a live
   configuration: its `scenarioLabel` names the picker ("Platform") and the page applies a choice
   without leaving the live preview. Review has no platform or theme list of its own; it reads these.
   `adapter: false` stands for a page that cannot be told which scenario to show. */

/** The view declared for `path` (by path or alias), or null. */
export function viewForPath(views, path) {
  return (views || []).find((v) => v.path === path || (v.aliases || []).includes(path)) || null;
}

/** The picker's options: a leading "Scenario" placeholder, then each scenario. A configured view
    (with `scenarioLabel`) shows labels alone; a legacy view prefixes the scenario id. */
export function scenarioOptions(view) {
  if (!view) return [];
  return [{ value: '', label: 'Scenario' }].concat(view.scenarios.map((s) => ({ value: s.id,
    label: view.scenarioLabel ? s.label : s.id + ' · ' + s.label })));
}
export const scenarioAriaLabel = (view) => (view && view.scenarioLabel) || 'Designed scenario';
/** A declared parameter's options; values are their indices, labels fall back to the value. */
export const parameterOptions = (parameter) => parameter.values.map((v, i) => ({ value: String(i), label: v.label != null ? v.label : String(v.value) }));
export const parameterLabel = (parameter) => parameter.label || parameter.name;
export const parameterDefault = (parameter) => String(Math.max(0, parameter.values.findIndex((v) => v.value === parameter.default)));

const REASONS = {
  'adapter-error': 'the page reported an error while switching',
  'no-adapter': 'this page can’t be told which scenario to show',
  'scenario-mismatch': 'the page showed a different scenario',
  'parameter-mismatch': 'the page did not confirm the selected configuration',
  timeout: 'the page didn’t confirm it in time',
};
/** The toolbar's status after a requested scenario failed. */
export function scenarioFailureText(view, scenarioId, reason) {
  const why = REASONS[reason] || 'the page didn’t say why';
  return view && view.interactive ? 'Couldn’t apply the selected configuration: ' + why + '.'
    : 'Couldn’t open scenario ' + scenarioId + ': ' + why + '.';
}

/**
 * What a request does in this prototype: a page without an adapter answers `no-adapter` once the
 * annotation surface asks it (a legacy view) or at once (a live configuration); otherwise the page
 * confirms. A legacy view needs Annotate to be told anything, so a request turns it on.
 */
export function requestScenario(view, { annotate }) {
  if (!view) return { status: 'idle', annotate };
  const turnsOnAnnotate = !view.interactive;
  const asked = annotate || turnsOnAnnotate || view.interactive;
  if (view.adapter === false && asked) return { status: 'unsupported', reason: 'no-adapter', annotate: annotate || turnsOnAnnotate };
  return { status: 'confirmed', annotate: annotate || turnsOnAnnotate };
}
/** Whether the scenario and parameter controls show: hidden once the page reports no adapter. */
export const scenarioControlsShown = (view, status) => !!view && !(status && status.reason === 'no-adapter');

/** The Annotate switch's name and tooltip; a reader without `comment.write` gets the read-only form. */
export function annotateToggleLabel(canComment, active) {
  if (canComment) return active ? 'Annotate: click an element or select text to comment. Press Escape to return to the live page.' : 'Annotate: comment on the page';
  return active ? 'Showing comments on the page. Press Escape to return to the live page.' : 'Show comments on the page';
}

/**
 * The location line under a comment, or null: an unopened scenario, another scenario of this view,
 * a region the page no longer holds, or a legacy comment without an anchor in this version.
 */
export function threadLocationLine(thread, view, { failedScenario } = {}) {
  const v = thread.view;
  if (v && view && v.viewId === view.id) {
    if (failedScenario && failedScenario === v.scenarioId) return 'Location unavailable: scenario ' + v.scenarioId + ' couldn’t be opened';
    if (v.scenarioId && v.scenarioId !== (view.shownScenario || null)) return 'In scenario ' + v.scenarioId + ' · ' + v.scenarioLabel;
    if (v.regionMissing) return 'Location unavailable: the region isn’t on the page';
  }
  if (thread.unanchored) return 'Location unavailable in this version';
  return null;
}
/** "Made in the dark theme" / "Made in high contrast" for a comment of the view on screen. */
export function threadThemeLine(thread, view) {
  const v = thread.view;
  if (!v || !view || v.viewId !== view.id) return null;
  const theme = v.state && v.state.theme;
  return theme === 'dark' ? 'Made in the dark theme' : theme === 'high-contrast' ? 'Made in high contrast' : null;
}
/** Whether a comment belongs to another scenario of the view on screen (its "Open scenario N" action). */
export const otherScenario = (thread, view) => !!(thread.view && view && thread.view.viewId === view.id && thread.view.scenarioId
  && thread.view.scenarioId !== (view.shownScenario || null));

/** Source provenance for Details: `verified`, `mismatch`, `not-recorded`, `invalid` or `unsupported-version`. */
export function provenanceNote(record) {
  if (!record || record.status === 'not-recorded') return 'Source not recorded. Agents can inspect this version but not edit its source.';
  if (record.status === 'invalid') return 'The source record is invalid: ' + record.diagnostic;
  if (record.status === 'unsupported-version') return 'The source record uses unsupported version ' + record.version + '.';
  return null;
}
