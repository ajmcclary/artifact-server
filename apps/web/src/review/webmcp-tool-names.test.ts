import {webmcpToolNames} from "@/review/webmcp";
import {describe, expect, it} from "vitest";

describe("WebMCP tool names", () => {
  it("lists exactly the review tools the browser registers, in registration order", () => {
    expect(webmcpToolNames()).toEqual([
      "artifact_server_get_view",
      "artifact_server_list_artifacts",
      "artifact_server_comment",
      "artifact_server_reply",
      "artifact_server_resolve",
      "artifact_server_reopen",
      "artifact_server_open",
    ]);
  });
});
