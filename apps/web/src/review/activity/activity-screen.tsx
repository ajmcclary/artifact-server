import {useEffect, useState, type CSSProperties, type MouseEvent, type Ref} from "react";

import type {Project, Session} from "@/api/client";
import {IconButton, Popover, Tooltip} from "@/arkcase";
import {activityHref, navigateReview, type ActivityFilters} from "@/review/review-routes";
import {useViewportWidth} from "@/review/workspace/use-viewport-size";
import {isPhoneWidth} from "@/review/workspace/workspace-layout";
import {ActivityHeader, ActivityToolbar} from "@/ui/review-ui";
import {CopyableCode} from "@/ui/copyable-code";

import {ActivityFeedBody} from "./activity-feed-section";
import {useActivityFacets} from "./use-activity-facets";
import {useActivityFeed} from "./use-activity-feed";
import {useActivitySummary} from "./use-activity-summary";

const screenStyle = {margin: "0 auto", maxWidth: 1180, padding: "0 20px 48px", width: "100%"} satisfies CSSProperties;
const phoneScreenStyle = {...screenStyle, padding: "0 16px 32px"} satisfies CSSProperties;
/** A phone's fixed app bar; the docked toolbar and the day caps pin beneath it. */
const phoneAppBarHeight = 52;
const segmentIds = {"All": "all", "Needs you": "needs_you", "With an agent": "with_agent"} as const;
const segmentLabels = {all: "All", needs_you: "Needs you", with_agent: "With an agent"} as const;
type ToolbarType = "comments" | "versions" | "agents" | "access";
const toolbarTypes: readonly ToolbarType[] = ["comments", "versions", "agents", "access"];

/** The toolbar reports labels and ids as strings; keep only the ones this screen knows. */
function segmentOf(label: string): ActivityFilters["segment"] {
  return label === "Needs you" || label === "With an agent" ? segmentIds[label] : "all";
}
function toolbarTypesOf(ids: readonly string[]): ToolbarType[] {
  return ids.flatMap((id) => toolbarTypes.find((type) => type === id) ?? []);
}
const searchDebounceMilliseconds = 250;

/** What Popover adds to the trigger it clones: its ref, press handler and dialog state. */
interface PopoverTriggerProps {
  readonly "aria-expanded"?: boolean;
  readonly "aria-haspopup"?: "dialog";
  readonly onClick?: (event: MouseEvent) => void;
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * The header's icon-only Publish trigger. The Popover clones it with its ref, press handler
 * and ARIA state, which pass through to the button rather than the tooltip around it.
 */
function PublishButton(trigger: PopoverTriggerProps) {
  return (
    <Tooltip label="Publish artifact" placement="bottom">
      <IconButton {...trigger} ariaLabel="Publish artifact" icon="bi-upload" size="sm" variant="primary" />
    </Tooltip>
  );
}

/** Everything that happened across the installation, newest first, with what needs you one click away. */
export function ActivityScreen({filters, projects, session}: {
  readonly filters: ActivityFilters; readonly projects: readonly Project[]; readonly session: Session;
}) {
  const feed = useActivityFeed(filters);
  const phone = isPhoneWidth(useViewportWidth());
  const {phase: summaryPhase, reload: reloadSummary, summary} = useActivitySummary([]);
  const {facets, reload: reloadFacets} = useActivityFacets(filters);
  const [query, setQuery] = useState(filters.q);
  const [dock, setDock] = useState(0);
  const [publishOpen, setPublishOpen] = useState(false);
  // A filter choice is a history step Back can undo. Starting a search is one step too; refining it replaces that step.
  const change = (next: Partial<ActivityFilters>): void => navigateReview(activityHref({...filters, ...next}));
  const changeQuery = (q: string): void => navigateReview(activityHref({...filters, q}), {replace: filters.q !== ""});
  useEffect(() => setQuery(filters.q), [filters.q]);
  useEffect(() => {
    if (query.trim() === filters.q) return undefined;
    const timer = setTimeout(() => changeQuery(query.trim().slice(0, 100)), searchDebounceMilliseconds);
    return () => clearTimeout(timer);
  });
  const filtered = filters.segment !== "all" || filters.people.length > 0 || filters.projects.length > 0 || filters.types.length > 0 || filters.q !== "";
  const count = (value: number | undefined): string => summaryPhase === "ready" && value !== undefined ? String(value) : "—";
  const command = "artifactserver publish ./dist";
  // People who acted, from the server's counts; agents are the service principals (API keys and bridges).
  const people = (facets?.people ?? []).map((person) => ({
    agent: person.kind === "service", count: person.count, id: person.id, name: person.name, self: person.id === session.principal.id,
  }));
  // The server's entry counts (one per conversation) for these filters and in all; omitted until known.
  const counted = facets === null ? {} : {shown: facets.matching, total: facets.total};

  return (
    <section aria-label="Activity" style={phone ? phoneScreenStyle : screenStyle}>
      <ActivityHeader
        action={(
          <Popover label="Publish artifact" onOpenChange={setPublishOpen} open={publishOpen} placement="bottom-end"
            trigger={<PublishButton />}>
            <CopyableCode code={command} copiedLabel="Publish command copied" copyLabel="Copy publish command" tone="navy" />
          </Popover>
        )}
        metrics={[
          {id: "needs", label: "Needs you", onClick: () => change({segment: filters.segment === "needs_you" ? "all" : "needs_you"}), pressed: filters.segment === "needs_you", value: count(summary?.needsYou)},
          {id: "agent", label: "With an agent", onClick: () => change({segment: filters.segment === "with_agent" ? "all" : "with_agent"}), pressed: filters.segment === "with_agent", value: count(summary?.withAgent)},
          {id: "open", label: "Open conversations", value: count(summary?.openConversations)},
          {id: "review", label: "Artifacts in review", value: count(summary?.artifactsInReview)},
        ]}
        compact={phone}
        title="Activity"
      />
      <ActivityToolbar
        counts={summary === null ? {} : {"Needs you": summary.needsYou, "With an agent": summary.withAgent}}
        {...counted}
        onClearFilters={() => navigateReview(activityHref())}
        onHeight={setDock}
        onPeople={(ids) => change({people: ids})}
        onProjects={(ids) => change({projects: ids})}
        onQuery={setQuery}
        onSegment={(label) => change({segment: segmentOf(label)})}
        onTypes={(ids) => change({types: toolbarTypesOf(ids)})}
        people={people}
        phone={phone}
        projects={projects.map((project) => ({archived: project.archivedAt !== null, id: project.id, name: project.name}))}
        query={query}
        segment={segmentLabels[filters.segment]}
        selectedPeople={[...filters.people]}
        selectedProjects={[...filters.projects]}
        top={phone ? phoneAppBarHeight : 0}
        types={toolbarTypesOf(filters.types)}
      />
      <ActivityFeedBody
        feed={feed} filtered={filtered} label="Activity"
        onClearFilters={() => navigateReview(activityHref())}
        onChanged={() => { reloadSummary(); reloadFacets(); }}
        onRetry={() => { feed.reload(); reloadSummary(); reloadFacets(); }}
        principalId={session.principal.id}
        stickyTop={dock + (phone ? phoneAppBarHeight : 0)}
      />
    </section>
  );
}
