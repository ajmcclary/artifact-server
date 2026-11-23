import {spawn} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import {expect, test} from "vitest";
import {z} from "zod";

import {
  artifactCheckoutDirectory,
  gitCloneInvocation,
} from "../../src/cli/git-history-commands.js";
import {publicationReceiptSchema} from "../../src/cli/publication-record.js";
import {publicationCliFixture} from "../support/publication-cli.js";

const manifestSchema = z.object({
  artifacts: z.array(z.object({
    artifactId: z.string(),
    directory: z.string(),
    status: z.enum(["cloned", "history-unavailable"]),
  })),
  projectId: z.string(),
  schemaVersion: z.literal(1),
});

test("history checkout-project lists only the named project's artifacts", async () => {
  const fixture = await publicationCliFixture();
  try {
    const defaultPublish = await fixture.publish();
    expect(defaultPublish.code).toBe(0);
    const inDefault = publicationReceiptSchema.parse(JSON.parse(defaultPublish.stdout));
    const created = await fetch(`${fixture.origin}/api/v1/projects`, {
      body: JSON.stringify({name: "Second"}),
      headers: {
        Authorization: `Bearer ${fixture.installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const second = z.object({project: z.object({id: z.string()})})
      .parse(await created.json()).project;
    const secondPublish = await fixture.publish(["--project", second.id]);
    expect(secondPublish.code).toBe(0);
    const inSecond = publicationReceiptSchema.parse(JSON.parse(secondPublish.stdout));
    expect(inSecond.artifact.id).not.toBe(inDefault.artifact.id);

    const checkout = path.join(fixture.root, "checkout-second");
    const result = await fixture.run(["history", "checkout-project", second.id, checkout]);
    expect({code: result.code, stderr: result.stderr}).toEqual({code: 0, stderr: ""});
    const manifest = manifestSchema.parse(JSON.parse(result.stdout));
    expect(manifest.projectId).toBe(second.id);
    expect(manifest.artifacts.map((artifact) => artifact.artifactId))
      .toEqual([inSecond.artifact.id]);
    expect(manifestSchema.parse(JSON.parse(await readFile(
      path.join(checkout, ".artifactserver", "project.json"),
      "utf8",
    )))).toEqual(manifest);

    const defaultCheckout = await fixture.run([
      "history",
      "checkout-project",
      inDefault.artifact.projectId,
      path.join(fixture.root, "checkout-default"),
    ]);
    expect(defaultCheckout.code).toBe(0);
    expect(manifestSchema.parse(JSON.parse(defaultCheckout.stdout)).artifacts
      .map((artifact) => artifact.artifactId)).toEqual([inDefault.artifact.id]);
  } finally {
    await fixture.stop();
  }
}, 60_000);

test("history clone refuses artifact IDs that could leave the destination", () => {
  const destination = path.resolve("checkout");
  expect(artifactCheckoutDirectory(destination, "art_0b9f3c1e-6a43-4d3e-9a5c-1f2e3d4c5b6a"))
    .toBe(path.join(destination, "art_0b9f3c1e-6a43-4d3e-9a5c-1f2e3d4c5b6a"));
  for (const hostile of ["../escape", "art_../../escape", "art_a/b", "/etc", "art_", ""]) {
    expect(() => artifactCheckoutDirectory(destination, hostile)).toThrow(z.ZodError);
  }
});

test("history clone refuses non-HTTPS, option-shaped and credential-bearing remotes", () => {
  const credential = {
    defaultBranch: "main" as const,
    expiresAt: "2026-11-22T00:00:00.000Z",
    token: "clone-token",
  };
  for (const remote of [
    "http://git.example.com/repo.git",
    "file:///tmp/repo.git",
    "ext::sh -c touch% /tmp/pwned",
    "ssh://git.example.com/repo.git",
  ]) {
    expect(() => gitCloneInvocation({...credential, remote}, "/tmp/destination"))
      .toThrow("Git history remote must use HTTPS.");
  }
  expect(() => gitCloneInvocation(
    {...credential, remote: "https://user:secret@git.example.com/repo.git"},
    "/tmp/destination",
  )).toThrow("Git history remote must not embed credentials.");
  const invocation = gitCloneInvocation(
    {...credential, remote: "https://git.example.com/repo.git"},
    "/tmp/destination",
  );
  expect(invocation.args.slice(-3)).toEqual([
    "--",
    "https://git.example.com/repo.git",
    "/tmp/destination",
  ]);
  expect(invocation.env["GIT_ALLOW_PROTOCOL"]).toBe("https");
});

test("history clone scopes its bearer header to the clone remote's origin in real Git", async () => {
  const seen: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = z.object({port: z.number()}).parse(server.address()).port;
  const root = await mkdtemp(path.join(tmpdir(), "artifact-history-clone-"));
  try {
    const remote = `http://127.0.0.1:${port}/repo.git`;
    const invocation = gitCloneInvocation({
      defaultBranch: "main",
      expiresAt: "2026-11-22T00:00:00.000Z",
      remote,
      token: "scoped-clone-token",
    }, path.join(root, "clone"));
    const environment = {...process.env, ...invocation.env};
    const matched = await runGit(
      ["config", "--get-urlmatch", "http.extraHeader", `${remote}/info/refs`],
      environment,
    );
    expect(matched.stdout.trim()).toBe("Authorization: Bearer scoped-clone-token");
    const foreign = await runGit(
      ["config", "--get-urlmatch", "http.extraHeader", "https://elsewhere.example/repo.git"],
      environment,
    );
    expect({code: foreign.code, stdout: foreign.stdout}).toEqual({code: 1, stdout: ""});

    const clone = await runGit(invocation.args, environment);
    expect(clone.code).not.toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === "Bearer scoped-clone-token")).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, {force: true, recursive: true});
  }
}, 30_000);

function runGit(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{readonly code: number; readonly stdout: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {env, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "";
    child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => resolve({code: code ?? -1, stdout}));
  });
}
