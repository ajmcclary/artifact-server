import {type CSSProperties, type ReactElement, useMemo, useState} from "react";

import type {Project} from "@/api/client";
import {
  Alert,
  Button,
  GroupBand,
  Input,
  PageScaffold,
  StateRow,
  SurfaceState,
  Tabs,
} from "@/arkcase";
import {navigateReview, workspaceHref} from "@/review/review-routes";
import {useAnnounce} from "@/ui/announcer";
import {CopyAction} from "@/ui/copy-action";
import {useDensity} from "@/ui/density";

import {
  describeQueueEntry,
  filterQueue,
  pluralize,
  queueCounts,
  queueFilters,
  queueKey,
  shortArtifactId,
  type QueueEntry,
  type QueueFilter,
} from "./queue-model";
import {useReviewQueue} from "./use-review-queue";

const filterLabels = {
  agent: "With an agent",
  all: "All",
  conversations: "Has conversations",
} satisfies Record<QueueFilter, string>;

const groupBands = [
  {
    group: "agent",
    label: "With an agent",
    note: "a send is queued, claimed or delivered",
    tone: "running",
  },
  {
    group: "conversations",
    label: "Has conversations",
    note: "conversations recorded, no send in progress",
    tone: "neutral",
  },
] as const;

const toolbarStyle = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
} satisfies CSSProperties;
const searchStyle = {maxWidth: "100%", width: 260} satisfies CSSProperties;
const orderNoteStyle = {
  color: "var(--text-secondary)",
  fontSize: "var(--font-size-xs, 12px)",
  marginLeft: "auto",
} satisfies CSSProperties;
const groupsStyle = {display: "flex", flexDirection: "column", gap: 14} satisfies CSSProperties;
const groupStyle = {
  background: "var(--surface-card)",
  border: "1px solid var(--border-color)",
  borderRadius: 5,
  overflow: "hidden",
} satisfies CSSProperties;
const rowWrapStyle = {position: "relative"} satisfies CSSProperties;
const copySlotStyle = {
  display: "inline-flex",
  position: "absolute",
  right: 10,
  top: 10,
} satisfies CSSProperties;
const nameStyle = {fontWeight: 600} satisfies CSSProperties;
const noteStyle = {
  color: "var(--text-secondary)",
  fontSize: "var(--font-size-xs, 12px)",
  lineHeight: 1.55,
  margin: 0,
  maxWidth: "74ch",
} satisfies CSSProperties;
const comfortableRow = {cursor: "pointer", paddingRight: 48} satisfies CSSProperties;
const compactRow = {cursor: "pointer", padding: "7px 48px 7px 16px"} satisfies CSSProperties;

function openEntry(entry: QueueEntry): void {
  navigateReview(workspaceHref({
    artifactId: entry.artifact.artifact.id,
    path: null,
    projectId: entry.project.id,
    versionId: null,
    view: null,
  }));
}

