import React from "react";

import {Button, Disclosure, FileList, GroupBand, Input, Modal, Popover, SelectableRow, SurfaceState} from "@/arkcase";
import {createReviewUI} from "@/arkcase/review-ui/review-ui.jsx";

/**
 * The project-owned review controls (contract correction 4), built once from
 * the application's React and the vendored ArkCase components.
 */
const reviewUi = createReviewUI(React, {
  Button,
  Disclosure,
  FileList,
  GroupBand,
  Input,
  Modal,
  Popover,
  SelectableRow,
  SurfaceState,
});

export const {ArtifactLinks, FileGroups, PagePicker} = reviewUi;
export type {ArtifactFile, ArtifactLinkRow, ArtifactPage as ReviewPage, PagePickerProps} from "@/arkcase/review-ui/review-ui.jsx";
