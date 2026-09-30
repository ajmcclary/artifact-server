import type {ComponentProps, CSSProperties, ReactNode} from "react";

import {CountBadge, Panel, RailTabs, Select, SlideOver} from "@/arkcase";

import {inspectorWidth, workspaceBudget} from "./workspace-layout.ts";

/** One inspector view on the tab rail. */
export interface InspectorRailItem {
  /** Shown as the rail pill; null or 0 draws none. */
  readonly count: number | null;
  readonly countTone: "neutral" | "primary";
  readonly icon: string;
  readonly id: string;
  readonly label: string;
}

export interface InspectorPanelProps {
  readonly active: string;
  /** Whether the width budget lets the inspector dock (DS `canPin`). */
  readonly canPin: boolean;
  readonly children: ReactNode;
  readonly items: readonly InspectorRailItem[];
  readonly onAnnounce: (message: string) => void;
  readonly onClose: () => void;
  readonly onPinChange: (pinned: boolean) => void;
  /** Rail press; selecting the active view means close, which the host decides. */
  readonly onSelect: (id: string) => void;
  readonly onWidthChange: (width: number | null) => void;
  readonly open: boolean;
  readonly pinned: boolean;
  /** Vertical rail labels, shown only where the rail is tall enough. */
  readonly railLabels: boolean;
  /** Phone presentation: the inspector fills the viewport. */
  readonly sheet: boolean;
  readonly subtitle: string | null;
  readonly title: string;
  readonly titleCount: number | null;
  readonly width: number;
}

const landmarkStyle = {display: "flex", flex: "none", minHeight: 0} satisfies CSSProperties;
const sheetViewStyle = {borderBottom: "1px solid var(--border-color)", flex: "none", padding: "8px 12px"} satisfies CSSProperties;

/** The inspector column and its tab rail at the canvas's end edge. */
export function InspectorPanel({
  active,
  canPin,
  children,
  items,
  onAnnounce,
  onClose,
  onPinChange,
  onSelect,
  onWidthChange,
  open,
  pinned,
  railLabels,
  sheet,
  subtitle,
  title,
  titleCount,
  width,
}: InspectorPanelProps) {
  const slideOver: ComponentProps<typeof SlideOver> = {
    bodyStyle: {gap: 0, padding: 0},
    subtitle,
    title,
    titleMeta: titleCount === null ? null : <CountBadge count={titleCount} label={`${titleCount} open`} tone="primary" />,
    width: "100%",
  };
  if (sheet) {
    slideOver.closeLabel = "Close the inspector";
    slideOver.onClose = onClose;
  }
  return (
    <>
      {open ? (
        <aside aria-label="Artifact inspector" style={landmarkStyle}>
          <Panel
            bodyStyle={{display: "flex", flexDirection: "column", overflow: "hidden"}}
            canPin={canPin}
            floatOffset={workspaceBudget.rail}
            id="artifact-inspector"
            maxWidth={inspectorWidth.maximum}
            minWidth={inspectorWidth.minimum}
            name="artifact inspector"
            onAnnounce={onAnnounce}
            onPinChange={onPinChange}
            onWidthChange={onWidthChange}
            pinName="the inspector"
            pinned={pinned}
            resizable
            sheet={sheet}
            side="end"
            unpinned="float"
            width={width}
          >
            <SlideOver {...slideOver}>
              {sheet ? (
                <div style={sheetViewStyle}>
                  <Select
                    label="Inspector view"
                    onChange={(event) => onSelect(event.currentTarget.value)}
                    options={items.map((item) => ({label: item.label, value: item.id}))}
                    size="sm"
                    value={active}
                  />
                </div>
              ) : null}
              {children}
            </SlideOver>
          </Panel>
        </aside>
      ) : null}
      {sheet ? null : (
        <RailTabs
          active={open ? active : null}
          items={items.map((item) => ({
            count: item.count === null || item.count === 0 ? null : item.count,
            countTone: item.countTone,
            icon: item.icon,
            id: item.id,
            label: item.label,
          }))}
          label="Inspector"
          labels={railLabels}
          onSelect={onSelect}
          side="end"
        />
      )}
    </>
  );
}
