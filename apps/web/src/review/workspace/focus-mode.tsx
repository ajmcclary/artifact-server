import {useEffect, type CSSProperties, type ReactNode, type RefObject} from "react";

import {Button, CountBadge, IconButton, SlideOver, Toolbar} from "@/arkcase";

import type {AnnotateToggle} from "./review-toolbar.tsx";
import type {ReviewDownload} from "./workspace-types.ts";

export interface FocusViewerControlsProps {
  readonly annotate: AnnotateToggle;
  /** Returns to the version's design gallery while one of its pages is open. */
  readonly onReturnToGallery: (() => void) | null;
  readonly collapsed: boolean;
  readonly commentCount: number;
  readonly commentsOpen: boolean;
  /** Wraps the Comments toggle so the review can return focus to it. */
  readonly commentsToggleRef: RefObject<HTMLSpanElement | null>;
  readonly download: ReviewDownload | null;
  readonly onExit: () => void;
  readonly onHide: () => void;
  readonly onShow: () => void;
  readonly onToggleComments: () => void;
  /** Wraps the restore button so hiding can move focus onto it. */
  readonly restoreRef: RefObject<HTMLSpanElement | null>;
  readonly share: ReactNode;
}

export interface FocusCommentsProps {
  readonly children: ReactNode;
  readonly commentCount: number;
  readonly onClose: () => void;
}

const controlsDockStyle = {position: "absolute", right: 12, top: 12, zIndex: 3} satisfies CSSProperties;
const controlsStyle = {
  background: "var(--surface-card)",
  border: "1px solid var(--border-color-strong)",
  borderRadius: "var(--radius-lg, 8px)",
  boxShadow: "var(--shadow-lg)",
  padding: 4,
} satisfies CSSProperties;
const restoreStyle = {display: "inline-flex", position: "absolute", right: 12, top: 12, zIndex: 3} satisfies CSSProperties;
const commentsDockStyle = {bottom: 0, display: "flex", position: "absolute", right: 0, top: 0, zIndex: 2} satisfies CSSProperties;
const inlineStyle = {display: "inline-flex"} satisfies CSSProperties;

/** The floating controls of the expanded workspace; hidden, they leave a single restore button. */
export function FocusViewerControls({
  annotate,
  collapsed,
  commentCount,
  commentsOpen,
  commentsToggleRef,
  download,
  onExit,
  onHide,
  onReturnToGallery,
  onShow,
  onToggleComments,
  restoreRef,
  share,
}: FocusViewerControlsProps) {
  return (
    <>
      <div hidden={collapsed} style={controlsDockStyle}>
        <Toolbar gap={6} label="Artifact viewer controls" style={controlsStyle}>
          {onReturnToGallery === null ? null : (
            <Button icon="bi-grid-3x3-gap" onClick={onReturnToGallery} outline size="sm" title="Back to gallery" variant="secondary">
              Back to gallery
            </Button>
          )}
          {annotate.available ? (
            <Button
              icon="bi-pencil-square"
              onClick={annotate.onToggle}
              outline
              pressed={annotate.active}
              size="sm"
              title={annotate.active
                ? "Annotate mode: click an element or select text to comment. Press Escape to interact."
                : "Interact mode: links and controls work normally. Select text or turn annotation mode back on to comment."}
              variant="secondary"
            >
              {annotate.active ? "Annotate mode" : "Interact mode"}
            </Button>
          ) : null}
          <span ref={commentsToggleRef} style={inlineStyle}>
            <Button
              aria-controls={commentsOpen ? "review-focus-comments" : undefined}
              expanded={commentsOpen}
              icon="bi-chat-square-text"
              keyshortcuts="]"
              onClick={onToggleComments}
              outline
              size="sm"
              title="Toggle comments (])"
              variant="secondary"
            >
              Comments <CountBadge count={commentCount} tone="primary" />
            </Button>
          </span>
          {share}
          {download === null ? (
            <Button aria-label="Download" disabled icon="bi-download" outline size="sm" variant="secondary">Download</Button>
          ) : (
            <Button
              aria-label="Download"
              download
              href={download.href}
              icon="bi-download"
              outline
              size="sm"
              title={download.title}
              variant="secondary"
            >
              Download
            </Button>
          )}
          <Button icon="bi-fullscreen" keyshortcuts="F" onClick={onExit} size="sm" title="Exit full screen (F)">
            Exit full screen
          </Button>
          <IconButton ariaLabel="Hide viewer controls" icon="bi-chevron-bar-right" onClick={onHide} size="sm" />
        </Toolbar>
      </div>
      {collapsed ? (
        <span ref={restoreRef} style={restoreStyle}>
          <IconButton
            ariaLabel="Show viewer controls"
            icon="bi-chevron-bar-left"
            keyshortcuts="Meta+\ Control+\"
            onClick={onShow}
            size="sm"
            title="Show viewer controls (Command/Control + \)"
            variant="light"
          />
        </span>
      ) : null}
    </>
  );
}

/** The comments column of the expanded workspace, beside the canvas at its end edge. */
export function FocusComments({children, commentCount, onClose}: FocusCommentsProps) {
  return (
    <div id="review-focus-comments" style={commentsDockStyle}>
      <SlideOver
        bodyStyle={{gap: 0, padding: 0}}
        closeLabel="Close comments"
        onClose={onClose}
        title="Comments"
        titleMeta={<CountBadge count={commentCount} tone="primary" />}
        width={380}
      >
        {children}
      </SlideOver>
    </div>
  );
}

/**
 * While the expanded workspace covers the shell, keep keyboard focus inside
 * it. Dialogs and toasts render outside the layer (portals), so focus that
 * moves into them is left alone.
 */
export function useFocusContainment(layer: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const onFocusIn = (event: FocusEvent): void => {
      const root = layer.current;
      const target = event.target instanceof Element ? event.target : null;
      if (root === null || target === null || root.contains(target)) return;
      if (target.closest('[role="dialog"], [role="alertdialog"], [data-ak-toast-region]') !== null) return;
      root.querySelector<HTMLElement>("[data-preview-frame]")?.focus({preventScroll: true});
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [active, layer]);
}