/** The landing screen: artifacts with a send in flight or with conversations, across projects. */
export function ReviewQueueScreen({projects}: {readonly projects: readonly Project[]}): ReactElement {
  const queue = useReviewQueue(projects);
  const announce = useAnnounce();
  const density = useDensity();
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [query, setQuery] = useState("");
  const matching = useMemo(() => filterQueue(queue.entries, "all", query), [queue.entries, query]);
  const visible = useMemo(() => filterQueue(matching, filter, ""), [matching, filter]);
  const counts = queueCounts(matching);
  const filtered = filter !== "all" || query.trim() !== "";
  const projectCount = new Set(queue.entries.map((entry) => entry.project.id)).size;
  const countLine = queue.phase !== "ready"
    ? "Reading every project"
    : filtered
      ? `${visible.length} of ${pluralize(queue.entries.length, "artifact", "artifacts")}`
      : `${pluralize(queue.entries.length, "artifact", "artifacts")} · ${pluralize(projectCount, "project", "projects")}`;
  const rowStyle = density === "compact" ? compactRow : comfortableRow;

  const selectFilter = (id: string): void => {
    const next = queueFilters.find((candidate) => candidate === id);
    if (next === undefined) return;
    setFilter(next);
    announce(`${filterLabels[next]} shown.`);
  };
  const clearFilters = (): void => {
    setFilter("all");
    setQuery("");
    announce("Queue filter cleared.");
  };

  return (
    <PageScaffold
      actions={(
        <Button icon="bi-arrow-clockwise" onClick={queue.refresh} outline size="sm" variant="secondary">
          Refresh queue
        </Button>
      )}
      bodyPadding="16px 20px 24px"
      maxWidth="none"
      meta={countLine}
      title="Review queue"
    >
      <div style={toolbarStyle}>
        <Tabs
          active={filter}
          onChange={selectFilter}
          tabs={queueFilters.map((id) => ({count: counts[id], id, label: filterLabels[id]}))}
        />
        <Input
          aria-label="Filter the review queue"
          icon="bi-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by artifact, project or identifier"
          size="sm"
          style={searchStyle}
          type="search"
          value={query}
        />
        {query === "" ? null : (
          <Button
            icon="bi-x"
            onClick={() => {
              setQuery("");
              announce("Queue filter cleared.");
            }}
            size="sm"
            variant="link"
          >
            Clear
          </Button>
        )}
        <span style={orderNoteStyle}>Latest send first, then most conversations</span>
      </div>
      {queue.phase === "ready" && queue.unreadable.length > 0 ? (
        <Alert action={{label: "Retry", onClick: queue.refresh}} variant="warning">
          {`Artifact Server could not read ${queue.unreadable.map((project) => project.name).join(", ")}. `}
          {queue.unreadable.length === 1 ? "Its artifacts are" : "Their artifacts are"} missing from the queue.
        </Alert>
      ) : null}
      {queue.phase === "ready" && visible.length > 0 ? (
        <div style={groupsStyle}>
          {groupBands.map((band) => {
            const rows = visible.filter((entry) => entry.group === band.group);
            if (rows.length === 0) return null;
            return (
              <section aria-label={band.label} key={band.group} style={groupStyle}>
                <GroupBand count={rows.length} label={band.label} note={band.note} tone={band.tone} />
                {rows.map((entry) => {
                  const copy = describeQueueEntry(entry);
                  const artifactId = entry.artifact.artifact.id;
                  return (
                    <div key={queueKey(entry.project.id, artifactId)} style={rowWrapStyle}>
                      <StateRow
                        id={shortArtifactId(artifactId)}
                        meta={[...copy.meta]}
                        onClick={() => openEntry(entry)}
                        sentence={(
                          <>
                            <strong style={nameStyle}>{entry.artifact.artifact.name}</strong>
                            {` — ${copy.sentence}`}
                          </>
                        )}
                        state={copy.state}
                        style={rowStyle}
                        tone={copy.tone}
                      />
                      <span style={copySlotStyle}>
                        <CopyAction label={`Copy identifier ${artifactId}`} text={artifactId} />
                      </span>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      ) : (
        <SurfaceState
          count={visible.length}
          emptyBody="An artifact appears here once it has a conversation or a send to an agent."
          emptyIcon="bi-inbox"
          emptyTitle="Nothing to review yet"
          failedBody="Artifact Server did not answer. Nothing was changed."
          failedTitle="Could not load the review queue"
          filterBody="No artifact in this view matches. Clear the filter to see the whole queue."
          filtered={filtered}
          loadingStyle="spinner"
          loadingTitle="Loading the review queue"
          noun="artifacts"
          onClear={clearFilters}
          onRetry={queue.refresh}
          phase={queue.phase}
          titleLevel={3}
        />
      )}
      {queue.truncated ? (
        <p style={noteStyle}>
          Each project contributes its 25 most-discussed artifacts and its 100 most recent sends.
          Open a project to see the rest of its artifacts.
        </p>
      ) : null}
    </PageScaffold>
  );
}
