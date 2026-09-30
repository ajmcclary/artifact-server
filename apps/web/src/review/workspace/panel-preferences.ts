import {useCallback, useState} from "react";

import {REVIEW_PANEL_STORAGE_KEY, reviewPanelStore} from "@/shell/shell-layout";

/**
 * Local convenience state for the review's two panes. It is written only
 * when the reviewer pins, unpins or resizes a pane, so a reviewer who never
 * touches them leaves nothing in the browser.
 */
export const panelStorageKey = REVIEW_PANEL_STORAGE_KEY;
export const catalogPanelId = "artifact-catalog";
export const inspectorPanelId = "artifact-inspector";

const store = reviewPanelStore;

/** One pane's remembered pin and width, and the setters that remember them. */
export interface PanelPreference {
  readonly pinned: boolean;
  readonly setPinned: (pinned: boolean) => void;
  readonly setWidth: (width: number | null) => void;
  readonly width: number | null;
}

/** Read one pane's preference once and keep it in React state; writes go through. */
export function usePanelPreference(id: string): PanelPreference {
  const [pinned, setPinnedState] = useState(() => store.pinned(id, true));
  const [width, setWidthState] = useState<number | null>(() => store.width(id) ?? null);
  const setPinned = useCallback((next: boolean): void => {
    setPinnedState(next);
    store.setPinned(id, next);
  }, [id]);
  const setWidth = useCallback((next: number | null): void => {
    setWidthState(next);
    store.setWidth(id, next);
  }, [id]);
  return {pinned, setPinned, setWidth, width};
}
