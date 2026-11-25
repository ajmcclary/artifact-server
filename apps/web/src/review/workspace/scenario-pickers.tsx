import type {CSSProperties} from "react";

import {Select} from "@/arkcase";

import {scenarioFailureText} from "./scenario-model.ts";
import type {ScenarioSession} from "./scenario-session.tsx";

const configurationPickerStyle = {maxWidth: 240} satisfies CSSProperties;
const scenarioStatusStyle = {color: "var(--pill-danger-fg)", fontSize: "var(--font-size-xs, 12px)", maxWidth: 320, overflowWrap: "anywhere", whiteSpace: "normal"} satisfies CSSProperties;

export interface ScenarioPickersProps {
  /** Called after each request; the member toolbar opens Annotate for views that restore only there. */
  readonly afterRequest?: () => void;
  readonly session: ScenarioSession;
}

/**
 * The page's own designed configuration: its scenario and each declared parameter, as the
 * compact viewer selects the Review toolbar uses. Nothing renders for a page without views.
 */
export function ScenarioPickers({afterRequest, session}: ScenarioPickersProps) {
  const view = session.view;
  if (view === null) return null;
  // A page without an adapter is reviewed exactly as before: no scenario controls.
  const noAdapter = session.onScreen.status === "unsupported" && session.onScreen.reason === "no-adapter";
  const requestedScenario = session.requested?.scenarioId ?? null;
  const failure = requestedScenario !== null
    && (session.onScreen.status === "failed" || session.onScreen.status === "unsupported")
    ? scenarioFailureText(requestedScenario, session.onScreen.reason, view.interactive === true)
    : null;
  return (
    <>
      {noAdapter ? null : (
        <Select
          aria-label={view.scenarioLabel ?? "Designed scenario"}
          fit="selected"
          onChange={(event) => {
            session.requestScenario(event.currentTarget.value);
            afterRequest?.();
          }}
          options={view.scenarios.map((option) => ({
            label: view.scenarioLabel === undefined ? `${option.scenarioId} · ${option.label}` : option.label,
            value: option.scenarioId,
          }))}
          placeholder="Scenario"
          size="viewer"
          style={configurationPickerStyle}
          value={session.onScreen.scenarioId ?? requestedScenario ?? ""}
        />
      )}
      {noAdapter ? null : view.parameters.map((parameter) => {
        const chosen = session.onScreen.status === "restoring"
          ? session.requested?.parameters[parameter.name] ?? parameter.default
          : session.parameters[parameter.name] ?? parameter.default;
        return (
          <Select
            aria-label={parameter.label ?? parameter.name}
            fit="selected"
            key={parameter.name}
            onChange={(event) => {
              const option = parameter.values[Number(event.currentTarget.value)];
              if (option === undefined) return;
              session.requestScenario(requestedScenario ?? session.onScreen.scenarioId ?? view.defaultScenarioId,
                {...session.parameters, ...session.requested?.parameters, [parameter.name]: option.value});
              afterRequest?.();
            }}
            options={parameter.values.map((option, index) => ({label: option.label ?? String(option.value), value: String(index)}))}
            size="viewer"
            style={configurationPickerStyle}
            value={String(parameter.values.findIndex((option) => option.value === chosen))}
          />
        );
      })}
      {failure === null ? null : <span role="status" style={scenarioStatusStyle}>{failure}</span>}
    </>
  );
}
