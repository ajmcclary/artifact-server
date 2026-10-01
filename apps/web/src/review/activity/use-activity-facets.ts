import {useCallback, useEffect, useRef, useState} from "react";

import {api, type ActivityFacets} from "@/api/client";
import type {ActivityFilters} from "@/review/review-routes";

/** The Activity filter row's counts, or null until read (and after a failed read). */
export interface ActivityFacetsState {
  readonly facets: ActivityFacets | null;
  readonly reload: () => void;
}

/**
 * The server's counts behind the Activity filter row: everyone who acted, every entry, and the
 * entries these filters match. While new filters are being counted the last counts stay, so the
 * chips and the live count never blink; a failed read drops them rather than showing a guess.
 */
export function useActivityFacets(filters: ActivityFilters): ActivityFacetsState {
  const key = JSON.stringify(filters);
  const [facets, setFacets] = useState<ActivityFacets | null>(null);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const mine = ++generation.current;
    void (async () => {
      try {
        const next = await api.activityFacets({
          people: [...filters.people], projects: [...filters.projects], q: filters.q, segment: filters.segment, types: [...filters.types],
        });
        if (generation.current === mine) setFacets(next);
      } catch {
        if (generation.current === mine) setFacets(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the filters' value identity
  }, [key]);
  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return {facets, reload};
}
