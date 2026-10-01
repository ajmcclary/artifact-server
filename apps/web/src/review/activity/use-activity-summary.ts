import {useCallback, useEffect, useRef, useState} from "react";

import {api, type ActivitySummary} from "@/api/client";

/** The counts behind the nav badge, metric cards and project rows; a failure never blocks the feed. */
export function useActivitySummary(projects: readonly string[]) {
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const generation = useRef(0);
  const key = projects.join("\u0000");
  const reload = useCallback(() => {
    const mine = ++generation.current;
    void (async () => {
      try {
        const next = await api.activitySummary(key === "" ? [] : key.split("\u0000"));
        if (generation.current !== mine) return;
        setSummary(next);
        setPhase("ready");
      } catch {
        if (generation.current === mine) setPhase("failed");
      }
    })();
  }, [key]);
  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return {phase, reload, summary};
}
