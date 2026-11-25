import {describe, expect, it} from "vitest";

import {
  candidateBannerCopy,
  makeCurrentMessage,
  rejectedAnnouncement,
  showsCandidateBanner,
} from "@/review/workspace/candidate-model";

describe("candidate banner copy", () => {
  it("names both versions when current is no longer the base", () => {
    const copy = candidateBannerCopy({baseVersionNumber: 9, currentVersionNumber: 8, stale: true, state: "candidate", versionNumber: 10});
    expect(copy.title).toBe("Candidate · based on version 9");
    expect(copy.body).toBe("Based on v9. Current is v8, so this candidate can no longer be promoted. Stage a new candidate on v8.");
  });

  it("asks before rejecting, because a rejected candidate cannot be reopened", () => {
    const copy = candidateBannerCopy({baseVersionNumber: 9, currentVersionNumber: 9, stale: false, state: "candidate", versionNumber: 10});
    expect(copy.rejectQuestion).toBe("Reject candidate v10? It will never become current, and this cannot be undone. Its bytes and comments are kept.");
    expect(copy.body).toContain("waiting for review");
  });

  it("titles a closed candidate by how it closed and offers nothing to do", () => {
    expect(candidateBannerCopy({baseVersionNumber: 9, currentVersionNumber: 9, stale: false, state: "rejected", versionNumber: 10}).title)
      .toBe("Rejected candidate · based on version 9");
    expect(candidateBannerCopy({baseVersionNumber: null, currentVersionNumber: 11, stale: true, state: "superseded", versionNumber: 10}))
      .toEqual(expect.objectContaining({
        body: "It never became current; its bytes and comments are kept. Version 11 is current.",
        title: "Superseded candidate · based on an earlier version",
      }));
  });

  it("shows the banner for open and closed candidates, never for accepted history", () => {
    expect(["mainline", "candidate", "promoted", "rejected", "superseded"].filter(showsCandidateBanner))
      .toEqual(["candidate", "rejected", "superseded"]);
  });

  it("announces a rejection with the version that is still current", () => {
    expect(rejectedAnnouncement(10, 9))
      .toBe("Candidate v10 rejected. It never became current; its bytes and comments are kept. Version 9 is still current.");
  });

  it("states what Make Current moves and what stays", () => {
    expect(makeCurrentMessage(3)).toBe(
      "Latest links and the public link will open version 3. Links pinned to a version and every conversation stay where they are. No saved version is changed or duplicated.",
    );
  });
});
