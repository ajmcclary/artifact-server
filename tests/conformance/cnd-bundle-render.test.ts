import {expect, test} from "vitest";

import {renderBundleMessage} from "../../src/mcp/dispatch-bundle-message.js";

test("candidate bundles: an item on a candidate names its state and base so the agent knows the output is unaccepted", () => {
  const message = renderBundleMessage({
    items: [
      {
        artifactName: "Claims Portal",
        body: "The submit button overlaps the footer.",
        candidate: {baseVersionNumber: 6, state: "candidate"},
        path: "index.html",
        quotedSelection: null,
        threadId: "thr_candidate",
        versionNumber: 7,
      },
      {
        artifactName: "Claims Portal",
        body: "Accepted copy reads well.",
        path: null,
        quotedSelection: null,
        threadId: "thr_mainline",
        versionNumber: 6,
      },
    ],
    note: null,
    senderDisplayName: "Robin",
  });
  expect(message).toContain("1. [Claims Portal · version 7 · candidate based on version 6 · index.html]");
  expect(message).toContain("2. [Claims Portal · version 6]");
});
