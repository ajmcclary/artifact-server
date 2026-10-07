import {createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from "react";

import {api, ApiError} from "../../api/client.ts";
import type {ReviewView, ViewsOutcome} from "../../api/views.ts";
import type {ViewStateMessage} from "../../review-frame/protocol.ts";
import {
  reduceViewState,
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
  /** False until the version's views outcome is known; the preview waits for it before init. */
  readonly loaded: boolean;
  readonly onScreen: ScenarioStatus;
  readonly outcome: ViewsOutcome | null;
  readonly report: (message: ViewStateMessage) => void;
  readonly requestScenario: (scenarioId: string, parameters?: Readonly<Record<string, ParameterValue>>) => void;
  readonly requested: ScenarioRequestState | null;
  readonly view: ReviewView | null;
}

const idle: ScenarioStatus = {reason: null, requestId: null, scenarioId: null, status: "idle"};

const noScenarios: ScenarioSession = {
  beginRequest: () => undefined,
  loaded: true,
  onScreen: idle,
  outcome: null,
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
  path,
  projectId,
  versionId,
}: {
  readonly artifactId: string | null;
  readonly children: ReactNode;
  readonly initialScenarioId: string | null;
  readonly path: string | null;
  readonly projectId: string;
  readonly versionId: string | null;
}) {
  const [loaded, setLoaded] = useState<{readonly outcome: ViewsOutcome; readonly versionId: string} | null>(null);
  const [onScreen, setOnScreen] = useState<ScenarioStatus>(idle);
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
    // A new page or version starts unknown; the preview captures or restores it.
    setOnScreen(idle);
  }, [path, versionId]);

  const requestScenario = useCallback((scenarioId: string, parameters: Readonly<Record<string, ParameterValue>> = {}) => {
    setRequested((previous) => ({parameters, revision: (previous?.revision ?? 0) + 1, scenarioId}));
  }, []);
  const beginRequest = useCallback((requestId: string) => {
    setOnScreen((current) => ({...current, reason: null, requestId, status: "restoring"}));
  }, []);
  const report = useCallback((message: ViewStateMessage) => {
    if (view === null) return;
    setOnScreen((current) => reduceViewState(current, message, view));
  }, [view]);

  const loadedState = artifactId === null || versionId === null || outcome !== null;
  const value = useMemo<ScenarioSession>(() => ({
    beginRequest,
    loaded: loadedState,
    onScreen,
    outcome,
    report,
    requestScenario,
    requested,
    view,
  }), [beginRequest, loadedState, onScreen, outcome, report, requestScenario, requested, view]);
  return <ScenarioSessionContext.Provider value={value}>{children}</ScenarioSessionContext.Provider>;
}
