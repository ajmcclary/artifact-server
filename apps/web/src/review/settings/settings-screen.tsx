import {useEffect, type ReactNode} from "react";

import type {Project, Session} from "@/api/client";
import {PageScaffold, SurfaceState} from "@/arkcase";
import {reviewQueueHref, type SettingsRoute} from "../review-routes.ts";
import {ApiKeysScreen} from "../settings-api-keys.tsx";
import {McpScreen} from "../settings-mcp.tsx";
import {MembersScreen} from "../settings-members.tsx";
import {SettingsProject} from "../settings-projects.tsx";
import {PublicLinksScreen} from "../settings-public-links.tsx";
import {WebmcpScreen} from "../settings-webmcp.tsx";
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
        <LegacySettingsFrame>
          <SettingsProject
            canManage
            gitHistory={session.capabilities.gitHistory}
            onProjectsChanged={onProjectsChanged}
            projectId={view.projectId}
            projects={projects}
          />
        </LegacySettingsFrame>
      );
    case "members":
      return <LegacySettingsFrame><MembersScreen /></LegacySettingsFrame>;
    case "apiKeys":
      return <LegacySettingsFrame><ApiKeysScreen /></LegacySettingsFrame>;
    case "publicLinks":
      return <LegacySettingsFrame><PublicLinksScreen /></LegacySettingsFrame>;
    case "mcp":
      break;
  }
  return (
    <LegacySettingsFrame>
      <McpScreen administrator={view.administrator} />
      <WebmcpScreen />
    </LegacySettingsFrame>
  );
}

/**
 * Only reachable if a caller skipped `canonicalReviewRoute`: leave the retired
 * projects list for the queue without adding a history entry.
 */
function SettingsRedirect({href}: {readonly href: string}) {
  useEffect(() => {
    window.location.replace(href);
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
        onAction={() => window.location.assign(reviewQueueHref())}
        phase="ready"
        titleLevel={3}
        variant="dashed"
      />
    </PageScaffold>
  );
}

/** Holds a settings screen that has not moved to the DS yet; removed in Task 23. */
function LegacySettingsFrame({children}: {readonly children: ReactNode}) {
  return (
    // The old screens keep their own wrapper class (compact buttons) until each one moves.
    <div className="as-settings" style={{flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 24}}>
      {children}
    </div>
  );
}
