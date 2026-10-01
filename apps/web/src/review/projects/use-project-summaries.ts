import {useCallback, useEffect, useState} from "react";

import {api} from "@/api/client";

import type {ProjectSummaryCounts} from "./projects-model.ts";

/** Per-project counts for the Projects list; `items` stays null until the first answer. */
export interface ProjectSummaries {
  readonly failed: boolean;
  readonly items: readonly ProjectSummaryCounts[] | null;
  readonly reload: () => void;
}

/**
 * Reads the installation activity summary on mount, whenever the project set
 * changes (`projectsKey`), and when the window regains focus. A failure keeps
 * the last good counts; the list still renders every project by name.
 */
export function useProjectSummaries(projectsKey: string): ProjectSummaries {
  const [items, setItems] = useState<readonly ProjectSummaryCounts[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    void (async (): Promise<void> => {
      try {
        const summary = await api.activitySummary();
        if (!current) return;
        setItems(summary.projects);
        setFailed(false);
      } catch {
        if (current) setFailed(true);
      }
    })();
    return () => {
      current = false;
    };
  }, [generation, projectsKey]);

  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  return {failed, items, reload};
}
