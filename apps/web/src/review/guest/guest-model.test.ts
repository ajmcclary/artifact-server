import {describe, expect, it} from "vitest";

import {guestBanner, guestShellControls, sharePathOf} from "@/review/guest/guest-model";

describe("guest model", () => {
  it("shows comments with comment.read and the composer only with comment.write", () => {
    expect(guestShellControls(["artifact.view"])).toEqual({comments: false, composer: false});
    expect(guestShellControls(["artifact.view", "comment.read"])).toEqual({comments: true, composer: false});
    expect(guestShellControls(["artifact.view", "comment.read", "comment.write"])).toEqual({comments: true, composer: true});
  });

  it("names who shared the link and when it expires", () => {
    expect(guestBanner("Jordan Lee", null, "en-US")).toBe("Viewing as a guest via a link shared by Jordan Lee");
    expect(guestBanner("Jordan Lee", "2026-11-01T12:00:00.000Z", "en-US"))
      .toBe("Viewing as a guest via a link shared by Jordan Lee · Expires Nov 1, 2026");
  });

  it("reads a share path as a token to open or a link to resume", () => {
    expect(sharePathOf("/s/shr_abc")).toEqual({kind: "open", token: "shr_abc"});
    expect(sharePathOf("/review/shared/shl_1")).toEqual({kind: "resume", linkId: "shl_1"});
    expect(sharePathOf("/review/shared/")).toBeNull();
    expect(sharePathOf("/review")).toBeNull();
  });
});
