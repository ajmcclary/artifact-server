import {describe, expect, it} from "vitest";

import type {AccessPolicy} from "@/api/client";
import {policyChangeWarning} from "@/review/settings/access-policy-screen";

const policy: AccessPolicy = {
  members: {memberCeiling: null},
  projects: {defaultMode: "open"},
  shareLinks: {enabled: true, guestPermissionsMax: ["artifact.view"], linkCreators: "sharers", maxExpiryDays: null},
};

describe("access policy warnings", () => {
  it("warns before saving that turning share links off also stops every public link", () => {
    expect(policyChangeWarning(policy, {...policy, shareLinks: {...policy.shareLinks, enabled: false}}))
      .toBe("Turning this off stops every share link and every public link from opening, including links already posted elsewhere, until you turn it back on.");
    expect(policyChangeWarning(policy, policy)).toBeNull();
  });
});
