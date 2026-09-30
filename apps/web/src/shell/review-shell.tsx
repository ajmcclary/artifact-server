import {type CSSProperties, type ReactNode, useState} from "react";

import type {Project, Session} from "@/api/client";
import {
  AppShell,
  IconButton,
  LeftNav,
  MobileNavDrawer,
  Tooltip,
  useDisplayProfile,
  type NavItem,
} from "@/arkcase";
import {
  projectWorkspaceHref,
  REVIEW_RETURN_URL_KEY,
  reviewReturnHref,
  type ReviewRoute,
} from "@/review/review-routes";
import {readStored} from "@/lib/safe-storage";
import {useAnnounce, useAnnouncements} from "@/ui/announcer";

import {AccountMenu} from "./account-menu.tsx";
import {ReviewPaletteHost} from "./command-palette.tsx";
import {ArtifactServerBrand} from "./brand.tsx";
import {CreateProjectModal} from "./create-project-modal.tsx";
import {
  canManageProjects,
  isInstallationAdministrator,
  NEW_PROJECT_NAV_ID,
  shellActiveLink,
  shellNavItems,
  type ShellNavInput,
} from "./nav-model.ts";
import {NAV_PANEL_ID, REVIEW_DISPLAY_LADDER, reviewPanelStore} from "./shell-layout.ts";
import {ShellLayoutProvider, useShellLayoutState} from "./shell-layout-context.tsx";

/** Room kept clear on phones for the drawer's fixed 40 px launcher. */
const phoneLauncherClearance = 56;

interface ReviewShellProps {
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly mainStyle?: CSSProperties;
  readonly onCreateProject: (name: string) => Promise<Project>;
  readonly onOpenPalette?: () => void;
  readonly projects: readonly Project[];
  readonly route: ReviewRoute;
  readonly session: Session;
}

/** Every signed-in screen's frame: navigation rail or drawer, main landmark, live regions. */
export function ReviewShell(props: ReviewShellProps) {
  return (
    <ShellLayoutProvider>
      <ReviewShellFrame {...props} />
    </ShellLayoutProvider>
  );
}

function ReviewShellFrame({
  aside,
  children,
  mainStyle,
  onCreateProject,
  onOpenPalette,
  projects,
  route,
  session,
}: ReviewShellProps) {
  const announce = useAnnounce();
  const announcements = useAnnouncements();
  const display = useDisplayProfile({ladder: REVIEW_DISPLAY_LADDER});
  const layout = useShellLayoutState();
  const [navPinned, setNavPinned] = useState(() => reviewPanelStore.pinned(NAV_PANEL_ID, false));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const mode = route.kind === "settings" ? "admin" : "review";
  const navInput: ShellNavInput = {
    activeProjectId: route.kind === "workspace" ? route.location.projectId : null,
    activeSettings: route.kind === "settings" ? route.settings.kind : null,
    canCreateProjects: canManageProjects(session.principal),
    isAdministrator: isInstallationAdministrator(session.principal),
    mode,
    projects,
    queueActive: route.kind === "queue",
    returnHref: reviewReturnHref(readStored("session", REVIEW_RETURN_URL_KEY)),
  };
  const items = shellNavItems(navInput);
  const activeLink = shellActiveLink(navInput);
  const focus = route.kind === "workspace" && route.location.view === "focus";
  const phone = display.profile === "mobile";
  const expanded = layout.navExpandable && navPinned && (display.profile === "laptop" || display.profile === "desktop");
  const navTitle = mode === "admin" ? "Administration" : "Review and projects";

  const selectItem = (item: NavItem): void => {
    if (item.id === NEW_PROJECT_NAV_ID) {
      setCreateOpen(true);
      return;
    }
    if (item.link !== undefined) window.location.assign(item.link);
  };
  const changePin = (next: boolean): void => {
    setNavPinned(next);
    reviewPanelStore.setPinned(NAV_PANEL_ID, next);
  };
  const paletteButton = (tone: "ghost" | "navy"): ReactNode => (onOpenPalette === undefined ? null : (
    <Tooltip fixed label="Search everything" placement={tone === "navy" ? "bottom" : "right"}>
      <IconButton
        ariaLabel="Search everything"
        icon="bi-search"
        keyshortcuts="Meta+K Control+K /"
        onClick={onOpenPalette}
        size="sm"
        variant={tone}
      />
    </Tooltip>
  ));

  const nav = focus ? null : (
    <div inert={layout.chromeHidden} style={{display: "contents"}}>
    <LeftNav
      account={<AccountMenu mode={mode} rail={false} session={session} />}
      activeLink={activeLink}
      brand={(
        <>
          <ArtifactServerBrand />
          <span style={{flex: "1 1 auto"}} />
          {paletteButton("navy")}
        </>
      )}
      brandRail={<ArtifactServerBrand compact />}
      currentLabel="Current"
      footerRail={<AccountMenu mode={mode} rail session={session} />}
      items={items}
      mode={expanded ? "expanded" : "rail"}
      onAnnounce={announce}
      onPinChange={changePin}
      onSelect={selectItem}
      pinned={expanded}
      searchRail={paletteButton("ghost")}
      title={navTitle}
    />
    </div>
  );
  const drawer = focus ? null : (
    <MobileNavDrawer
      activeLink={activeLink}
      brand={<ArtifactServerBrand />}
      footer={<AccountMenu mode={mode} rail={false} session={session} />}
      items={items}
      label={navTitle}
      launcher={{label: "Open menu"}}
      onAnnounce={announce}
      onClose={() => setDrawerOpen(false)}
      onOpen={() => setDrawerOpen(true)}
      onSelect={selectItem}
      open={drawerOpen}
      title={mode === "admin" ? "Administration" : "Review"}
    />
  );

  return (
    <>
      <AppShell
        alert={announcements.assertive}
        announce={announcements.polite}
        aside={aside}
        chrome="left"
        drawer={drawer}
        ladder={REVIEW_DISPLAY_LADDER}
        mainStyle={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          paddingTop: phone && !focus ? phoneLauncherClearance : 0,
          ...mainStyle,
        }}
        nav={nav}
      >
        {children}
        <CreateProjectModal
          onClose={() => setCreateOpen(false)}
          onCreate={onCreateProject}
          onCreated={(project) => window.location.assign(projectWorkspaceHref(project.id))}
          open={createOpen}
        />
      </AppShell>
      <ReviewPaletteHost projects={projects} />
    </>
  );
}
