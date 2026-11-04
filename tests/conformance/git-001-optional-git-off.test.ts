import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {GitHistoryProviderHealthProbe} from
  "../../src/git-history/git-history-provider-health.js";
import {
  loadNodeGitHistoryConfiguration,
  type NodeGitHistoryConfiguration,
} from "../../src/git-history/node-git-history-configuration.js";
import {RecordingGitHistoryProvider} from "../support/git-history-provider.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const sessionSchema = z.object({
  capabilities: z.object({
    gitHistory: z.object({
      provider: z.string().nullable(),
      providerState: z.string(),
    }).loose(),
  }).loose(),
}).loose();

const settingSchema = z.object({
  gitHistory: z.object({enabled: z.boolean(), state: z.string()}).loose(),
}).loose();

const comparisonSchema = z.object({
  added: z.array(z.object({path: z.string()}).loose()),
  changed: z.array(z.object({after: z.object({path: z.string()}).loose()}).loose()),
  removed: z.array(z.object({path: z.string()}).loose()),
}).loose();

/** A health probe that records whether the server ever asked it anything. */
class CountingHealthProbe implements GitHistoryProviderHealthProbe {
  calls = 0;

  readonly check = () => Effect.sync(() => {
    this.calls += 1;
    return {state: "available" as const};
  });
}

interface WorkflowOutcome {
  readonly capability: {readonly provider: string | null; readonly providerState: string};
  readonly comparison: {readonly added: readonly string[]; readonly changed: readonly string[]; readonly removed: readonly string[]};
  readonly enableStatus: number;
  readonly openedBody: string;
  readonly projectSetting: {readonly enabled: boolean; readonly state: string};
  readonly providerCalls: number;
  readonly probeCalls: number;
  readonly ready: number;
  readonly versionNumbers: readonly number[];
}

