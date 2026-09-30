import {describe, expect, test} from "vitest";

import {cliCallbackPageHtml} from "../../src/cli/cli-oauth-client.js";

describe("CLI OAuth loopback callback page", () => {
  test("keeps its wording and draws the ArkCase palette without loading anything", () => {
    const html = cliCallbackPageHtml();

    expect(html).toContain("<title>Artifact Server connected</title>");
    expect(html).toContain("<h1>Artifact Server is connected.</h1>");
    expect(html).toContain("<p>You can close this tab.</p>");
    expect(html).toContain("#073652");
    expect(html).toContain("\"Public Sans\",system-ui");
    expect(html).not.toMatch(/url\(|@import|<link|<script|\ssrc=/u);
  });
});
