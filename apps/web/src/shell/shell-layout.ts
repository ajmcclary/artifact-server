import {PanelStore, type DisplayLadder} from "@/arkcase";

/** Artifact Server's display ladder: mobile < 768, tablet < 1024, laptop < 1440, desktop ≥ 1440. */
export const REVIEW_DISPLAY_LADDER: DisplayLadder = {
  compact: 1024,
  desktop: 1440,
  laptop: 1024,
  mobile: 768,
};

/** The one localStorage key under which the review panes remember pins and widths. */
export const REVIEW_PANEL_STORAGE_KEY = "artifact-review-panels";

/** The navigation column's pin, stored under `REVIEW_PANEL_STORAGE_KEY`. */
export const NAV_PANEL_ID = "navMenu";

/** Pins and widths of the navigation and review panes; it writes only when the reader changes one. */
export const reviewPanelStore = PanelStore({key: REVIEW_PANEL_STORAGE_KEY});
