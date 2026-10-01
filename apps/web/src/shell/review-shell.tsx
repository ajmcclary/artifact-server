import {type CSSProperties, type ReactNode, useEffect, useRef, useState} from "react";

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
  inAppLinkTarget,
  navigateReview,
  projectsHref,
  REVIEW_RETURN_URL_KEY,
  reviewReturnHref,
  type ReviewRoute,
} from "@/review/review-routes";
import {readStored, removeStored, writeStored} from "@/lib/safe-storage";
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
import {NAV_PANEL_ID, REVIEW_DISPLAY_LADDER, navigationWidth, reviewPanelStore} from "./shell-layout.ts";
import {NAV_BOOT_WIDTH_KEY} from "./shell-layout-keys.ts";
import {ShellLayoutProvider, ShellNavigationProvider, useShellLayoutState} from "./shell-layout-context.tsx";

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
  const [navWidth, setNavWidth] = useState<number | null>(() => reviewPanelStore.width(NAV_PANEL_ID) ?? null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const mode = route.kind === "settings" ? "admin" : "review";
  const navInput: ShellNavInput = {
    activityActive: route.kind === "activity",
    activeProjectId: route.kind === "workspace"
      ? route.location.projectId
      : route.kind === "library" || route.kind === "projects" ? route.projectId : null,
    activeSettings: route.kind === "settings" ? route.settings.kind : null,
    canCreateProjects: canManageProjects(session.principal),
    isAdministrator: isInstallationAdministrator(session.principal),
    libraryActive: route.kind === "library",
    mode,
    projects,
    projectsActive: route.kind === "projects",
    returnHref: reviewReturnHref(readStored("session", REVIEW_RETURN_URL_KEY)),
  };
  const items = shellNavItems(navInput);
  const activeLink = shellActiveLink(navInput);
  const focus = route.kind === "workspace" && route.location.view === "focus";
  const phone = display.profile === "mobile";
  const expanded = layout.navExpandable && navPinned && (display.profile === "laptop" || display.profile === "desktop");
  const navTitle = mode === "admin" ? "Administration" : "Review and projects";
  const expandedWidth = Math.min(navigationWidth.maximum, Math.max(navigationWidth.minimum, navWidth ?? navigationWidth.defaultWidth));
  useEffect(() => {
    // The next document's loading skeleton opens its column at this width.
    if (navPinned) writeStored("local", NAV_BOOT_WIDTH_KEY, String(Math.round(expandedWidth)));
    else removeStored("local", NAV_BOOT_WIDTH_KEY);
  }, [expandedWidth, navPinned]);
  const screenTitle = routeTitle(route, projects);
  useInAppLinks();
  useScreenChange(screenTitle, announce);

  const selectItem = (item: NavItem): void => {
    if (item.id === NEW_PROJECT_NAV_ID) {
      setCreateOpen(true);
      return;
    }
    if (item.link !== undefined) navigateReview(item.link);
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
          <ArtifactServerBrand showProduct={false} />
          <span style={{flex: "1 1 auto"}} />
          {paletteButton("navy")}
        </>
      )}
      brandRail={<ArtifactServerBrand compact />}
      currentLabel="Current"
      footerRail={<AccountMenu mode={mode} rail session={session} />}
      items={items}
      mode={expanded ? "expanded" : "rail"}
      maxWidth={navigationWidth.maximum}
      minWidth={navigationWidth.minimum}
      onAnnounce={announce}
      onPinChange={changePin}
      onSelect={selectItem}
      onWidthChange={(width) => {
        setNavWidth(width);
        reviewPanelStore.setWidth(NAV_PANEL_ID, width);
      }}
      pinned={expanded}
      searchRail={paletteButton("ghost")}
      resizable={expanded}
      style={{width: expanded ? expandedWidth : "var(--navigator-rail-width, 52px)"}}
      title={navTitle}
      width={expandedWidth}
    />
    </div>
  );
  const drawer = focus ? null : (
    <MobileNavDrawer
      activeLink={activeLink}
      brand={<ArtifactServerBrand showProduct={false} />}
      footer={<AccountMenu mode={mode} rail={false} session={session} />}
      items={items}
      label={navTitle}
      launcher={phone ? {label: "Open menu"} : false}
      onAnnounce={announce}
      onClose={() => setDrawerOpen(false)}
      onOpen={() => setDrawerOpen(true)}
      onSelect={selectItem}
      open={drawerOpen}
      returnFocusSelector={phone
        ? "[data-ac-mnav-launcher]"
        : '[aria-label="Open navigation menu"], [aria-label="Show the artifact catalog"]'}
      title={mode === "admin" ? "Administration" : "Review"}
    />
  );

  return (
    <ShellNavigationProvider value={{collapsed: !expanded, openMenu: () => setDrawerOpen(true)}}>
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
          onCreated={(project) => {
            setCreateOpen(false);
            navigateReview(projectsHref(project.id));
          }}
          open={createOpen}
        />
      </AppShell>
      {phone ? null : drawer}
      <ReviewPaletteHost projects={projects} />
    </ShellNavigationProvider>
  );
}

/**
 * Open plain clicks on application links in place. Links rendered by the
 * design system and the screens stay real anchors, so a modified click, a new
 * tab, and copying the address all keep working.
 */
function useInAppLinks(): void {
  useEffect(() => {
    const openInPlace = (event: MouseEvent): void => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = inAppLinkTarget(event, anchor);
      if (href === null) return;
      event.preventDefault();
      navigateReview(href);
    };
    document.addEventListener("click", openInPlace);
    return () => document.removeEventListener("click", openInPlace);
  }, []);
}

/**
 * Name the document for history and tabs. After a navigation (a link, the
 * palette, or back and forward) lands on another screen, start that screen at
 * its top and announce it; a URL the current screen rewrites for itself, such
 * as the workspace naming its first artifact, is not a new screen.
 */
function useScreenChange(title: string, announce: (message: string) => void): void {
  const navigated = useRef(false);
  const previousTitle = useRef(title);
  useEffect(() => {
    const noteNavigation = (): void => {
      navigated.current = true;
    };
    window.addEventListener("popstate", noteNavigation);
    return () => window.removeEventListener("popstate", noteNavigation);
  }, []);
  useEffect(() => {
    document.title = `${title} · Artifact Server`;
    if (navigated.current && previousTitle.current !== title) {
      document.querySelector("main")?.scrollTo({top: 0});
      announce(title);
    }
    previousTitle.current = title;
  }, [announce, title]);
  // A navigation that re-renders without changing screens is spent here.
  useEffect(() => {
    navigated.current = false;
  });
}

const settingsTitles = {
  apiKeys: "API keys",
  mcp: "MCP & WebMCP",
  members: "Members",
  notFound: "Page not found",
  project: "Project settings",
  projects: "Projects",
  publicLinks: "Public links",
  webmcp: "MCP & WebMCP",
} as const;

function routeTitle(route: ReviewRoute, projects: readonly Project[]): string {
  const projectName = (projectId: string | null): string | null =>
    projects.find((project) => project.id === projectId)?.name ?? null;
  if (route.kind === "activity") return "Activity";
  if (route.kind === "projects") {
    const name = projectName(route.projectId);
    return name === null ? "Projects" : `Projects · ${name}`;
  }
  if (route.kind === "settings") return settingsTitles[route.settings.kind];
  if (route.kind === "library") {
    const name = projectName(route.projectId);
    return name === null ? "Design library" : `Design library · ${name}`;
  }
  return projectName(route.location.projectId) ?? "Review";
}
