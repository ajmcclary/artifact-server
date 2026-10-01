import {useEffect, useState} from "react";

import {
  api,
  type ArtifactPage,
  type DeploymentCapabilities,
  type Project,
  type ProjectGitHistoryEstimate,
  type ProjectGitHistorySetting,
} from "@/api/client";
import {
  AutoGrid,
  Button,
  FieldGrid,
  Input,
  Modal,
  PageScaffold,
  StatusPill,
  SurfaceState,
} from "@/arkcase";
import {accessSettingLabel, errorMessage, formatBytes, formatTimestamp} from "@/lib/presentation";
import {navigateReview, activityHref} from "../review-routes.ts";
import {
  AdminActions,
  AdminInset,
  AdminNote,
  AdminPanel,
  AdminStack,
  artifactReviewHref,
  Ledger,
  ledgerLinkStyle,
  nativeInputAttributes,
  RequestFailure,
  type LedgerColumn,
} from "./admin-parts.tsx";
import {EmptyProjectState} from "./empty-project.tsx";

type ProjectArtifact = ArtifactPage["artifacts"][number];

export interface ProjectSettingsProps {
  readonly canManage: boolean;
  readonly gitHistory: DeploymentCapabilities["gitHistory"];
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projectId: string;
  readonly projects: readonly Project[];
}

interface ProjectArtifacts {
  readonly error: Error | null;
  readonly items: readonly ProjectArtifact[];
  readonly loadMore: () => void;
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly retry: () => void;
}

const projectArtifactColumns: readonly LedgerColumn<ProjectArtifact>[] = [
  {
    align: "left",
    cell: ({artifact}) => ({
      value: (
        <Button
          flush
          href={artifactReviewHref(artifact.projectId, artifact.id)}
          size="sm"
          style={ledgerLinkStyle}
          variant="link"
        >
          {artifact.name}
        </Button>
      ),
    }),
    key: "artifact",
    kind: "field",
    label: "Artifact",
    width: "minmax(0, 1fr)",
  },
  {
    align: "right",
    cell: ({versionCount}) => ({mono: true, value: String(versionCount)}),
    key: "versions",
    kind: "field",
    label: "Versions",
    width: "96px",
  },
  {
    align: "right",
    cell: ({commentCount}) => ({mono: true, value: String(commentCount)}),
    key: "comments",
    kind: "field",
    label: "Comments",
    width: "104px",
  },
  {
    align: "left",
    cell: ({artifact}) => ({value: accessSettingLabel(artifact.accessSetting)}),
    key: "access",
    kind: "field",
    label: "Access",
    width: "150px",
  },
  {
    align: "left",
    cell: ({artifact}) => ({mono: true, muted: true, value: formatTimestamp(artifact.createdAt)}),
    key: "created",
    kind: "field",
    label: "Created",
    width: "170px",
  },
];