describe("optional Git handoff is off by default and never blocks the product", () => {
  let installation: TestInstallation;
  let secrets: string;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
    secrets = await mkdtemp(path.join(tmpdir(), "git-001-secrets-"));
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(secrets, {force: true, recursive: true});
  });

  /** Start a server from one environment and run publish, open, compare. */
  async function runWith(environment: NodeJS.ProcessEnv, label: string): Promise<WorkflowOutcome> {
    const configuration: NodeGitHistoryConfiguration =
      await Effect.runPromise(loadNodeGitHistoryConfiguration(environment));
    const provider = new RecordingGitHistoryProvider();
    const probe = new CountingHealthProbe();
    if (server !== null) await server.stop();
    const running = await startTestServer(installation, {
      gitHistory: configuration,
      gitHistoryHealthProbe: probe,
      gitHistoryProvider: provider,
    });
    server = running;
    const authorized = {Authorization: `Bearer ${installation.apiToken}`};

    const first = await publishNew(running, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Before</title>",
      idempotencyKey: `git-001-${label}-first`,
    });
    const second = await publishVersion(running, installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><title>After</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: `git-001-${label}-second`,
    });
    const opened = await fetchVersion(running, second.body.links.version);
    const comparison = comparisonSchema.parse(await (await fetch(new URL(
      `/api/v1/artifacts/${first.body.artifact.id}/comparisons?${new URLSearchParams({
        fromVersionId: first.body.version.id,
        toVersionId: second.body.version.id,
      })}`,
      running.baseUrl,
    ), {headers: authorized})).json());
    const session = sessionSchema.parse(await (await fetch(
      new URL("/api/v1/session", running.baseUrl),
      {headers: authorized},
    )).json());
    const setting = settingSchema.parse(await (await fetch(
      new URL("/api/v1/projects/prj_default/git-history", running.baseUrl),
      {headers: authorized},
    )).json());
    const enable = await fetch(new URL("/api/v1/projects/prj_default/git-history", running.baseUrl), {
      body: JSON.stringify({enabled: true}),
      headers: {...authorized, "Content-Type": "application/json", "Idempotency-Key": `git-001-${label}-enable`},
      method: "PUT",
    });
    await enable.arrayBuffer();
    const ready = await fetch(new URL("/ready", running.baseUrl));
    await ready.arrayBuffer();

    return {
      capability: {
        provider: session.capabilities.gitHistory.provider,
        providerState: session.capabilities.gitHistory.providerState,
      },
      comparison: {
        added: comparison.added.map((entry) => entry.path),
        changed: comparison.changed.map((entry) => entry.after.path),
        removed: comparison.removed.map((entry) => entry.path),
      },
      enableStatus: enable.status,
      openedBody: await opened.text(),
      probeCalls: probe.calls,
      projectSetting: {enabled: setting.gitHistory.enabled, state: setting.gitHistory.state},
      providerCalls: provider.createCalls + provider.commitCalls + provider.deleteCalls + provider.issueCredentialCalls,
      ready: ready.status,
      versionNumbers: [first.body.version.number, second.body.version.number],
    };
  }

  /** What every run must show for the artifact itself. */
  const artifactBehavior = {
    comparison: {added: [], changed: ["index.html"], removed: []},
    openedBody: "<!doctype html><title>After</title>",
    ready: 200,
    versionNumbers: [1, 2],
  };

  test("GIT-001-B: with the provider variable absent or off, Git is disabled, artifacts behave identically, and no provider is checked or called", async () => {
    const absent = await runWith({}, "absent");
    const off = await runWith({
      // Companions are ignored without being read while the provider is off.
      ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE: path.join(secrets, "never-read"),
      ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "off",
    }, "off");
    const disabled = {
      ...artifactBehavior,
      capability: {provider: null, providerState: "disabled"},
      probeCalls: 0,
      projectSetting: {enabled: false, state: "disabled"},
      providerCalls: 0,
    };
    expect(absent).toMatchObject(disabled);
    expect(off).toMatchObject(disabled);
    // Neither run can turn Git on for a project.
    expect([absent.enableStatus, off.enableStatus].every((status) => status >= 400)).toBe(true);
  });

  test("GIT-001-F: missing, invalid, unsupported, or unreadable Git configuration cannot stop the server, publishing, opening, or comparing, and selects no provider", async () => {
    const unreadableToken = path.join(secrets, "unreadable-token");
    await writeFile(unreadableToken, "x".repeat(5_000), {mode: 0o600});
    const environments: ReadonlyArray<readonly [string, NodeJS.ProcessEnv, string | null]> = [
      ["unsupported", {ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "github"}, null],
      ["missing", {ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts"}, "cloudflare-artifacts"],
      ["direct-secret", {
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: "account-test",
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN: "a-direct-secret-value",
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: "artifact-server-test",
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
      }, "cloudflare-artifacts"],
      ["invalid-limit", {
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: "account-test",
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE: unreadableToken,
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: "artifact-server-test",
        ARTIFACT_SERVER_GIT_HISTORY_COPY_LIMIT_BYTES: "-1",
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
      }, "cloudflare-artifacts"],
      ["inaccessible-secret", {
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: "account-test",
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE: path.join(secrets, "absent-token"),
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: "artifact-server-test",
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
      }, "cloudflare-artifacts"],
    ];
    const outcomes: Array<readonly [string, WorkflowOutcome]> = [];
    for (const [label, environment] of environments) {
      // Each server restarts on the same installation with one configuration.
      // eslint-disable-next-line no-await-in-loop
      outcomes.push([label, await runWith(environment, label)]);
    }
    expect(outcomes.map(([label, outcome]) => [label, {
      ...artifactBehavior,
      capability: outcome.capability,
      probeCalls: outcome.probeCalls,
      providerCalls: outcome.providerCalls,
    }])).toEqual(environments.map(([label, , provider]) => [label, {
      ...artifactBehavior,
      // Only the provider an operator named is reported; nothing is picked
      // automatically, and a misconfigured provider is never checked or used.
      capability: {provider, providerState: "misconfigured"},
      probeCalls: 0,
      providerCalls: 0,
    }]));
    expect(outcomes.map(([, outcome]) => outcome.enableStatus >= 400)).toEqual(environments.map(() => true));
  });
});
