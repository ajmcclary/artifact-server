import {useEffect, useState, type CSSProperties} from "react";

import type {Project, Session} from "@/api/client";
import {Button, PageScaffold, SurfaceState} from "@/arkcase";
import {CreateProjectModal} from "@/shell/create-project-modal";
import {useAnnounce} from "@/ui/announcer";

import {navigateReview, projectsHref, writeReviewHistory} from "../review-routes.ts";
import {ProjectSettings} from "../settings/project-settings.tsx";
import {settingsAccess} from "../settings/settings-view.ts";
import {usePanelPreference} from "../workspace/panel-preferences.ts";
import {useViewportWidth} from "../workspace/use-viewport-size.ts";
import {isPhoneWidth, workspaceBudget} from "../workspace/workspace-layout.ts";
import {ProjectListPanel} from "./project-list-panel.tsx";
import {initialProjectId, projectListPanelId, projectRows} from "./projects-model.ts";
import {useProjectSummaries} from "./use-project-summaries.ts";

export interface ProjectsScreenProps {
  readonly onCreateProject: (name: string) => Promise<Project>;
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projectId: string | null;
  readonly projects: readonly Project[];
  readonly session: Session;
}

/** Projects: the project list docked beside the selected project's details. */
export function ProjectsScreen({onCreateProject, onProjectsChanged, projectId, projects, session}: ProjectsScreenProps) {
  const announce = useAnnounce();
  const viewportWidth = useViewportWidth();
  const phone = isPhoneWidth(viewportWidth);
  const preference = usePanelPreference(projectListPanelId);
  const [peeking, setPeeking] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(phone && projectId === null);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const summaries = useProjectSummaries(projects.map((project) => project.id).join(","));
  const rows = projectRows(projects, summaries.items, query);
  const selectedId = initialProjectId(projects, projectId);
  const selectedRow = rows.find((row) => row.id === selectedId) ?? null;
  const selectedKnown = projects.some((project) => project.id === selectedId);
  // A search that hides the selection closes its detail; focus stays in the search field.
  const filteredOut = selectedKnown && selectedRow === null;
  const access = settingsAccess(session.principal);

  useEffect(() => {
    if (projectId === null && selectedId !== null) {
      writeReviewHistory(projectsHref(selectedId), "replace");
    }
  }, [projectId, selectedId]);

  const select = (id: string): void => {
    setSheetOpen(false);
    navigateReview(projectsHref(id), {replace: true});
    const name = projects.find((project) => project.id === id)?.name;
    if (name !== undefined) announce(`${name} opened.`);
  };

  const listButton = phone ? (
    <Button icon="bi-briefcase" onClick={() => setSheetOpen(true)} outline size="sm" variant="secondary">
      Projects
    </Button>
  ) : null;

  const detail = selectedId === null ? (
    <PageScaffold head="scroll" maxWidth="none" title="Projects">
      <SurfaceState
        actionIcon="bi-plus-lg"
        actionLabel="New project"
        count={0}
        emptyBody="Create a project to publish artifacts into it."
        emptyIcon="bi-briefcase"
        emptyTitle="No projects yet"
        noun="projects"
        onAction={() => setCreateOpen(true)}
        phase="ready"
        titleLevel={3}
        variant="dashed"
      />
    </PageScaffold>
  ) : filteredOut ? (
    <PageScaffold actions={listButton} head="scroll" maxWidth="none" title="Projects">
      <SurfaceState
        count={0}
        emptyBody="The selected project is hidden by the search. Choose a project from the list or clear the search."
        emptyIcon="bi-search"
        emptyTitle="No project selected"
        noun="projects"
        phase="ready"
        titleLevel={3}
        variant="dashed"
      />
    </PageScaffold>
  ) : (
    <ProjectSettings
      artifactCount={selectedRow?.artifactCount ?? null}
      canManage={access.canManageProjects}
      gitHistory={session.capabilities.gitHistory}
      headActions={listButton}
      // One project's dialogs, estimate and pages never carry over to another.
      key={selectedId}
      onProjectsChanged={async () => {
        const loaded = await onProjectsChanged();
        summaries.reload();
        return loaded;
      }}
      principalId={session.principal.id}
      projectId={selectedId}
      projects={projects}
    />
  );

  return (
    <div style={screenStyle}>
      {phone && !sheetOpen ? null : (
        <aside aria-label="Project list" style={listLandmarkStyle}>
          <ProjectListPanel
            canPin={viewportWidth >= workspaceBudget.catalogAlone}
            onAdd={() => setCreateOpen(true)}
            onAnnounce={announce}
            onPeekChange={setPeeking}
            onPinChange={(pinned) => {
              preference.setPinned(pinned);
              setPeeking(false);
            }}
            onQueryChange={setQuery}
            onSelect={select}
            onSheetClose={() => setSheetOpen(false)}
            onWidthChange={preference.setWidth}
            peeking={peeking}
            pinned={preference.pinned}
            query={query}
            rows={rows}
            selectedId={selectedId}
            sheet={phone}
            total={projects.length}
            width={preference.width}
          />
        </aside>
      )}
      <div aria-label="Project details" role="region" style={detailStyle}>{detail}</div>
      <CreateProjectModal
        onClose={() => setCreateOpen(false)}
        onCreate={onCreateProject}
        onCreated={(project) => {
          setCreateOpen(false);
          navigateReview(projectsHref(project.id));
        }}
        open={createOpen}
      />
    </div>
  );
}

const screenStyle: CSSProperties = {display: "flex", flex: "1 1 auto", minHeight: 0, minWidth: 0};
const listLandmarkStyle: CSSProperties = {display: "flex", flex: "none", minHeight: 0};
const detailStyle: CSSProperties = {display: "flex", flex: "1 1 auto", flexDirection: "column", minHeight: 0, minWidth: 0};
