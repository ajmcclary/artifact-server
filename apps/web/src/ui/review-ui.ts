import React from "react";

import {
  AnnotationPin,
  AutoGrid,
  Button,
  CommentThread,
  Disclosure,
  FileList,
  GroupBand,
  Input,
  Menu,
  MetricCard,
  Modal,
  Popover,
  ScrollDock,
  SectionHeading,
  SegmentedControl,
  SelectableRow,
  StatusPill,
  SurfaceState,
  Timeline,
} from "@/arkcase";
import {createReviewUI} from "@/arkcase/review-ui/review-ui.jsx";

/**
 * The project-owned review controls (contract correction 4), built once from
 * the application's React and the vendored ArkCase components.
 */
const reviewUi = createReviewUI(React, {
  AnnotationPin,
  AutoGrid,
  Button,
  CommentThread,
  Disclosure,
  FileList,
  GroupBand,
  Input,
  Menu,
  MetricCard,
  Modal,
  Popover,
  ScrollDock,
  SectionHeading,
  SegmentedControl,
  SelectableRow,
  StatusPill,
  SurfaceState,
  Timeline,
});

export const {
  ActivityFeed,
  ActivityHeader,
  ActivityToolbar,
  ArtifactLinks,
  DesignGallery,
  FileGroups,
  PagePicker,
} = reviewUi;
export type {
  ActivityEvent,
  ActivityFeedProps,
  ActivityHeaderProps,
  ActivityMetric,
  ActivityToolbarProps,
  ArtifactFile,
  ArtifactLinkRow,
  ArtifactPage as ReviewPage,
  GalleryItem,
  PagePickerProps,
} from "@/arkcase/review-ui/review-ui.jsx";
