import {useEffect, type CSSProperties, type ReactNode, type RefObject} from "react";

import {CountBadge, IconButton, SlideOver, Toolbar} from "@/arkcase";

import type {AnnotateToggle} from "./review-toolbar.tsx";

export interface FocusViewerControlsProps {
  readonly annotate: AnnotateToggle;
  /** Returns to the version's design gallery while one of its pages is open. */
  readonly onReturnToGallery: (() => void) | null;
  readonly collapsed: boolean;
  readonly commentCount: number;
  readonly commentsOpen: boolean;
  /** Wraps the Comments toggle so the review can return focus to it. */
  readonly commentsToggleRef: RefObject<HTMLSpanElement | null>;
  readonly onOpenRawArtifact: () => void;
  readonly opening: boolean;
  readonly rawAvailable: boolean;
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
  /** The docked comment composer. */
  readonly footer?: ReactNode;
  readonly onClose: () => void;
}

export const focusButtonStyle = {background: "transparent", height: 20} satisfies CSSProperties;
const controlsStyle = {background: "transparent", padding: 0} satisfies CSSProperties;
const commentsDockStyle = {bottom: 0, display: "flex", position: "absolute", right: 0, top: 34, zIndex: 2} satisfies CSSProperties;
const inlineStyle = {display: "inline-flex"} satisfies CSSProperties;

/** Compact controls in the expanded preview title bar; hidden, they leave a restore button. */
export function FocusViewerControls({
  annotate,
  collapsed,
  commentCount,
  commentsOpen,
  commentsToggleRef,
  onOpenRawArtifact,
  opening,
  rawAvailable,
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
      <div hidden={collapsed}>
        <Toolbar gap={4} label="Artifact viewer controls" style={controlsStyle} variant="navy">
          {onReturnToGallery === null ? null : (
            <IconButton ariaLabel="Back to gallery" icon="bi-arrow-left" onClick={onReturnToGallery} size="xs" style={focusButtonStyle} variant="navy" />
          )}
          {annotate.available ? (
            <IconButton
              ariaLabel={annotate.active ? "Annotate mode" : "Interact mode"}
              icon="bi-pencil-square"
              onClick={annotate.onToggle}
              pressed={annotate.active}
              size="xs"
              style={focusButtonStyle}
              title={annotate.active
                ? "Annotate mode: click an element or select text to comment. Press Escape to interact."
                : "Interact mode: links and controls work normally. Select text or turn annotation mode back on to comment."}
              variant="navy"
            />
          ) : null}
          <span ref={commentsToggleRef} style={inlineStyle}>
            <IconButton
              aria-controls={commentsOpen ? "review-focus-comments" : undefined}
              ariaLabel="Comments"
              count={commentCount}
              countLabel={`${commentCount} open threads`}
              expanded={commentsOpen}
              icon="bi-chat-square-text"
              keyshortcuts="]"
              onClick={onToggleComments}
              size="xs"
              style={focusButtonStyle}
              title="Toggle comments (])"
              variant="navy"
            />
          </span>
          {share}
          <IconButton
            ariaLabel={opening ? "Opening raw in a new window" : "Open raw in a new window"}
            disabled={!rawAvailable || opening}
            icon="bi-box-arrow-up-right"
            onClick={onOpenRawArtifact}
            size="xs"
            style={focusButtonStyle}
            title="Open raw"
            variant="navy"
          />
          <IconButton ariaLabel="Exit full screen" icon="bi-arrows-angle-contract" keyshortcuts="F" onClick={onExit} size="xs" style={focusButtonStyle} title="Exit full screen (F)" variant="navy" />
          <IconButton ariaLabel="Hide viewer controls" icon="bi-chevron-bar-right" onClick={onHide} size="xs" style={focusButtonStyle} variant="navy" />
        </Toolbar>
      </div>
      {collapsed ? (
        <span ref={restoreRef} style={inlineStyle}>
          <IconButton
            ariaLabel="Show viewer controls"
            icon="bi-chevron-bar-left"
            keyshortcuts="Meta+\ Control+\"
            onClick={onShow}
            size="xs"
            style={focusButtonStyle}
            title="Show viewer controls (Command/Control + \)"
            variant="navy"
          />
        </span>
      ) : null}
    </>
  );
}

/** The comments column of the expanded workspace, beside the canvas at its end edge. */
export function FocusComments({children, commentCount, footer = null, onClose}: FocusCommentsProps) {
  return (
    <div id="review-focus-comments" style={commentsDockStyle}>
      <SlideOver
        bodyStyle={{gap: 0, padding: 0}}
        closeLabel="Close comments"
        footer={footer}
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
