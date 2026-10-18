import {useCallback, useEffect, useRef, useState, type RefObject} from "react";
import {createPageChannel, type PageChannel} from "../../review-frame/page-channel.ts";
import {pageMessageSchema, type PageState} from "../../review-frame/page-protocol.ts";
import {captureProps, parametersFromProps, restorePropsFor} from "./scenario-model.ts";
import type {ScenarioSession} from "./scenario-session.tsx";

/** Only explicitly enabled, declared controls can address an exact live content frame. */
export function useLiveViewChannel({active, documentKey, frame, origin, session}: {
  readonly active: boolean;
  readonly documentKey: string;
  readonly frame: RefObject<HTMLIFrameElement | null>;
  readonly origin: string | null;
  readonly session: ScenarioSession;
}) {
  const current = useRef(session);
  current.current = session;
  const channel = useRef<PageChannel | null>(null);
  const turn = useRef(0);
  const restoring = useRef(false);
  const loaded = useRef(false);
  const [helloRevision, setHelloRevision] = useState(0);
  const view = session.view;

  useEffect(() => {loaded.current = false;}, [active, documentKey, origin]);

  useEffect(() => {
    if (!active || origin === null || view?.interactive !== true) return undefined;
    const follow = (state: PageState) => {
      if (!view.scenarios.some(option => option.scenarioId === state.scenarioId)) return;
      current.current.report({outcome: "restored", requestId: null, state, type: "as-review-view-state", v: 1});
      current.current.followScenario(state.scenarioId ?? view.defaultScenarioId, parametersFromProps(view, state.props));
    };
    const connection = createPageChannel({
      onUnsupported: () => current.current.report({outcome: "unsupported", reason: "no-adapter", requestId: null, state: null, type: "as-review-view-state", v: 1}),
      onUnpromptedState: state => {if (!restoring.current) follow(state);},
      post: message => frame.current?.contentWindow?.postMessage(message, origin),
    });
    channel.current = connection;
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      const parsed = pageMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const supported = connection.supports();
      connection.receive(parsed.data);
      if (parsed.data.type === "as-page-hello" && supported !== true) setHelloRevision(revision => revision + 1);
    };
    window.addEventListener("message", receive);
    if (loaded.current) {
      connection.documentLoaded();
      frame.current?.contentWindow?.postMessage({pageVersion: 1, type: "as-page-welcome"}, origin);
    }
    return () => {
      ++turn.current;
      restoring.current = false;
      window.removeEventListener("message", receive);
      connection.dispose();
      if (channel.current === connection) channel.current = null;
    };
  }, [active, documentKey, frame, origin, view]);

  const revision = session.requested?.revision ?? 0;
  useEffect(() => {
    const connection = channel.current;
    if (!active || view?.interactive !== true || connection === null || connection.supports() !== true) return;
    const sequence = ++turn.current;
    const wanted = current.current.requested;
    if (wanted === null || wanted.revision === 0) {
      void connection.capture(captureProps(view)).then(state => {
        if (sequence !== turn.current || state === null) return undefined;
        current.current.report({outcome: "restored", requestId: null, state, type: "as-review-view-state", v: 1});
        if (state.scenarioId !== null && view.scenarios.some(option => option.scenarioId === state.scenarioId)) {
          current.current.followScenario(state.scenarioId, parametersFromProps(view, state.props));
        }
        return undefined;
      });
      return;
    }
    const props = restorePropsFor(view, wanted.scenarioId, wanted.parameters);
    if (props === null) return;
    const requestId = crypto.randomUUID();
    restoring.current = true;
    current.current.beginRequest(requestId);
    void connection.restore(props, wanted.scenarioId).then(result => {
      if (sequence !== turn.current || result.outcome === "superseded") return undefined;
      restoring.current = false;
      if (result.outcome === "restored") {
        current.current.report({outcome: "restored", requestId, state: result.state, type: "as-review-view-state", v: 1});
        current.current.followScenario(wanted.scenarioId, parametersFromProps(view, result.state.props));
      } else {
        current.current.report({outcome: result.outcome, reason: result.reason, requestId,
          state: result.outcome === "unsupported" ? null : result.state, type: "as-review-view-state", v: 1});
      }
      return undefined;
    });
  }, [active, documentKey, helloRevision, revision, view]);

  return useCallback(() => {
    loaded.current = true;
    channel.current?.documentLoaded();
    if (origin !== null && channel.current !== null) frame.current?.contentWindow?.postMessage({pageVersion: 1, type: "as-page-welcome"}, origin);
  }, [frame, origin]);
}
