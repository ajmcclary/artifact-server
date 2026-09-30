import {describe, expect, it} from "vitest";

import {
  dockingFor,
  inspectorDefaultWidth,
  isPhoneWidth,
} from "./workspace-layout.ts";

describe("artifact review workspace docking", () => {
  it.each([
    [390, true, {inspectorDocked: false, listDocked: false, navExpandable: false}],
    [834, true, {inspectorDocked: false, listDocked: false, navExpandable: false}],
    [999, true, {inspectorDocked: false, listDocked: false, navExpandable: false}],
    [1000, true, {inspectorDocked: true, listDocked: false, navExpandable: false}],
    [1023, false, {inspectorDocked: false, listDocked: false, navExpandable: false}],
    [1024, false, {inspectorDocked: false, listDocked: true, navExpandable: true}],
    [1280, true, {inspectorDocked: true, listDocked: false, navExpandable: false}],
    [1639, true, {inspectorDocked: true, listDocked: false, navExpandable: false}],
    [1640, true, {inspectorDocked: true, listDocked: true, navExpandable: true}],
    [1680, false, {inspectorDocked: false, listDocked: true, navExpandable: true}],
  ] as const)("docks correctly at %d px when the inspector wants to dock: %s", (width, inspectorOpen, expected) => {
    expect(dockingFor(width, inspectorOpen)).toEqual(expected);
  });

  it("treats widths below 768 px as the phone profile", () => {
    expect(isPhoneWidth(767)).toBe(true);
    expect(isPhoneWidth(768)).toBe(false);
  });

  it("gives each inspector view the width the design draws it at", () => {
    expect(inspectorDefaultWidth("comments")).toBe(344);
    expect(inspectorDefaultWidth("details")).toBe(392);
    expect(inspectorDefaultWidth("files")).toBe(380);
    expect(inspectorDefaultWidth("versions")).toBe(360);
  });
});
