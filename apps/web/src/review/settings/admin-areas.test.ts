import {
  adminAreaById,
  admittedLabel,
  dateOrDash,
  dateTimeOrDash,
  keyStatusLabel,
  keyStatusTone,
  readSelectedRecord,
  selectedRecordHref,
  visibleAdminAreas,
} from "@/review/settings/admin-areas";
import {describe, expect, it} from "vitest";

describe("administration areas", () => {
  it("groups the four areas for administrators and leaves only MCP for everyone else", () => {
    expect(visibleAdminAreas(true).map((area) => [area.group, area.label])).toEqual([
      ["People and access", "Members"],
      ["People and access", "Invites"],
      ["People and access", "API keys"],
      ["Sharing", "Public links"],
      ["Integrations", "MCP & WebMCP"],
    ]);
    expect(visibleAdminAreas(false).map((area) => area.id)).toEqual(["mcp"]);
    expect(adminAreaById("apiKeys").href).toBe("/review/settings/api-keys");
    expect(adminAreaById("invites").href).toBe("/review/settings/invites");
  });

  it("reads and writes the selected record without disturbing other query values", () => {
    expect(readSelectedRecord("?selected=mbr_1")).toBe("mbr_1");
    expect(readSelectedRecord("?selected=")).toBeNull();
    expect(readSelectedRecord("")).toBeNull();
    const location = {pathname: "/review/settings/members", search: "?theme=dark"};
    expect(selectedRecordHref(location, "mbr 1")).toBe("/review/settings/members?theme=dark&selected=mbr+1");
    expect(selectedRecordHref({...location, search: "?theme=dark&selected=mbr_1"}, null))
      .toBe("/review/settings/members?theme=dark");
    expect(selectedRecordHref({pathname: "/review/settings/members", search: "?selected=a"}, null))
      .toBe("/review/settings/members");
  });

  it("labels a member admitted by invite with the inviter's name", () => {
    expect(admittedLabel({admittedBy: {name: "Jordan Lee"}, admittedHow: "invite"})).toBe("Jordan Lee · Invite");
    expect(admittedLabel({admittedBy: null, admittedHow: "invite"})).toBe("— · Invite");
  });

  it("names how a member was admitted without inventing an admitter", () => {
    expect(admittedLabel({admittedBy: null, admittedHow: "automatic"})).toBe("Automatic");
    expect(admittedLabel({admittedBy: null, admittedHow: "owner"})).toBe("Installation owner");
    expect(admittedLabel({admittedBy: {name: "Dana Okonkwo"}, admittedHow: "manual"})).toBe("Dana Okonkwo");
    expect(admittedLabel({admittedBy: null, admittedHow: "manual"})).toBe("—");
    expect(admittedLabel({admittedBy: null, admittedHow: null})).toBe("—");
  });

  it("prints US dates and a 12-hour clock, and a dash for absent or unparsable values", () => {
    expect(dateOrDash("2026-09-30T16:05:00")).toBe("09/30/2026");
    expect(dateTimeOrDash("2026-09-30T16:05:00")).toMatch(/^09\/30\/2026.*4:05 PM$/u);
    expect(dateOrDash(null)).toBe("—");
    expect(dateTimeOrDash("never")).toBe("—");
  });

  it("labels and tones key status", () => {
    expect([keyStatusLabel("active"), keyStatusTone("active")]).toEqual(["Active", "success"]);
    expect([keyStatusLabel("expired"), keyStatusTone("expired")]).toEqual(["Expired", "warning"]);
    expect([keyStatusLabel("revoked"), keyStatusTone("revoked")]).toEqual(["Revoked", "neutral"]);
  });
});
