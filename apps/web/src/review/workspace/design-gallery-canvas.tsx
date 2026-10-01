import {useRef, useState, type ReactNode} from "react";

import {api, type ArtifactVersion} from "@/api/client";
import {SurfaceState} from "@/arkcase";
import {DesignGallery} from "@/ui/review-ui";

import {workspaceHref} from "../review-routes.ts";
import {
  initialGalleryViewState,
  type GalleryViewState,
} from "./design-gallery.ts";
import {usePreviewIndex} from "./use-preview-index.ts";

/** What the canvas draws for a design version: the gallery, a return control or a notice. */
export interface DesignGalleryCanvas {
  readonly gallery: {readonly content: ReactNode; readonly title: string} | null;
  readonly galleryNotice: string | null;
  /** Returns to the gallery while one of this version's exact pages is open. */
  readonly onReturnToGallery: (() => void) | null;
}

const noGallery: DesignGalleryCanvas = {gallery: null, galleryNotice: null, onReturnToGallery: null};
const loadingStyle = {margin: "auto", maxWidth: 560, padding: 24, width: "100%"};

/**
 * Show a version's native gallery when Review opens its generated catalog entry without
 * an explicit path. Opening a tile
 * is ordinary exact-page navigation (`onNavigate(path)`); returning navigates to the
 * entry (`onNavigate(null)`). Query, kind, layout, scroll and the returning tile are
 * kept per exact version, so browser Back and "Back to gallery" land where they left.
 */
export function useDesignGalleryCanvas({
  announce,
  artifactId,
  focusMode,
  onNavigate,
  phone,
  projectId,
  selectedPath,
  version,
}: {
  readonly announce: (message: string) => void;
  readonly artifactId: string | null;
  readonly focusMode: boolean;
  readonly onNavigate: (path: string | null) => void;
  readonly phone: boolean;
  readonly projectId: string;
  readonly selectedPath: string | null;
  readonly version: ArtifactVersion | null;
}): DesignGalleryCanvas {
  const index = usePreviewIndex(projectId, artifactId, version);
  const states = useRef(new Map<string, GalleryViewState>());
  const [, setRevision] = useState(0);
  if (version === null || artifactId === null || index.status === "absent") return noGallery;
  const versionId = version.version.id;
  // The gallery is the version's landing view. An explicit path, including the generated
  // catalog file itself, is an exact page like any other.
  const onEntry = selectedPath === null;
  if (index.status === "loading") {
    return onEntry
      ? {
        ...noGallery,
        gallery: {
          title: "Design gallery",
          content: (
            <div style={loadingStyle}>
              <SurfaceState
                loadingBody="Reading this version's preview index."
                loadingStyle="spinner"
                loadingTitle="Loading gallery"
                noun="previews"
                phase="loading"
              />
            </div>
          ),
        },
      }
      : noGallery;
  }
  if (index.status === "invalid") {
    return onEntry ? {...noGallery, galleryNotice: `${index.reason} Showing the original catalog.`} : noGallery;
  }
  const state = states.current.get(versionId) ?? initialGalleryViewState;
  const update = (patch: Partial<GalleryViewState>, render: boolean): void => {
    states.current.set(versionId, {...(states.current.get(versionId) ?? initialGalleryViewState), ...patch});
    if (render) setRevision((revision) => revision + 1);
  };
  if (!onEntry) return {...noGallery, onReturnToGallery: () => onNavigate(null)};
  const media = (path: string | null): string | null => path === null
    ? null
    : api.versionMediaUrl(projectId, artifactId, versionId, path);
  return {
    ...noGallery,
    gallery: {
      title: index.title,
      content: (
        <DesignGallery
          coverUrl={media(index.coverPath)}
          description={index.description}
          focusPath={state.focusPath}
          hrefFor={(path) => workspaceHref({
            artifactId,
            path,
            projectId,
            threadId: null,
            versionId,
            view: focusMode ? "focus" : null,
          })}
          items={index.items.map((item) => ({
            description: item.description,
            kind: item.kind,
            path: item.path,
            related: item.related.map((link) => ({path: link.path, title: link.title})),
            section: item.section,
            thumbnailUrl: media(item.thumbnailPath),
            title: item.title,
            viewport: item.viewport,
          }))}
          key={versionId}
          kind={state.kind}
          onAnnounce={announce}
          onKindChange={(kind) => update({kind}, true)}
          onOpen={(path) => {
            update({focusPath: path}, false);
            onNavigate(path);
          }}
          onQueryChange={(query) => update({query}, true)}
          onScroll={(scrollTop) => update({scrollTop}, false)}
          onViewChange={(view) => update({view}, true)}
          phone={phone}
          query={state.query}
          scrollTop={state.scrollTop}
          title={index.title}
          view={state.view}
        />
      ),
    },
  };
}
