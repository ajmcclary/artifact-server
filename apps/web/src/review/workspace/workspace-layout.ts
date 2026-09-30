import type {InspectorTab} from "./workspace-types.ts";

/**
 * The review workspace's width budget. These are product constants, not
 * design-system values: the inspector docks at 1000 px; the artifact catalog
 * docks at 1024 px, or at 1640 px while the inspector is docked; the expanded
 * navigation needs the same room as the catalog. Below 768 px (the phone
 * profile) nothing docks and both panes become sheets.
 */
export const workspaceBudget = {
  catalogAlone: 1_024,
  catalogBesideInspector: 1_640,
  inspector: 1_000,
  phone: 768,
  rail: 36,
} as const;

export const catalogWidth = {defaultWidth: 302, maximum: 460, minimum: 240} as const;
export const inspectorWidth = {maximum: 560, minimum: 300} as const;

const inspectorDefaultWidths = {
  comments: 344,
  details: 392,
  files: 380,
  versions: 360,
} as const satisfies Record<InspectorTab, number>;

/** Which panes may take width beside the canvas. */
export interface WorkspaceDocking {
  readonly inspectorDocked: boolean;
  readonly listDocked: boolean;
  readonly navExpandable: boolean;
}

/** True on the phone profile, where the catalog and inspector are sheets. */
export function isPhoneWidth(width: number): boolean {
  return width < workspaceBudget.phone;
}

/**
 * The docking budget at `width`. `inspectorOpen` is true when the inspector
 * is open and pinned, which is the only state in which it asks to dock.
 */
export function dockingFor(width: number, inspectorOpen: boolean): WorkspaceDocking {
  const inspectorDocked = inspectorOpen
    && !isPhoneWidth(width)
    && width >= workspaceBudget.inspector;
  const room = width >= (
    inspectorDocked ? workspaceBudget.catalogBesideInspector : workspaceBudget.catalogAlone
  );
  return {inspectorDocked, listDocked: room, navExpandable: room};
}

/** The width an inspector view opens at before the reviewer resizes it. */
export function inspectorDefaultWidth(tab: InspectorTab): number {
  return inspectorDefaultWidths[tab];
}
