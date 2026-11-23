import {chmod, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {expect, test} from "vitest";

import {openSystemBrowser} from "../../src/cli/cli-oauth-client.js";

test("system browser opens only HTTPS or loopback HTTP addresses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-browser-"));
  try {
    const capture = path.join(root, "opened");
    const browser = path.join(root, "browser.sh");
    await writeFile(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${capture}'\n`);
    await chmod(browser, 0o700);
    const environment = {...process.env, ARTIFACT_SERVER_BROWSER_COMMAND: browser};

    await Promise.all([
      "file:///etc/passwd",
      "javascript:alert(1)",
      "smb://attacker.example/share",
      "http://attacker.example/authorize",
      "https://user:secret@attacker.example/authorize",
    ].map((hostile) =>
      expect(openSystemBrowser(new URL(hostile), environment)).rejects.toThrow(
        "not HTTPS or loopback HTTP",
      )
    ));

    await openSystemBrowser(new URL("https://login.example/authorize?state=1"), environment);
    await openSystemBrowser(new URL("http://127.0.0.1:4100/callback"), environment);
    await expect.poll(async () =>
      (await readFile(capture, "utf8").catch(() => "")).trim().split("\n").toSorted()
    ).toEqual(["http://127.0.0.1:4100/callback", "https://login.example/authorize?state=1"]);
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});
