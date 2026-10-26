import {describe, expect, it} from "vitest";

import {accessChangeWarning} from "@/review/workspace/artifact-access";

describe("artifact access warnings", () => {
  it("tells someone making an artifact private that its share links stop working", () => {
    expect(accessChangeWarning("account_required")).toContain("Share links to this artifact stop working.");
  });
});
