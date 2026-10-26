import {describe, expect, it} from "vitest";

import {
  overrideRows,
  permissionLabel,
  restrictConfirmation,
  rolePermissions,
} from "@/review/settings/project-access-model";

const manager = new Set(rolePermissions("manager"));

describe("project access model", () => {
  it("marks overrides against the role and keeps every permission in order", () => {
    const rows = overrideRows("editor", [], ["artifact.delete"], manager, null);
    expect(rows.map((row) => row.permission)).toEqual([
      "artifact.view", "artifact.history", "comment.read", "comment.write", "comment.moderate",
      "artifact.publish", "artifact.edit", "artifact.delete", "artifact.share", "agent.dispatch", "project.manage",
    ]);
    expect(rows.find((row) => row.permission === "artifact.delete")?.state).toBe("removed");
    expect(rows.find((row) => row.permission === "artifact.publish")?.state).toBe("from_role");
    expect(rows.find((row) => row.permission === "project.manage")?.state).toBe("off");
  });

  it("marks added permissions and disables what the editor or the policy forbids", () => {
    const actor = new Set(rolePermissions("editor"));
    const rows = overrideRows("viewer", ["comment.write"], [], actor, ["artifact.view", "artifact.history", "comment.read", "comment.write"]);
    expect(rows.find((row) => row.permission === "comment.write")?.state).toBe("added");
    expect(overrideRows("viewer", [], [], actor, null).find((row) => row.permission === "project.manage"))
      .toMatchObject({disabledReason: "You don't have this permission", state: "off"});
    expect(rows.find((row) => row.permission === "artifact.publish")).toMatchObject({
      disabledReason: "Blocked by installation policy",
      state: "blocked_by_policy",
    });
  });

  it("states how many members a restriction affects", () => {
    expect(restrictConfirmation(2)).toBe("2 members will lose access to this project.");
    expect(restrictConfirmation(1)).toBe("1 member will lose access to this project.");
  });

  it("names every permission in plain words", () => {
    expect(permissionLabel("comment.moderate")).toBe("Delete anyone's comments");
    expect(permissionLabel("project.manage")).toBe("Manage the project and its access");
  });
});
