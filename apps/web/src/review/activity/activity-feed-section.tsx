import {useMemo} from "react";

import {SurfaceState} from "@/arkcase";
import {emptyActivityFilters, type ActivityFilters} from "@/review/review-routes";

import {ActivityFeedPanel} from "./activity-feed-panel";
import {ActivityThumbnail} from "./activity-thumbnail";
import {type ActivityFeedState, useActivityFeed} from "./use-activity-feed";

/** One feed's loading, failure, empty and loaded states. The empty state comes from the vendored feed. */
export function ActivityFeedBody({feed, filtered, label, onClearFilters, onRetry, principalId, stickyTop}: {
  readonly feed: ActivityFeedState; readonly filtered: boolean; readonly label: string; readonly onClearFilters: () => void;
  readonly onRetry: () => void; readonly principalId: string; readonly stickyTop: number;
}) {
  if (feed.phase === "loading") {
    return <SurfaceState loadingTitle="Loading activity" noun="events" phase="loading" skeleton={4} />;
  }
  if (feed.phase === "failed") {
    return (
      <SurfaceState failedBody="Activity could not be read." failedTitle="Activity could not load" noun="events"
        onRetry={onRetry} phase="failed" />
    );
  }
  return (
    <ActivityFeedPanel
      feed={feed} filtered={filtered} label={label} onClearFilters={onClearFilters}
      principalId={principalId} renderThumbnail={(event) => <ActivityThumbnail event={event} />} stickyTop={stickyTop}
    />
  );
}

/** The feed narrowed to one project, or every project when `projectId` is null. Its filters are not in the URL. */
export function ActivityFeedSection({principalId, projectId}: {readonly principalId: string; readonly projectId: string | null}) {
  const filters = useMemo<ActivityFilters>(
    () => ({...emptyActivityFilters, projects: projectId === null ? [] : [projectId]}),
    [projectId],
  );
  const feed = useActivityFeed(filters);
  return (
    <ActivityFeedBody
      feed={feed} filtered={false} label={projectId === null ? "Activity" : "Project activity"}
      onClearFilters={() => undefined} onRetry={feed.reload} principalId={principalId} stickyTop={0}
    />
  );
}
