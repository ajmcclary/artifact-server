import {type Project, type Session} from "@/api/client";
import {StatePanel} from "@/components/product";
import {ButtonLink} from "@/components/ui/button";
import {canManageProjects, isInstallationAdministrator} from "@/shell/nav-model";

import {type SettingsRoute} from "./review-routes.ts";
import {ApiKeysScreen} from "./settings-api-keys.tsx";
import {McpScreen} from "./settings-mcp.tsx";
import {MembersScreen} from "./settings-members.tsx";
import {SettingsProject, SettingsProjects} from "./settings-projects.tsx";
import {PublicLinksScreen} from "./settings-public-links.tsx";
import {WebmcpScreen} from "./settings-webmcp.tsx";

interface ReviewSettingsProps {
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projects: readonly Project[];
  readonly route: SettingsRoute;
  readonly session: Session;
}

/** Render one administration screen's content inside the application shell. */
export function ReviewSettings({
  onProjectsChanged,
  projects,
  route,
  session,
}: ReviewSettingsProps) {
  const canManage = canManageProjects(session.principal);
  const administrator = isInstallationAdministrator(session.principal);

  return (
    <div className="as-settings">
      <div className="as-settings__layout">
        <div className="as-settings__content">
          <SettingsContent
            administrator={administrator}
            canManageProjects={canManage}
            onProjectsChanged={onProjectsChanged}
            projects={projects}
            route={route}
            session={session}
          />
        </div>
      </div>
    </div>
  );
}

function SettingsContent({
  administrator,
  canManageProjects: canManage,
  onProjectsChanged,
  projects,
  route,
  session,
}: {
  readonly administrator: boolean;
  readonly canManageProjects: boolean;
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projects: readonly Project[];
  readonly route: SettingsRoute;
  readonly session: Session;
}) {
  if (route.kind === "notFound") {
    return (
      <StatePanel
        action={(
          <ButtonLink href="/review/settings/projects" variant="outline">
            View settings
          </ButtonLink>
        )}
        description="This Artifact Server settings route does not exist."
        title="Page not found"
      />
    );
  }
  if (route.kind === "projects" || route.kind === "project") {
    if (!canManage) return <ProjectPermissionRequired />;
    if (route.kind === "projects") {
      return (
        <SettingsProjects
          canManage={canManage}
          gitHistory={session.capabilities.gitHistory}
          onProjectsChanged={onProjectsChanged}
          projects={projects}
        />
      );
    }
    return (
      <SettingsProject
        canManage={canManage}
        gitHistory={session.capabilities.gitHistory}
        onProjectsChanged={onProjectsChanged}
        projectId={route.projectId}
        projects={projects}
      />
    );
  }
  if (route.kind === "mcp") return <McpScreen administrator={administrator} />;
  if (route.kind === "webmcp") return <WebmcpScreen />;
  if (!administrator) return <AdministratorPermissionRequired />;
  switch (route.kind) {
    case "members":
      return <MembersScreen />;
    case "apiKeys":
      return <ApiKeysScreen />;
    case "publicLinks":
      return <PublicLinksScreen />;
  }
  return <AdministratorPermissionRequired />;
}

function ProjectPermissionRequired() {
  return (
    <StatePanel
      description="This account cannot manage projects."
      title="Project permission required"
    />
  );
}

function AdministratorPermissionRequired() {
  return (
    <StatePanel
      description="Only an installation administrator can manage members, API keys, and public links."
      title="Administrator permission required"
    />
  );
}
