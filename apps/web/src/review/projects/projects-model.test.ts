import type {Project} from "@/api/client";
import {
  initialProjectId,
  projectListFooter,
  projectRowMeta,
  projectRows,
} from "@/review/projects/projects-model";
import {describe, expect, it} from "vitest";

function project(id: string, name: string, archivedAt: string | null = null): Project {
  return {archivedAt, createdAt: "2026-09-01T12:00:00.000Z", id, installationId: "ins_test", name};
}

const projects = [
  project("prj_old", "Records Retention", "2026-09-20T12:00:00.000Z"),
  project("prj_default", "Default"),
  project("prj_claims", "ArkCase Claims Workstation"),
];

describe("project list model", () => {
  it("lists active projects before archived ones, keeping server order inside each group", () => {
    expect(projectRows(projects, null, "").map((row) => row.id))
      .toEqual(["prj_default", "prj_claims", "prj_old"]);
  });

  it("joins summary counts and leaves counts unknown when the summary is missing", () => {
    const rows = projectRows(projects, [
      {artifactCount: 3, id: "prj_claims", lastActivityAt: "2026-09-30T16:05:00.000Z", unresolved: 2},
    ], "");
    expect(rows.find((row) => row.id === "prj_claims")).toMatchObject({artifactCount: 3, unresolved: 2});
    expect(rows.find((row) => row.id === "prj_default")).toMatchObject({artifactCount: null, unresolved: 0});
    expect(projectRows(projects, null, "")[0]).toMatchObject({artifactCount: null, unresolved: 0});
  });

  it("filters by a case-insensitive, trimmed name substring", () => {
    expect(projectRows(projects, null, "  CLAIMS ").map((row) => row.id)).toEqual(["prj_claims"]);
    expect(projectRows(projects, null, "zzz")).toEqual([]);
  });

  it("prints counts and the last activity date in US form, or nothing when counts are unknown", () => {
    const base = {archived: false, id: "prj_a", name: "A", unresolved: 0};
    expect(projectRowMeta({...base, artifactCount: 1, lastActivityAt: "2026-09-30T16:05:00"}))
      .toBe("1 artifact · 09/30/2026");
    expect(projectRowMeta({...base, artifactCount: 4, lastActivityAt: null})).toBe("4 artifacts");
    expect(projectRowMeta({...base, artifactCount: null, lastActivityAt: null})).toBeNull();
    expect(projectRowMeta({...base, artifactCount: 2, lastActivityAt: "not a date"})).toBe("2 artifacts");
  });

  it("states the footer as a filtered fraction or a plain total", () => {
    expect(projectListFooter(1, 3, "claims")).toBe("1 of 3");
    expect(projectListFooter(3, 3, " ")).toBe("3 projects");
    expect(projectListFooter(1, 1, "")).toBe("1 project");
  });

  it("selects the requested project even when unknown, else the first active, else the first", () => {
    expect(initialProjectId(projects, "prj_claims")).toBe("prj_claims");
    expect(initialProjectId(projects, "prj_missing")).toBe("prj_missing");
    expect(initialProjectId(projects, null)).toBe("prj_default");
    expect(initialProjectId([project("prj_old", "Records Retention", "2026-09-20T12:00:00.000Z")], null)).toBe("prj_old");
    expect(initialProjectId([], null)).toBeNull();
  });
});