/** Manage one project's identity, lifecycle, optional Git history, and see its artifacts. */
export function ProjectSettings({
  canManage,
  gitHistory,
  onProjectsChanged,
  projectId,
  projects,
}: ProjectSettingsProps) {
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const [name, setName] = useState(project?.name ?? "");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [gitSetting, setGitSetting] = useState<ProjectGitHistorySetting | null>(null);
  const [gitEstimate, setGitEstimate] = useState<ProjectGitHistoryEstimate | null>(null);
  const artifacts = useProjectArtifacts(project?.id ?? null);

  useEffect(() => {
    setName(project?.name ?? "");
  }, [project?.name]);

  useEffect(() => {
    if (project === null || gitHistory.provider === null) {
      setGitSetting(null);
      return undefined;
    }
    let current = true;
    void (async (): Promise<void> => {
      try {
        const setting = await api.projectGitHistory(project.id);
        if (current) setGitSetting(setting);
      } catch (caught) {
        if (current) {
          setError(caught instanceof Error
            ? caught
            : new Error("Git history status could not be loaded."));
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [gitHistory.provider, project]);

  if (project === null) {
    return (
      <PageScaffold title="Project settings">
        <SurfaceState
          actionIcon="bi-arrow-left"
          actionLabel="Open Activity"
          count={0}
          emptyBody="The project named by this settings URL is unavailable."
          emptyIcon="bi-question-circle"
          emptyTitle="Project not found"
          noun="projects"
          onAction={() => navigateReview(activityHref())}
          phase="ready"
          titleLevel={3}
          variant="dashed"
        />
      </PageScaffold>
    );
  }

  const rename = async (): Promise<void> => {
    if (pending || name.trim() === "") return;
    setPending(true);
    setError(null);
    try {
      await api.renameProject(project.id, name.trim());
      await onProjectsChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project rename failed."));
    } finally {
      setPending(false);
    }
  };
  const changeArchiveState = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      if (project.archivedAt === null) {
        await api.archiveProject(project.id);
      } else {
        await api.unarchiveProject(project.id);
      }
      await onProjectsChanged();
      setArchiveOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project update failed."));
    } finally {
      setPending(false);
    }
  };
  const estimateGitHistory = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      setGitEstimate(await api.estimateProjectGitHistory(project.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Git history estimate failed."));
    } finally {
      setPending(false);
    }
  };
  const changeGitHistory = async (enabled: boolean): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      setGitSetting(await api.setProjectGitHistory(project.id, enabled));
      setGitEstimate(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Git history update failed."));
    } finally {
      setPending(false);
    }
  };

  const archived = project.archivedAt !== null;
  return (
    <PageScaffold
      actions={(
        <Button
          href={`/review?project=${encodeURIComponent(project.id)}`}
          icon="bi-box-arrow-up-right"
          outline
          size="sm"
          variant="secondary"
        >
          Open artifacts
        </Button>
      )}
      meta={archived
        ? "This project is archived. Existing artifacts and immutable versions remain readable."
        : "Manage this project's name, lifecycle, and optional history."}
      title={project.name}
    >
      {error === null || archiveOpen || gitEstimate !== null ? null : <RequestFailure error={error} />}
      <AutoGrid align="start" min={320}>
        <AdminPanel label="Project identity" subtitle="Renaming changes the label, not the stable project ID.">
          <AdminStack>
            <Input
              {...nativeInputAttributes({maxLength: 120})}
              disabled={!canManage || pending}
              label="Project name"
              onChange={(event) => setName(event.currentTarget.value)}
              size="sm"
              value={name}
            />
            <AdminActions>
              <Button
                disabled={!canManage || pending || name.trim() === "" || name.trim() === project.name}
                icon="bi-save"
                onClick={() => void rename()}
                size="sm"
              >
                {pending ? "Saving…" : "Save name"}
              </Button>
            </AdminActions>
            <FieldGrid
              columns={2}
              fields={[
                {label: "Project ID", mono: true, value: project.id},
                {label: "Created", mono: true, value: formatTimestamp(project.createdAt)},
              ]}
            />
          </AdminStack>
        </AdminPanel>
        <AdminPanel label="Project lifecycle" subtitle={archived ? "Archived" : "Active"}>
          <AdminStack>
            <AdminNote>
              {archived
                ? "Unarchive this project to accept new artifacts and versions again."
                : "Archiving stops new artifacts and versions. Existing reads, links, and immutable history remain."}
            </AdminNote>
            {canManage ? (
              <AdminActions>
                <Button
                  icon={archived ? "bi-unlock" : "bi-archive"}
                  onClick={() => setArchiveOpen(true)}
                  outline={archived}
                  size="sm"
                  variant={archived ? "secondary" : "danger"}
                >
                  {archived ? "Unarchive project" : "Archive project"}
                </Button>
              </AdminActions>
            ) : null}
          </AdminStack>
        </AdminPanel>
      </AutoGrid>

      {gitHistory.provider === null ? null : (
        <AdminPanel
          actions={(
            <StatusPill
              label={gitSetting === null ? "Loading" : gitSetting.state.replaceAll("-", " ")}
              tone={gitSetting?.enabled === true ? "success" : "neutral"}
            />
          )}
          label="Git history"
          subtitle="derived repositories"
        >
          <AdminStack>
            <AdminNote>
              Cloudflare Artifacts keeps a derived Git repository for each artifact. Artifact Server remains the source of truth.
            </AdminNote>
            <AdminActions>
              <Button
                disabled={!canManage
                  || pending
                  || gitSetting === null
                  || (!gitSetting.enabled && gitHistory.providerState !== "available")}
                icon="bi-git"
                onClick={() => void (gitSetting?.enabled === true
                  ? changeGitHistory(false)
                  : estimateGitHistory())}
                outline
                size="sm"
                variant="secondary"
              >
                {pending
                  ? "Working…"
                  : gitSetting?.enabled === true ? "Disable Git history" : "Enable Git history"}
              </Button>
            </AdminActions>
            {gitHistory.providerState === "available" ? null : (
              <AdminNote>
                Git history is currently {gitHistory.providerState.replaceAll("-", " ")} for this deployment.
              </AdminNote>
            )}
          </AdminStack>
        </AdminPanel>
      )}

      <AdminPanel label="Artifacts in this project" padded={false} subtitle={artifactCountLabel(artifacts)}>
        <ProjectArtifactsBody artifacts={artifacts} project={project} />
      </AdminPanel>

      <Modal
        icon={archived ? "bi-unlock" : "bi-archive"}
        inertSiblings
        onClose={() => setArchiveOpen(false)}
        open={archiveOpen}
        portal
        primaryAction={{
          disabled: pending,
          label: pending ? "Working…" : archived ? "Unarchive project" : "Archive project",
          onClick: () => void changeArchiveState(),
          variant: archived ? "primary" : "danger",
        }}
        size="sm"
        subtitle={archived
          ? "This project will accept new artifacts and versions again."
          : "New publication stops. Saved artifacts, links, and immutable versions remain readable."}
        title={archived ? "Unarchive project?" : "Archive project?"}
      >
        {error === null ? null : <RequestFailure error={error} />}
      </Modal>

      <Modal
        icon="bi-git"
        inertSiblings
        onClose={() => setGitEstimate(null)}
        open={gitEstimate !== null}
        portal
        primaryAction={{
          disabled: pending,
          label: pending ? "Enabling…" : "Enable Git history",
          onClick: () => void changeGitHistory(true),
        }}
        size="sm"
        subtitle="Existing and future versions will be copied to derived Cloudflare Artifacts repositories."
        title="Enable Git history?"
      >
        <AdminStack>
          {error === null ? null : <RequestFailure error={error} />}
          {gitEstimate === null ? null : (
            <FieldGrid
              columns={3}
              fields={[
                {label: "Repositories", mono: true, value: String(gitEstimate.repositories)},
                {label: "Versions", mono: true, value: String(gitEstimate.versions)},
                {label: "Estimated copy", mono: true, value: formatBytes(gitEstimate.estimatedCopiedBytes)},
              ]}
            />
          )}
        </AdminStack>
      </Modal>
    </PageScaffold>
  );
}

function ProjectArtifactsBody({
  artifacts,
  project,
}: {
  readonly artifacts: ProjectArtifacts;
  readonly project: Project;
}) {
  if (artifacts.loading && artifacts.items.length === 0) {
    return <SurfaceState loadingTitle="Loading artifacts" noun="artifacts" phase="loading" skeleton={3} />;
  }
  if (artifacts.error !== null && artifacts.items.length === 0) {
    return (
      <SurfaceState
        failedBody={errorMessage(artifacts.error)}
        failedTitle="Artifacts could not load"
        noun="artifacts"
        onRetry={artifacts.retry}
        phase="failed"
      />
    );
  }
  if (artifacts.items.length === 0) {
    return <AdminInset><EmptyProjectState project={project} /></AdminInset>;
  }
  return (
    <>
      <Ledger
        ariaLabel="Artifacts in this project"
        columns={projectArtifactColumns}
        rowKey={({artifact}) => artifact.id}
        rows={artifacts.items}
      />
      {artifacts.error === null ? null : (
        <AdminInset><RequestFailure error={artifacts.error} onRetry={artifacts.loadMore} /></AdminInset>
      )}
      {artifacts.nextCursor === null ? null : (
        <AdminInset>
          <Button
            disabled={artifacts.loading}
            loading={artifacts.loading}
            onClick={artifacts.loadMore}
            outline
            size="sm"
            variant="secondary"
          >
            Load more
          </Button>
        </AdminInset>
      )}
    </>
  );
}

function artifactCountLabel(artifacts: ProjectArtifacts): string {
  if (artifacts.loading && artifacts.items.length === 0) return "Loading";
  const more = artifacts.nextCursor === null ? "" : "+";
  return `${artifacts.items.length}${more} ${artifacts.items.length === 1 ? "artifact" : "artifacts"}`;
}

/** First page of a project's artifacts, newest first, with cursor paging and retry. */
function useProjectArtifacts(projectId: string | null): ProjectArtifacts {
  const [items, setItems] = useState<readonly ProjectArtifact[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(projectId !== null);
  const [error, setError] = useState<Error | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (projectId === null) return undefined;
    let current = true;
    setLoading(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        const page = await api.artifacts(projectId, null, []);
        if (!current) return;
        setItems(page.artifacts);
        setNextCursor(page.nextCursor);
      } catch (caught) {
        if (current) {
          setError(caught instanceof Error ? caught : new Error("Project artifacts could not be loaded."));
        }
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [generation, projectId]);

  const loadMore = (): void => {
    if (projectId === null || nextCursor === null || loading) return;
    setLoading(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        const page = await api.artifacts(projectId, nextCursor, []);
        setItems((existing) => [...existing, ...page.artifacts]);
        setNextCursor(page.nextCursor);
      } catch (caught) {
        setError(caught instanceof Error ? caught : new Error("More artifacts could not be loaded."));
      } finally {
        setLoading(false);
      }
    })();
  };

  return {
    error,
    items,
    loadMore,
    loading,
    nextCursor,
    retry: () => setGeneration((value) => value + 1),
  };
}
