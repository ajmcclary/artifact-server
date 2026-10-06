import {useEffect} from "react";

import type {Session} from "@/api/client";
import {PageScaffold, SurfaceState} from "@/arkcase";
import {navigateReview, type SettingsRoute} from "../review-routes.ts";
import {ApiKeysScreen} from "./api-keys-screen.tsx";
import {McpWebmcpScreen} from "./mcp-webmcp-screen.tsx";
import {InvitesScreen} from "./invites-screen.tsx";
import {MembersScreen} from "./members-screen.tsx";
import {PublicLinksScreen} from "./public-links-screen.tsx";
import {resolveSettingsView, settingsAccess} from "./settings-view.ts";

export interface SettingsScreenProps {
  readonly route: SettingsRoute;
  readonly session: Session;
}

/** Route one canonical settings URL to its administration area or its permission state. */
export function SettingsScreen({route, session}: SettingsScreenProps) {
  const view = resolveSettingsView(route, settingsAccess(session.principal));
  switch (view.kind) {
    case "redirect":
      return <SettingsRedirect href={view.href} />;
    case "notFound":
      return <SettingsState body="This Artifact Server settings route does not exist." icon="bi-question-circle" title="Page not found" />;
    case "administratorPermission":
      return (
        <SettingsState
          body="Only an installation administrator can manage members, API keys, and public links."
          icon="bi-shield-lock"
          title="Administrator permission required"
        />
      );
    case "members":
      return <MembersScreen />;
    case "invites":
      return <InvitesScreen />;
    case "apiKeys":
      return <ApiKeysScreen />;
    case "publicLinks":
      return <PublicLinksScreen />;
    case "mcp":
      break;
  }
  return <McpWebmcpScreen administrator={view.administrator} />;
}

/** Only reachable if a caller skipped `canonicalReviewRoute`. */
function SettingsRedirect({href}: {readonly href: string}) {
  useEffect(() => {
    navigateReview(href, {replace: true});
  }, [href]);
  return <SurfaceState loadingStyle="spinner" loadingTitle="Opening projects" noun="projects" phase="loading" />;
}

function SettingsState({body, icon, title}: {readonly body: string; readonly icon: string; readonly title: string}) {
  return (
    <PageScaffold title="Administration">
      <SurfaceState
        actionIcon="bi-arrow-left"
        actionLabel="Open activity"
        count={0}
        emptyBody={body}
        emptyIcon={icon}
        emptyTitle={title}
        noun="settings"
        onAction={() => navigateReview("/review")}
        phase="ready"
        titleLevel={3}
        variant="dashed"
      />
    </PageScaffold>
  );
}
