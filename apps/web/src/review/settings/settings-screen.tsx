import {useEffect} from "react";

import type {Project, Session} from "@/api/client";
import {PageScaffold, SurfaceState} from "@/arkcase";
import {navigateReview, reviewQueueHref, type SettingsRoute} from "../review-routes.ts";
import {ApiKeysScreen} from "./api-keys-screen.tsx";
import {McpWebmcpScreen} from "./mcp-webmcp-screen.tsx";
import {MembersScreen} from "./members-screen.tsx";
import {ProjectSettings} from "./project-settings.tsx";
import {PublicLinksScreen} from "./public-links-screen.tsx";
import {resolveSettingsView, settingsAccess} from "./settings-view.ts";

export interface SettingsScreenProps {
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projects: readonly Project[];
  readonly route: SettingsRoute;
  readonly session: Session;
}

/** Route one canonical settings URL to its administration screen or its permission state. */
export function SettingsScreen({onProjectsChanged, projects, route, session}: SettingsScreenProps) {
  const view = resolveSettingsView(route, settingsAccess(session.principal));
  switch (view.kind) {
    case "redirect":
      return <SettingsRedirect href={view.href} />;
    case "notFound":
      return (
        <SettingsState
          body="This Artifact Server settings route does not exist."
          icon="bi-question-circle"
          title="Page not found"
        />
      );
    case "projectPermission":
      return (
        <SettingsState
          body="This account cannot manage projects."
          icon="bi-lock"
          title="Project permission required"
        />
      );
    case "administratorPermission":
      return (
        <SettingsState
          body="Only an installation administrator can manage members, API keys, and public links."
          icon="bi-shield-lock"
          title="Administrator permission required"
        />
      );
    case "project":
      return (
        <ProjectSettings
          canManage
          gitHistory={session.capabilities.gitHistory}
          // One project's estimate, dialogs and pages never carry over to another.
          key={view.projectId}
          onProjectsChanged={onProjectsChanged}
          projectId={view.projectId}
          projects={projects}
        />
      );
    case "members":
      return <MembersScreen />;
    case "apiKeys":
      return <ApiKeysScreen />;
    case "publicLinks":
      return <PublicLinksScreen />;
    case "mcp":
      break;
  }
  return <McpWebmcpScreen administrator={view.administrator} />;
}

/**
 * Only reachable if a caller skipped `canonicalReviewRoute`: leave the retired
 * projects list for the queue without adding a history entry.
 */
function SettingsRedirect({href}: {readonly href: string}) {
  useEffect(() => {
    navigateReview(href, {replace: true});
  }, [href]);
  return (
    <SurfaceState
      loadingStyle="spinner"
      loadingTitle="Opening the review queue"
      noun="artifacts"
      phase="loading"
    />
  );
}

function SettingsState({
  body,
  icon,
  title,
}: {
  readonly body: string;
  readonly icon: string;
  readonly title: string;
}) {
  return (
    <PageScaffold title="Administration">
      <SurfaceState
        actionIcon="bi-arrow-left"
        actionLabel="Open review queue"
        count={0}
        emptyBody={body}
        emptyIcon={icon}
        emptyTitle={title}
        noun="settings"
        onAction={() => navigateReview(reviewQueueHref())}
        phase="ready"
        titleLevel={3}
        variant="dashed"
      />
    </PageScaffold>
  );
}
