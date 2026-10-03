import {type ReactNode, useState} from "react";

import type {Project, Session} from "@/api/client";
import {
  BrandLock,
  MobileAppBar,
  MobileAppBarAction,
  type MobileAppBarProps,
  type MobileHistoryEntry,
  MobileMoreSheet,
  MobileTabBar,
  type MobileTabItem,
  type NavItem,
} from "@/arkcase";
import {historyOrigin, popHistoryTo} from "@/review/review-history";
import {
  activityHref,
  isPushedScreen,
  libraryHref,
  navigateReview,
  parseReviewRoute,
  projectsHref,
  REVIEW_OPEN_CATALOG_EVENT,
  type ReviewRoute,
} from "@/review/review-routes";

import {PhoneAccountRow} from "./account-menu.tsx";
import {useShellScreenTitle} from "./shell-layout-context.tsx";

type TabId = "activity" | "library" | "more" | "projects";

const tabRoots = {
  activity: {href: activityHref(), kind: "activity"},
  library: {href: libraryHref(), kind: "library"},
  projects: {href: projectsHref(null), kind: "projects"},
} as const;

export interface PhoneChromeInput {
  /** The Needs-you count for the Activity tab; null while unknown. */
  readonly needsYou: number | null;
  /** Every navigation row; the More sheet takes the ones the tab bar has no room for. */
  readonly navItems: readonly NavItem[];
  /** The `link` of the current navigation row. */
  readonly activeLink: string;
  readonly isAdministrator: boolean;
  readonly onAnnounce: (message: string) => void;
  readonly onOpenPalette: (() => void) | undefined;
  readonly projects: readonly Project[];
  readonly route: ReviewRoute;
  readonly session: Session;
}

export interface PhoneChrome {
  readonly appBar: ReactNode;
  readonly moreSheet: ReactNode;
  readonly tabBar: ReactNode;
}

/**
 * A phone's chrome: the bottom tab bar (Activity, Library, Projects and More),
 * the More sheet (the projects, Tools and the account), and the navy app bar —
 * the lock-up and Quick Search at a tab's root, or ‹ Back to the screen a
 * review or a project's settings was opened from.
 */
