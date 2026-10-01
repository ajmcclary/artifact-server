import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {api, ApiError, type Artifact, type Project} from "@/api/client";
import {
  CommandPalette,
  type CommandPaletteResult,
  isTypingTarget,
  matchesHotkey,
} from "@/arkcase";
import {createRequestLimiter} from "@/lib/request-limiter";
import {navigateReview, projectWorkspaceHref, workspaceHref} from "@/review/review-routes";
import {useAnnounce} from "@/ui/announcer";

/** Pause after the last keystroke before every project's catalog is asked. */
const paletteDebounceMilliseconds = 150;
/** The catalog search matches names and exact tags; an exact id is looked up directly. */
const artifactIdentifierPattern =
  /^art_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Layers whose own keys a bare shortcut must not steal. */
const layerSelector = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
const paletteShortcuts = [
  {keys: "⌘K", label: "Command or Control K"},
  {keys: "/", label: "Slash"},
  {keys: "Esc", label: "Escape"},
];

interface PaletteControls {
  readonly open: boolean;
  readonly openPalette: () => void;
  readonly setOpen: (next: boolean) => void;
}

interface ArtifactHit {
  readonly artifact: Artifact;
  readonly project: Project;
  readonly versionCount: number | null;
}

type PaletteSearchPhase = "failed" | "idle" | "partial" | "ready" | "searching";

interface PaletteSearch {
  readonly hits: readonly ArtifactHit[];
  readonly phase: PaletteSearchPhase;
}

const PaletteContext = createContext<PaletteControls | null>(null);

/** Holds whether the palette is open, above every screen. */
export function PaletteProvider({children}: {readonly children: ReactNode}): ReactElement {
  const [open, setOpen] = useState(false);
  const openPalette = useCallback(() => setOpen(true), []);
  const controls = useMemo(() => ({open, openPalette, setOpen}), [open, openPalette]);
  return <PaletteContext.Provider value={controls}>{children}</PaletteContext.Provider>;
}

/** The palette's open state and its opener, for the nav search button. */
export function usePalette(): PaletteControls {
  const controls = useContext(PaletteContext);
  if (controls === null) {
    throw new Error("The command palette was used outside PaletteProvider.");
  }
  return controls;
}

function insideAnotherLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(layerSelector) !== null;
}

/**
 * ⌘/Ctrl-K toggles the palette from anywhere, including a text field; "/"
 * opens it only outside text fields and other layers. The workspace ignores
 * modified keys and keys typed inside a dialog, so neither reaches j/k/[/]/F.
 */
export function usePaletteShortcuts(): void {
  const {open, setOpen} = usePalette();
  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      if (matchesHotkey(event, "mod+k")) {
        if (!open && insideAnotherLayer(event.target)) return;
        event.preventDefault();
        setOpen(!open);
        return;
      }
      if (open || !matchesHotkey(event, "/")) return;
      if (isTypingTarget(event.target) || insideAnotherLayer(event.target)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open, setOpen]);
}

async function artifactInProject(project: Project, artifactId: string): Promise<ArtifactHit | null> {
  try {
    const details = await api.artifact(project.id, artifactId);
    return {artifact: details.artifact, project, versionCount: null};
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 404 || cause.status === 403)) return null;
    throw cause;
  }
}

/**
 * Catalog requests the palette keeps in flight across every search, the same
 * bound the review queue uses. It is shared so a superseded search's
 * unfinished requests count against the next one.
 */
const paletteRequests = createRequestLimiter(4);

class SupersededSearch extends Error {}

async function searchArtifacts(
  projects: readonly Project[],
  text: string,
  isCurrent: () => boolean,
): Promise<PaletteSearch> {
  // A superseded search stops asking; its queued projects never reach the network.
  const ask = <T,>(task: () => Promise<T>): Promise<T> => paletteRequests(async () => {
    if (!isCurrent()) throw new SupersededSearch();
    return task();
  });
  const byName = await Promise.allSettled(projects.map((project) => ask(async () => {
    const page = await api.artifacts(project.id, null, [], text);
    return page.artifacts.map((entry) => ({
      artifact: entry.artifact,
      project,
      versionCount: entry.versionCount,
    }));
  })));
  const hits: ArtifactHit[] = byName.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const nameFailures = byName.filter((result) => result.status === "rejected").length;
  let idFailures = 0;
  if (isCurrent() && artifactIdentifierPattern.test(text) && !hits.some((hit) => hit.artifact.id === text)) {
    const byId = await Promise.allSettled(projects.map((project) => ask(() => artifactInProject(project, text))));
    for (const result of byId) {
      if (result.status === "rejected") idFailures += 1;
      else if (result.value !== null) hits.push(result.value);
    }
  }
  const phase = projects.length > 0 && nameFailures === projects.length
    ? "failed"
    : nameFailures + idFailures > 0
      ? "partial"
      : "ready";
  return {hits, phase};
}

