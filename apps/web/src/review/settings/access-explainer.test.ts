import type {AccessSource, EffectiveAccess} from "@/api/client";
import {describe, expect, it} from "vitest";

import {explainSentence} from "@/review/settings/access-explainer-model";

const sentence = (permissions: EffectiveAccess["permissions"], sources: EffectiveAccess["sources"]) =>
  explainSentence({access: {permissions, sources}, permission: "artifact.publish", projectName: "Design", subjectName: "Sam"});

describe("access explanations", () => {
  const commenter: AccessSource = {
    added: [],
    grantId: "grt_1",
    layer: "project_grant",
    removed: [],
    role: "commenter",
  };

  it("names the grant that gives a permission", () => {
    expect(explainSentence({
      access: {permissions: ["artifact.view", "comment.read", "comment.write"], sources: [commenter]},
      permission: "comment.write",
      projectName: "Design",
      subjectName: "Dana",
    })).toBe("Dana can write comments: Commenter on Design.");
  });

  it("names the policy that blocks a permission", () => {
    expect(explainSentence({
      access: {
        permissions: ["artifact.view"],
        sources: [commenter, {layer: "policy", removed: ["artifact.delete", "comment.write"]}],
      },
      permission: "artifact.delete",
      projectName: "Design",
      subjectName: "Dana",
    })).toBe("Dana cannot delete artifacts: blocked by installation policy.");
  });

  it("explains defaults, administrators, archives, removals and missing grants", () => {
    expect(sentence(["artifact.publish"], [{layer: "project_default", role: "editor"}]))
      .toBe("Sam can publish versions: Editor for every member of Design.");
    expect(sentence(["artifact.publish"], [{layer: "administrator"}]))
      .toBe("Sam can publish versions: an administrator manages every project.");
    expect(sentence(["artifact.view"], [
      {layer: "project_default", role: "editor"},
      {layer: "state", reason: "archived", removed: ["artifact.publish"]},
    ])).toBe("Sam cannot publish versions: Design is archived.");
    expect(sentence(["artifact.view"], [{added: [], grantId: "grt_1", layer: "project_grant", removed: ["artifact.publish"], role: "editor"}]))
      .toBe("Sam cannot publish versions: removed from Sam's grant.");
    expect(sentence([], [])).toBe("Sam cannot publish versions: no role or grant gives it.");
  });
});
