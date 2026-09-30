import {PanelStore, type DisplayLadder} from "@/arkcase";

import {REVIEW_PANEL_STORAGE_KEY} from "./shell-layout-keys.ts";

/** Artifact Server's display ladder: mobile < 768, tablet < 1024, laptop < 1440, desktop ≥ 1440. */
export const REVIEW_DISPLAY_LADDER: DisplayLadder = {
  compact: 1024,
  desktop: 1440,
  laptop: 1024,
  mobile: 768,
};

export {NAV_PANEL_ID, navigationWidth, REVIEW_PANEL_STORAGE_KEY} from "./shell-layout-keys.ts";

/** Pins and widths of the navigation and review panes; it writes only when the reader changes one. */
export const reviewPanelStore = PanelStore({key: REVIEW_PANEL_STORAGE_KEY});