export function usePhoneChrome(input: PhoneChromeInput): PhoneChrome {
  const {activeLink, isAdministrator, navItems, needsYou, onAnnounce, onOpenPalette, projects, route, session} = input;
  const [moreOpen, setMoreOpen] = useState(false);
  const screenTitle = useShellScreenTitle();
  const label = (target: ReviewRoute): string => screenLabel(target, projects, isAdministrator);
  const pushed = isPushedScreen(route);
  const origin = pushed ? historyOrigin() : null;
  const originRoute = origin === null ? null : parseReviewRoute(new URL(origin.href, window.location.origin));

  // The screen ‹ Back returns to: the entry it was opened from, else its own project or Projects.
  const parent = origin !== null && originRoute !== null ? {
    go: () => {
      if (!popHistoryTo(origin)) navigateReview(origin.href);
    },
    icon: routeIcon(originRoute),
    label: label(originRoute),
    route: originRoute,
  } : route.kind === "workspace" ? {
    go: openCatalog,
    icon: "bi-folder2",
    label: label(route),
    route: null,
  } : {
    go: () => navigateReview(projectsHref(null)),
    icon: "bi-briefcase",
    label: "Projects",
    route: {kind: "projects", projectId: null} satisfies ReviewRoute,
  };

  const activeTab: TabId = moreOpen ? "more"
    : pushed ? (parent.route === null ? "projects" : tabOf(parent.route))
      : tabOf(route);
  const onTab = (item: MobileTabItem): void => {
    if (item.id === "more") {
      setMoreOpen(true);
      return;
    }
    const root = item.id === "activity" || item.id === "library" || item.id === "projects" ? tabRoots[item.id] : null;
    if (root === null) return;
    // The current tab again takes a root back to its top, or returns a pushed screen to the root.
    if (!pushed && route.kind === root.kind) {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({behavior: still ? "auto" : "smooth", top: 0});
      onAnnounce(`${item.label} scrolled to the top.`);
      return;
    }
    if (pushed && parent.route !== null && parent.route.kind === root.kind && !isPushedScreen(parent.route)) {
      parent.go();
      return;
    }
    navigateReview(root.href);
  };

  const tabItems: MobileTabItem[] = [
    needsYou !== null && needsYou > 0
      ? {ariaLabel: `Activity, ${needsYou} need you`, count: needsYou, icon: "bi-inbox", id: "activity", label: "Activity", link: tabRoots.activity.href}
      : {icon: "bi-inbox", id: "activity", label: "Activity", link: tabRoots.activity.href},
    {icon: "bi-collection", id: "library", label: "Library", link: tabRoots.library.href},
    {icon: "bi-briefcase", id: "projects", label: "Projects", link: tabRoots.projects.href},
    {icon: "bi-grid", id: "more", label: "More", opensSheet: true},
  ];
  const tabBar = (
    <MobileTabBar
      items={tabItems}
      label="Primary"
      activeId={activeTab}
      onSelect={onTab}
    />
  );

  // Everything but the three tab destinations, grouped as the navigation groups them.
  const moreItems = navItems
    .filter((item) => item.id !== "activity" && item.id !== "library" && item.id !== "projects")
    .map(moreItem);
  const moreSheet = (
    <MobileMoreSheet
      account={<PhoneAccountRow session={session} />}
      activeLink={activeLink}
      items={moreItems}
      label="More"
      onClose={() => setMoreOpen(false)}
      onSelect={(item) => {
        if (item.link !== undefined) navigateReview(item.link);
      }}
      open={moreOpen}
      returnFocusSelector='[data-ak-tab="more"]'
    />
  );

  let appBar: ReactNode;
  if (pushed) {
    const here = route.kind === "workspace"
      ? {icon: "bi-file-earmark", label: screenTitle?.title ?? label(route), sub: screenTitle?.subtitle ?? null}
      : {icon: "bi-sliders", label: label(route), sub: "Project settings"};
    const history: MobileHistoryEntry[] = [
      {icon: parent.icon, id: "parent", label: parent.label},
      {icon: here.icon, id: "here", label: here.label, sub: here.sub},
    ];
    const pushedBar = {
      actions: route.kind === "workspace" && origin !== null ? (
        <MobileAppBarAction icon="bi-collection" label={`Artifacts in ${label(route)}`} onClick={openCatalog} />
      ) : null,
      backLabel: parent.label,
      history,
      onBack: parent.go,
      onHistorySelect: (_entry: MobileHistoryEntry, index: number) => {
        if (index === 0) parent.go();
      },
      title: here.label,
    } satisfies MobileAppBarProps;
    // A review's preview scrolls inside its own frame, so its name and version show from the start.
    appBar = route.kind === "workspace"
      ? <MobileAppBar {...pushedBar} subtitle={here.sub} titleVisible />
      : <MobileAppBar {...pushedBar} />;
  } else {
    appBar = (
      <MobileAppBar
        actions={onOpenPalette === undefined ? null : (
          <MobileAppBarAction aria-keyshortcuts="Meta+K Control+K /" icon="bi-search" label="Quick Search" onClick={onOpenPalette} />
        )}
        brand={(
          <BrandLock
            homeLabel="Artifact Server home"
            href={activityHref()}
            label="ArkCase"
            product="Artifacts"
            size={16}
            tone="reversed"
          />
        )}
        title={label(route)}
      />
    );
  }
  return {appBar, moreSheet, tabBar};
}

function openCatalog(): void {
  window.dispatchEvent(new Event(REVIEW_OPEN_CATALOG_EVENT));
}

/** A navigation row as a More tile: every project under Projects, everything else under Tools. */
function moreItem(item: NavItem): NavItem {
  return Object.assign({}, item, {group: String(item.id).startsWith("project:") ? "Projects" : "Tools"});
}

const tabByKind = {
  activity: "activity",
  library: "library",
  projects: "projects",
  settings: "more",
  workspace: "projects",
} as const satisfies Record<ReviewRoute["kind"], TabId>;

function tabOf(route: ReviewRoute): TabId {
  return tabByKind[route.kind];
}

const iconByKind = {
  activity: "bi-inbox",
  library: "bi-collection",
  projects: "bi-briefcase",
  settings: "bi-gear",
  workspace: "bi-folder2",
} as const satisfies Record<ReviewRoute["kind"], string>;

function routeIcon(route: ReviewRoute): string {
  return route.kind === "projects" && route.projectId !== null ? "bi-sliders" : iconByKind[route.kind];
}

/** The name a screen carries in the app bar and on ‹ Back. */
export function screenLabel(route: ReviewRoute, projects: readonly Project[], isAdministrator: boolean): string {
  const projectName = (projectId: string | null): string =>
    projects.find((project) => project.id === projectId)?.name ?? "Project";
  if (route.kind === "settings") return isAdministrator ? "Administration" : "MCP & WebMCP";
  if (route.kind === "projects") return route.projectId === null ? "Projects" : projectName(route.projectId);
  if (route.kind === "workspace") return projectName(route.location.projectId);
  return route.kind === "activity" ? "Activity" : "Library";
}