function versionsLabel(count: number): string {
  return count === 1 ? "1 version" : `${count} versions`;
}

/** Global search over artifact names, exact ids and project names in every readable project. */
export function ReviewCommandPalette({
  onClose,
  open,
  projects,
}: {
  readonly onClose: () => void;
  readonly open: boolean;
  readonly projects: readonly Project[];
}): ReactElement | null {
  const announce = useAnnounce();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<PaletteSearch>({hits: [], phase: "idle"});
  const text = query.trim();

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open || text === "") {
      setSearch({hits: [], phase: "idle"});
      return undefined;
    }
    let current = true;
    setSearch({hits: [], phase: "searching"});
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await searchArtifacts(projects, text, () => current);
          if (current) setSearch(next);
        } catch {
          if (current) setSearch({hits: [], phase: "failed"});
        }
      })();
    }, paletteDebounceMilliseconds);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [open, projects, text]);

  const choose = useCallback((href: string, message: string): void => {
    onClose();
    navigateReview(href);
    announce(message);
  }, [announce, onClose]);

  const needle = text.toLowerCase();
  const artifactResults = search.hits.map((hit) => ({
    id: `artifact:${hit.project.id}:${hit.artifact.id}`,
    kind: "Artifact",
    meta: hit.versionCount === null
      ? hit.project.name
      : `${hit.project.name} · ${versionsLabel(hit.versionCount)}`,
    note: hit.artifact.id,
    onSelect: () => choose(workspaceHref({
      artifactId: hit.artifact.id,
      path: null,
      projectId: hit.project.id,
      threadId: null,
      versionId: null,
      view: null,
    }), `${hit.artifact.name} opened.`),
    title: hit.artifact.name,
  }));
  const projectResults = needle === ""
    ? []
    : projects
      .filter((project) => project.name.toLowerCase().includes(needle))
      .map((project) => ({
        id: `project:${project.id}`,
        kind: "Project",
        meta: project.archivedAt === null ? "Opens the project's artifacts" : "Archived project",
        note: project.id,
        onSelect: () => choose(projectWorkspaceHref(project.id), `${project.name} opened.`),
        title: project.name,
      }));
  const results: CommandPaletteResult[] = [...artifactResults, ...projectResults];
  const resultsLabel = results.length === 1 ? "1 result" : `${results.length} results`;
  const countLabel = text === ""
    ? "Search artifact names, identifiers and projects"
    : search.phase === "searching"
      ? `Searching for "${text}"`
      : search.phase === "failed"
        ? "Artifact Server could not search the catalogs. Edit the search to try again."
        : search.phase === "partial"
          ? `${resultsLabel} for "${text}"; some projects could not be searched`
          : `${resultsLabel} for "${text}"`;

  return (
    <CommandPalette
      countLabel={countLabel}
      emptyBody="The search covers artifact names, exact tags and exact identifiers, and project names, in every project you can read."
      emptyTitle={search.phase === "searching" ? "Searching" : "No artifact or project matches"}
      idle="Type to search artifact names, tags and identifiers, and project names, across every project you can read."
      label="Search"
      onAnnounce={announce}
      onClear={() => setQuery("")}
      onClose={onClose}
      onQueryChange={setQuery}
      open={open}
      placeholder="Search artifacts and projects"
      query={query}
      results={results}
      shortcuts={paletteShortcuts}
    />
  );
}

/** The palette and its shortcuts, mounted once per signed-in screen. */
export function ReviewPaletteHost({projects}: {readonly projects: readonly Project[]}): ReactElement | null {
  const {open, setOpen} = usePalette();
  usePaletteShortcuts();
  const close = useCallback(() => setOpen(false), [setOpen]);
  return <ReviewCommandPalette onClose={close} open={open} projects={projects} />;
}
