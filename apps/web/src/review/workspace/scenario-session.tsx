import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from "react";

import {api, ApiError} from "../../api/client.ts";
import type {ReviewView, ViewsOutcome} from "../../api/views.ts";
import type {ViewStateMessage} from "../../review-frame/protocol.ts";
import {
  reduceConfigurationState,
  type ConfigurationStatus,
  viewForPath,
  type ParameterValue,
  type ScenarioStatus,
} from "./scenario-model.ts";

/** Waits before re-reading a views outcome that failed transiently. */
const viewsReadRetryDelays = [1_000, 2_000, 4_000] as const;

export interface ScenarioRequestState {
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  /** Bumped by every request, so asking for the same scenario again restores again. */
  readonly revision: number;
  readonly scenarioId: string;
}

export interface ScenarioSession {
  readonly beginRequest: (requestId: string) => void;
  /** The annotation surface closed: nothing it confirmed is on screen any more. */
  readonly clearOnScreen: () => void;
  /** False until the version's views outcome is known; the preview waits for it before init. */
  readonly loaded: boolean;
  readonly onScreen: ScenarioStatus;
  readonly outcome: ViewsOutcome | null;
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  /** Follow a confirmed page change without issuing another restore. */
  readonly followScenario: (scenarioId: string, parameters: Readonly<Record<string, ParameterValue>>) => void;
  readonly report: (message: ViewStateMessage) => void;
  readonly requestScenario: (scenarioId: string, parameters?: Readonly<Record<string, ParameterValue>>) => void;
  readonly requested: ScenarioRequestState | null;
  readonly view: ReviewView | null;
}

const idle: ScenarioStatus = {reason: null, requestId: null, scenarioId: null, status: "idle"};

const noScenarios: ScenarioSession = {
  beginRequest: () => undefined,
  clearOnScreen: () => undefined,
  loaded: true,
  onScreen: idle,
  outcome: null,
  parameters: {},
  followScenario: () => undefined,
  report: () => undefined,
  requestScenario: () => undefined,
  requested: null,
  view: null,
};

const ScenarioSessionContext = createContext<ScenarioSession>(noScenarios);

/** The open page's designed scenarios, what is on screen, and what was asked for. */
export function useScenarioSession(): ScenarioSession {
  return useContext(ScenarioSessionContext);
}

export function ScenarioSessionProvider({
  artifactId,
  children,
  initialScenarioId,
  onSelectPath,
  path,
  projectId,
  versionId,
}: {
  readonly artifactId: string | null;
  readonly children: ReactNode;
  readonly initialScenarioId: string | null;
  readonly onSelectPath: (path: string) => void;
  readonly path: string | null;
  readonly projectId: string;
  readonly versionId: string | null;
}) {
  const [loaded, setLoaded] = useState<{readonly outcome: ViewsOutcome; readonly versionId: string} | null>(null);
  const [screen, setScreen] = useState<ConfigurationStatus>({onScreen: idle, parameters: {}});
  const {onScreen, parameters} = screen;
  const previousView = useRef<string | null>(null);
  const [requested, setRequested] = useState<ScenarioRequestState | null>(
    initialScenarioId === null ? null : {parameters: {}, revision: 1, scenarioId: initialScenarioId},
  );

  useEffect(() => {
    if (artifactId === null || versionId === null || projectId === "") return undefined;
    let current = true;
    // Outcomes are per immutable version, so one read per version suffices.
    void (async () => {
      let outcome: ViewsOutcome = {diagnostic: "Views could not be read.", status: "invalid"};
      for (let attempt = 0; ; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop -- each retry waits for the previous read
          outcome = await api.versionViews(projectId, artifactId, versionId);
          break;
        } catch (cause) {
          // A refusal is final; a dropped connection or a server failure may pass.
          const transient = !(cause instanceof ApiError) || cause.status >= 500;
          if (!current || !transient || attempt >= viewsReadRetryDelays.length) break;
          // eslint-disable-next-line no-await-in-loop -- bounded, increasing backoff
          await new Promise((resolve) => setTimeout(resolve, viewsReadRetryDelays[attempt]));
        }
      }
      // An unreadable outcome leaves the page reviewable without views.
      if (current) setLoaded({outcome, versionId});
    })();
    return () => {
      current = false;
    };
  }, [artifactId, projectId, versionId]);

  const outcome = loaded !== null && loaded.versionId === versionId ? loaded.outcome : null;
  const view = viewForPath(outcome, path);

  useEffect(() => {
    if (view === null || versionId === null) return;
    const identity = `${versionId}/${view.viewId}`;
    if (previousView.current !== null && previousView.current !== identity) setRequested(null);
    previousView.current = identity;
    if (path !== view.path) onSelectPath(view.path);
  }, [onSelectPath, path, versionId, view]);

  useEffect(() => {
    // A new page or version starts unknown; the preview captures or restores it.
    setScreen({onScreen: idle, parameters: {}});
  }, [path, versionId]);

  const requestScenario = useCallback((scenarioId: string, selectedParameters?: Readonly<Record<string, ParameterValue>>) => {
    setRequested((previous) => ({parameters: selectedParameters ?? previous?.parameters ?? {}, revision: (previous?.revision ?? 0) + 1, scenarioId}));
  }, []);
  const followScenario = useCallback((scenarioId: string, selectedParameters: Readonly<Record<string, ParameterValue>>) => {
    setRequested((previous) => {
      if (previous?.scenarioId === scenarioId && JSON.stringify(previous.parameters) === JSON.stringify(selectedParameters)) return previous;
      return {parameters: selectedParameters, revision: previous?.revision ?? 0, scenarioId};
    });
  }, []);
  const beginRequest = useCallback((requestId: string) => {
    setScreen((current) => ({...current, onScreen: {...current.onScreen, reason: null, requestId, status: "restoring"}}));
  }, []);
  const clearOnScreen = useCallback(() => setScreen(current => ({...current, onScreen: idle})), []);
  const report = useCallback((message: ViewStateMessage) => {
    if (view === null) return;
    setScreen(current => reduceConfigurationState(current, message, view));
  }, [view]);

  const loadedState = artifactId === null || versionId === null || outcome !== null;
  const value = useMemo<ScenarioSession>(() => ({
    beginRequest,
    clearOnScreen,
    loaded: loadedState,
    onScreen,
    outcome,
    parameters,
    followScenario,
    report,
    requestScenario,
    requested,
    view,
  }), [beginRequest, clearOnScreen, followScenario, loadedState, onScreen, outcome, parameters, report, requestScenario, requested, view]);
  return <ScenarioSessionContext.Provider value={value}>{children}</ScenarioSessionContext.Provider>;
}
