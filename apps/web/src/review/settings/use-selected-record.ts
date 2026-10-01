import {useCallback, useEffect, useState} from "react";

import {REVIEW_LOCATION_EVENT, writeReviewHistory} from "../review-routes.ts";
import {readSelectedRecord, selectedRecordHref} from "./admin-areas.ts";

/**
 * The record a detail pane shows, kept in `?selected=` so a refresh or a
 * shared link reopens it. Selecting replaces the history entry.
 */
export function useSelectedRecord(): readonly [string | null, (id: string | null) => void] {
  const [selected, setSelected] = useState(() => readSelectedRecord(window.location.search));
  useEffect(() => {
    const follow = (): void => setSelected(readSelectedRecord(window.location.search));
    window.addEventListener("popstate", follow);
    window.addEventListener(REVIEW_LOCATION_EVENT, follow);
    return () => {
      window.removeEventListener("popstate", follow);
      window.removeEventListener(REVIEW_LOCATION_EVENT, follow);
    };
  }, []);
  const select = useCallback((id: string | null): void => {
    writeReviewHistory(selectedRecordHref(window.location, id), "replace");
  }, []);
  return [selected, select] as const;
}
