import {describe, expect, it} from "vitest";

import {initialShellLayout, shellLayoutReducer} from "./shell-layout-context.tsx";

describe("shell layout state", () => {
  it("starts with an expandable nav and visible chrome", () => {
    expect(initialShellLayout).toEqual({chromeHidden: false, navExpandable: true});
  });

  it("rails the nav and hides the chrome independently", () => {
    const railed = shellLayoutReducer(initialShellLayout, {kind: "nav", value: false});
    expect(railed).toEqual({chromeHidden: false, navExpandable: false});
    expect(shellLayoutReducer(railed, {kind: "chrome", value: true}))
      .toEqual({chromeHidden: true, navExpandable: false});
  });

  it("returns the same state object when nothing changes", () => {
    expect(shellLayoutReducer(initialShellLayout, {kind: "nav", value: true})).toBe(initialShellLayout);
    expect(shellLayoutReducer(initialShellLayout, {kind: "chrome", value: false})).toBe(initialShellLayout);
  });
});
