import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createHash, randomBytes} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, test} from "vitest";
import {Effect, Redacted} from "effect";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {revokeCliOAuthCredential} from "../../src/cli/cli-oauth-client.js";
import {oauthCredential} from "../../src/cli/cli-profile-credential.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
} from "../support/runtime-harness.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliExecutable = path.join(repositoryRoot, "node_modules/.bin/tsx");
const cliEntrypoint = path.join(repositoryRoot, "src/cli/main.ts");
const runningProcesses = new Set<ChildProcessWithoutNullStreams>();
const assignedAddressSchema = z.object({port: z.number().int().positive()});
const profileOutputSchema = z.object({
  accountId: z.string(),
  authentication: z.enum(["api_key", "oauth"]),
  installationId: z.string(),
  name: z.string(),
  origin: z.url(),
  status: z.enum(["authenticated", "invalid", "logged_out"]),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string(), projectId: z.string()}),
  links: z.object({artifact: z.url(), version: z.url()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
type JsonValue =
  | boolean
  | null
  | number
  | string
  | {readonly [key: string]: JsonValue}
  | readonly JsonValue[];

afterEach(async () => {
  await Promise.all([...runningProcesses].map(stopProcess));
});

describe("authenticated CLI profiles and remote publication", () => {
  test("CLI-003-B CLI-003-F: resumes a lost commit response across CLI process restarts", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-cli-publication-recovery-"),
    );
    const serverData = path.join(temporaryDirectory, "server");
    const profileData = path.join(temporaryDirectory, "profiles");
    const fixture = path.join(temporaryDirectory, "report.html");
    await writeFile(fixture, "<h1>Recover this exact publication</h1>");
    const port = await availablePort();
    const server = startServer(serverData, port);
    let proxy: LostCommitResponseProxy | null = null;
    try {
      await waitForReady(server, port);
      const token = (await readFile(
        path.join(serverData, "local-api-token"),
        "utf8",
      )).trim();
      const serverOrigin = `http://127.0.0.1:${port}`;
      proxy = await startLostCommitResponseProxy(serverOrigin);
      const environment = {
        ...process.env,
        ARTIFACT_SERVER_API_TOKEN: token,
        ARTIFACT_SERVER_URL: proxy.origin,
      };
      const publicationArguments = [
        "publish",
        fixture,
        "--name",
        "Recoverable report",
        "--profile-data",
        profileData,
        "--public",
      ];

      const lost = await runCli(publicationArguments, environment);
      expect(proxy.errors()).toEqual([]);
      expect(lost.exitCode).not.toBe(0);
      // The commit reached the server; only its answer was lost.
      expect(lost.stderr).toMatch(
        /Committing the upload failed after \d+ s: the connection closed unexpectedly \(UND_ERR_SOCKET/u,
      );
      expect(lost.stderr).not.toContain("could not be reached");
      expect(proxy.droppedResponses()).toBe(1);
      const operationDirectory = path.join(profileData, "publications");
      const pendingOperations = await readdir(operationDirectory);
      expect(pendingOperations).toHaveLength(1);
      const pendingOperation = pendingOperations[0];
      expect(pendingOperation).toBeDefined();
      expect((await stat(path.join(
        operationDirectory,
        pendingOperation ?? "missing",
      ))).mode & 0o777).toBe(0o600);
      expect((await stat(operationDirectory)).mode & 0o777).toBe(0o700);

      await writeFile(fixture, "<h1>This is a different publication</h1>");
      const changedInput = await runCli(publicationArguments, environment);
      expect(changedInput.exitCode).not.toBe(0);
      expect(changedInput.stderr).toContain(
        "input changed while an earlier attempt is still pending",
      );
      expect(await readdir(operationDirectory)).toHaveLength(1);
      await writeFile(fixture, "<h1>Recover this exact publication</h1>");

      const recovered = await runCli(publicationArguments, environment);
      expect({exitCode: recovered.exitCode, stderr: recovered.stderr}).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(publicationSchema.extend({replayed: z.literal(true)}).parse(
        JSON.parse(recovered.stdout),
      ).version.number).toBe(1);
      expect(await readdir(operationDirectory)).toHaveLength(1);
      const settledRecord = z.object({pending: z.null(), receipt: z.object({version: z.object({number: z.number()})})})
        .parse(JSON.parse(await readFile(path.join(operationDirectory, pendingOperation ?? "missing"), "utf8")));
      expect(settledRecord.receipt.version.number).toBe(1);

      const listed = await fetch(`${serverOrigin}/api/v1/artifacts?limit=100`, {
        headers: {Authorization: `Bearer ${token}`},
      });
      expect(listed.status).toBe(200);
      expect(z.object({artifacts: z.array(z.unknown())}).parse(
        await listed.json(),
      ).artifacts).toHaveLength(1);
    } finally {
      if (proxy !== null) await proxy.stop();
      await stopProcess(server);
      await rm(temporaryDirectory, {force: true, recursive: true});
    }
  }, 30_000);

  test("CLI-002-B PUB-012-B: stores a verified profile outside the project and publishes through it after restart", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-cli-profile-"),
    );
    const serverData = path.join(temporaryDirectory, "server");
    const profileData = path.join(temporaryDirectory, "profiles");
    const helperState = path.join(temporaryDirectory, "credential-helper.json");
    const helper = path.join(temporaryDirectory, "credential-helper.mjs");
    const fixture = path.join(temporaryDirectory, "report.txt");
    const site = path.join(temporaryDirectory, "site");
    const environment = await credentialHelperEnvironment(helper, helperState);
    await mkdir(site);
    await writeFile(fixture, "remote profile publication\n");
    await writeFile(path.join(site, "index.html"), "<h1>Remote site</h1>");
    await writeFile(path.join(site, "site.css"), "h1 { color: navy; }");

    const firstPort = await availablePort();
    let server = startServer(serverData, firstPort);
    try {
      await waitForReady(server, firstPort);
      const token = (await readFile(
        path.join(serverData, "local-api-token"),
        "utf8",
      )).trim();
      const firstOrigin = `http://127.0.0.1:${firstPort}`;
      const ciPublication = await runCli(
        ["publish", fixture, "--public", "--profile-data", profileData],
        {
          ...environment,
          ARTIFACT_SERVER_API_TOKEN: token,
          ARTIFACT_SERVER_URL: firstOrigin,
        },
      );
      expect(ciPublication.exitCode).toBe(0);
      expect(publicationSchema.parse(JSON.parse(ciPublication.stdout)).artifact.id)
        .toBeTruthy();
      await expect(readFile(path.join(profileData, "cli-profiles.json"), "utf8"))
        .rejects.toMatchObject({code: "ENOENT"});

      const login = await runCli(
        [
          "auth",
          "login",
          firstOrigin,
          "--api-key-stdin",
          "--name",
          "team",
          "--profile-data",
          profileData,
        ],
        environment,
        `${token}\n`,
      );
      expect({exitCode: login.exitCode, stderr: login.stderr}).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(profileOutputSchema.parse(JSON.parse(login.stdout))).toMatchObject({
        authentication: "api_key",
        name: "team",
        origin: firstOrigin,
        status: "authenticated",
      });
      expect(login.stdout).not.toContain(token);
      expect(login.stderr).not.toContain(token);

      const profileIndex = await readFile(
        path.join(profileData, "cli-profiles.json"),
        "utf8",
      );
      expect(profileIndex).not.toContain(token);
      expect((await stat(path.join(profileData, "cli-profiles.json"))).mode & 0o777)
        .toBe(0o600);
      const helperDatabase = await readFile(helperState, "utf8");
      expect(helperDatabase).toContain(token);

      const status = await runCli(
        ["auth", "status", "team", "--profile-data", profileData],
        environment,
      );
      expect(status.exitCode).toBe(0);
      expect(status.stdout).not.toContain(token);
      expect(JSON.parse(status.stdout)).toMatchObject({
        profiles: [{name: "team", status: "authenticated"}],
      });

      const firstPublication = await runCli(
        [
          "publish",
          fixture,
          "--profile",
          "team",
          "--profile-data",
          profileData,
          "--public",
        ],
        environment,
      );
      expect(firstPublication.exitCode).toBe(0);
      const firstResult = publicationSchema.parse(JSON.parse(firstPublication.stdout));
      expect(await fetchLoopbackContent(firstResult.links.version).then((response) =>
        response.text()
      ))
        .toBe("remote profile publication\n");

      const directoryPublication = await runCli(
        [
          "publish",
          site,
          "--profile",
          "team",
          "--profile-data",
          profileData,
          "--public",
        ],
        environment,
      );
      expect(directoryPublication.exitCode).toBe(0);
      const directoryResult = publicationSchema.parse(
        JSON.parse(directoryPublication.stdout),
      );
      expect(await fetchLoopbackContent(directoryResult.links.version).then((response) =>
        response.text()
      )).toBe("<h1>Remote site</h1>");

      await stopProcess(server);
      server = startServer(serverData, firstPort);
      await waitForReady(server, firstPort);
      const afterRestart = await runCli(
        [
          "publish",
          fixture,
          "--profile",
          "team",
          "--profile-data",
          profileData,
          "--public",
        ],
        environment,
      );
      expect(afterRestart.exitCode).toBe(0);
      expect(publicationSchema.parse(JSON.parse(afterRestart.stdout)).artifact.id)
        .toBe(firstResult.artifact.id);
      expect(z.object({unchanged: z.boolean()}).parse(JSON.parse(afterRestart.stdout)).unchanged).toBe(true);

      const mismatchedOrigin = await runCli(
        [
          "publish",
          fixture,
          "--profile",
          "team",
          "--server",
          `http://localhost:${firstPort}`,
          "--profile-data",
          profileData,
        ],
        environment,
      );
      expect(mismatchedOrigin.exitCode).not.toBe(0);
      expect(mismatchedOrigin.stderr).toContain("CliProfileError");
      expect(mismatchedOrigin.stderr).not.toContain(token);

      const logout = await runCli(
        ["auth", "logout", "team", "--profile-data", profileData],
        environment,
      );
      expect(logout.exitCode).toBe(0);
      expect(profileOutputSchema.parse(JSON.parse(logout.stdout))).toMatchObject({
        name: "team",
        status: "logged_out",
      });
      expect(logout.stdout).not.toContain(token);
      const removed = await runCli(
        ["auth", "status", "team", "--profile-data", profileData],
        environment,
      );
      expect(removed.exitCode).not.toBe(0);
      expect(removed.stderr).toContain("CliProfileError");
    } finally {
      await stopProcess(server);
      await rm(temporaryDirectory, {force: true, recursive: true});
    }
  }, 60_000);

  test("CLI-002-F PUB-012-F: rejects an invalid credential without saving it and never sends one profile to another origin", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-cli-profile-failure-"),
    );
    const profileData = path.join(temporaryDirectory, "profiles");
    const helperState = path.join(temporaryDirectory, "credential-helper.json");
    const helper = path.join(temporaryDirectory, "credential-helper.mjs");
    const firstData = path.join(temporaryDirectory, "first-server");
    const secondData = path.join(temporaryDirectory, "second-server");
    const environment = await credentialHelperEnvironment(helper, helperState);
    const firstPort = await availablePort();
    const secondPort = await availablePort();
    const first = startServer(firstData, firstPort);
    const second = startServer(secondData, secondPort);
    try {
      await Promise.all([
        waitForReady(first, firstPort),
        waitForReady(second, secondPort),
      ]);
      const invalidCredential = "invalid-credential-with-sufficient-entropy";
      const rejected = await runCli(
        [
          "auth",
          "login",
          `http://127.0.0.1:${firstPort}`,
          "--api-key-stdin",
          "--profile-data",
          profileData,
        ],
        environment,
        `${invalidCredential}\n`,
      );
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).not.toContain(invalidCredential);
      await expect(readFile(path.join(profileData, "cli-profiles.json"), "utf8"))
        .rejects.toMatchObject({code: "ENOENT"});
      await expect(readFile(helperState, "utf8"))
        .rejects.toMatchObject({code: "ENOENT"});

      const firstToken = (await readFile(
        path.join(firstData, "local-api-token"),
        "utf8",
      )).trim();
      const login = await runCli(
        [
          "auth",
          "login",
          `http://127.0.0.1:${firstPort}`,
          "--api-key-stdin",
          "--name",
          "first",
          "--profile-data",
          profileData,
        ],
        environment,
        `${firstToken}\n`,
      );
      expect(login.exitCode).toBe(0);
      const wrongOrigin = await runCli(
        [
          "auth",
          "status",
          "first",
          "--server",
          `http://127.0.0.1:${secondPort}`,
          "--profile-data",
          profileData,
        ],
        environment,
      );
      expect(wrongOrigin.exitCode).not.toBe(0);
      expect(wrongOrigin.stderr).toContain("CliProfileError");
      expect(wrongOrigin.stderr).not.toContain(firstToken);

      const unavailableLogout = await runCli(
        ["auth", "logout", "first", "--profile-data", profileData],
        {
          ...environment,
          ARTIFACT_SERVER_CREDENTIAL_HELPER: path.join(
            temporaryDirectory,
            "missing-helper",
          ),
        },
      );
      expect(unavailableLogout.exitCode).not.toBe(0);
      expect(unavailableLogout.stderr).toContain("credential store is unavailable");
      const retainedProfile = await runCli(
        ["auth", "status", "first", "--profile-data", profileData],
        environment,
      );
      expect(retainedProfile.exitCode).toBe(0);
    } finally {
      await Promise.all([stopProcess(first), stopProcess(second)]);
      await rm(temporaryDirectory, {force: true, recursive: true});
    }
  }, 30_000);

  test("completes browser PKCE, refresh, status, and revocation against real HTTP boundaries", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-cli-oauth-"),
    );
    const profileData = path.join(temporaryDirectory, "profiles");
    const helperState = path.join(temporaryDirectory, "credential-helper.json");
    const helper = path.join(temporaryDirectory, "credential-helper.mjs");
    const browser = path.join(temporaryDirectory, "browser.mjs");
    const environment = await credentialHelperEnvironment(helper, helperState);
    await writeBrowserHelper(browser);
    environment["ARTIFACT_SERVER_BROWSER_COMMAND"] = browser;
    const oauth = await startOAuthFixture();
    try {
      const login = await runCli([
        "auth",
        "login",
        oauth.origin,
        "--name",
        "browser-team",
        "--profile-data",
        profileData,
      ], environment);
      expect({exitCode: login.exitCode, stderr: login.stderr}).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(profileOutputSchema.parse(JSON.parse(login.stdout))).toMatchObject({
        authentication: "oauth",
        name: "browser-team",
        status: "authenticated",
      });
      expect(oauth.observations).toMatchObject({
        authorizationCount: 1,
        codeExchangeCount: 1,
        registrationCount: 1,
      });
      expect(oauth.observations.pkceVerified).toBe(true);
      expect(login.stdout).not.toContain("oauth-access-one");
      expect(login.stdout).not.toContain("oauth-refresh-one");

      const status = await runCli([
        "auth",
        "status",
        "browser-team",
        "--profile-data",
        profileData,
      ], environment);
      expect(status.exitCode).toBe(0);
      expect(oauth.observations.refreshCount).toBe(1);
      expect(oauth.observations.lastSessionBearer).toBe("oauth-access-two");
      expect(status.stdout).not.toContain("oauth-access-two");
      expect(status.stdout).not.toContain("oauth-refresh-two");

      const logout = await runCli([
        "auth",
        "logout",
        "browser-team",
        "--profile-data",
        profileData,
      ], environment);
      expect(logout.exitCode).toBe(0);
      expect(JSON.parse(logout.stdout)).toMatchObject({
        remoteRevocation: "confirmed",
        status: "logged_out",
      });
      expect(oauth.observations.revocationCount).toBe(1);
      expect(oauth.observations.revokedToken).toBe("oauth-refresh-two");

      oauth.advertiseWrongResource();
      const rejected = await runCli([
        "auth",
        "login",
        oauth.origin,
        "--name",
        "wrong-resource",
        "--profile-data",
        profileData,
      ], environment);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).toContain("authorization metadata is invalid");
      expect(oauth.observations.authorizationCount).toBe(1);
    } finally {
      await oauth.stop();
      await rm(temporaryDirectory, {force: true, recursive: true});
    }
  }, 30_000);

  test("CLI OAuth revocation keeps the issuing server bound and refuses redirects", async () => {
    const issuer = await startOAuthFixture();
    const alternate = await startOAuthFixture();
    const credential = oauthCredential({
      clientInformation: {client_id: "synthetic-client", issuer: issuer.origin},
      redirectUrl: `${issuer.origin}/callback`,
      tokens: {
        access_token: "synthetic-access",
        issuer: issuer.origin,
        refresh_token: "synthetic-refresh",
        token_type: "Bearer",
      },
    });
    try {
      issuer.advertiseAuthorizationServer(alternate.origin);
      expect(await Effect.runPromise(revokeCliOAuthCredential(issuer.origin, credential)))
        .toBe(false);
      expect(alternate.observations.revocationCount).toBe(0);

      issuer.advertiseAuthorizationServer(issuer.origin);
      issuer.redirectRevocationTo(alternate.origin);
      expect(await Effect.runPromise(revokeCliOAuthCredential(issuer.origin, credential)))
        .toBe(false);
      expect(alternate.observations.revocationCount).toBe(0);

      issuer.redirectRevocationTo(null);
      expect(await Effect.runPromise(revokeCliOAuthCredential(issuer.origin, credential)))
        .toBe(true);
      expect(issuer.observations.revokedToken).toBe("synthetic-refresh");

      const legacy = oauthCredential({
        clientInformation: {client_id: "synthetic-client"},
        redirectUrl: `${issuer.origin}/callback`,
        tokens: {access_token: "synthetic-access", token_type: "Bearer"},
      });
      expect(await Effect.runPromise(revokeCliOAuthCredential(issuer.origin, legacy)))
        .toBe(false);
      expect(issuer.observations.revocationCount).toBe(1);
    } finally {
      await Promise.all([issuer.stop(), alternate.stop()]);
    }
  });

  test("CLI-001-B: keeps exact-origin account profiles through browser login, renewal, switching, and logout, and authenticates local and CI use without a profile", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-cli-001-behavior-"),
    );
    const profileData = path.join(temporaryDirectory, "profiles");
    const helperState = path.join(temporaryDirectory, "credential-helper.json");
    const helper = path.join(temporaryDirectory, "credential-helper.mjs");
    const browser = path.join(temporaryDirectory, "browser.mjs");
    const project = path.join(temporaryDirectory, "project");
    const fixture = path.join(project, "report.txt");
    const labData = path.join(temporaryDirectory, "lab-server");
    const localData = path.join(temporaryDirectory, "local-data");
    const installation = await createTestInstallation();
    const environment = await credentialHelperEnvironment(helper, helperState);
    await writeBrowserHelper(browser);
    environment["ARTIFACT_SERVER_BROWSER_COMMAND"] = browser;
    await mkdir(project);
    await writeFile(fixture, "exact-origin profile publication\n");
    // A remembered source stays bound to the principal that first published
    // it, so each account and origin publishes its own source file.
    const bobFixture = path.join(project, "bob.txt");
    const labFixture = path.join(project, "lab.txt");
    await writeFile(bobFixture, "second account publication\n");
    await writeFile(labFixture, "second origin publication\n");
    const authorization = await startArtifactServerAuthorization([
      {displayName: "Alice Example", id: "usr_cli001_alice"},
      {displayName: "Bob Example", id: "usr_cli001_bob"},
    ]);
    const teamPort = await reserveLoopbackPort();
    const teamOrigin = `http://127.0.0.1:${teamPort}`;
    const team = await startTestServer(installation, {
      apiOAuthResource: {
        authorizationServers: [authorization.origin],
        resource: `${teamOrigin}/api`,
      },
      externalApiBearerVerifier: authorization.verifier,
      port: teamPort,
    });
    const labPort = await availablePort();
    const labOrigin = `http://127.0.0.1:${labPort}`;
    const lab = startServer(labData, labPort);
    let managedServicePid: number | undefined;
    try {
      await waitForReady(lab, labPort);
      const labKey = (await readFile(path.join(labData, "local-api-token"), "utf8"))
        .trim();

      authorization.signInAs("usr_cli001_alice");
      const aliceLogin = await runCli([
        "auth", "login", teamOrigin, "--name", "alice-team",
        "--profile-data", profileData,
      ], environment);
      expect({exitCode: aliceLogin.exitCode, stderr: aliceLogin.stderr})
        .toEqual({exitCode: 0, stderr: ""});
      expect(profileOutputSchema.parse(JSON.parse(aliceLogin.stdout))).toEqual({
        accountId: "usr_cli001_alice",
        authentication: "oauth",
        installationId: "local",
        name: "alice-team",
        origin: teamOrigin,
        status: "authenticated",
      });
      expect(authorization.observations.authorizationCount).toBe(1);
      expect(authorization.observations.pkceResults).toEqual([true]);
      expect(authorization.observations.acceptedAccounts.at(-1))
        .toBe("usr_cli001_alice");

      authorization.signInAs("usr_cli001_bob");
      const bobLogin = await runCli([
        "auth", "login", teamOrigin, "--name", "bob-team",
        "--profile-data", profileData,
      ], environment);
      expect(bobLogin.exitCode).toBe(0);
      expect(profileOutputSchema.parse(JSON.parse(bobLogin.stdout))).toMatchObject({
        accountId: "usr_cli001_bob",
        authentication: "oauth",
        origin: teamOrigin,
      });

      const labLogin = await runCli([
        "auth", "login", labOrigin, "--api-key-stdin", "--name", "lab",
        "--profile-data", profileData,
      ], environment, `${labKey}\n`);
      expect(labLogin.exitCode).toBe(0);
      expect(profileOutputSchema.parse(JSON.parse(labLogin.stdout))).toMatchObject({
        authentication: "api_key",
        origin: labOrigin,
      });

      const everyProfile = await runCli(
        ["auth", "status", "--profile-data", profileData],
        environment,
      );
      expect(everyProfile.exitCode).toBe(0);
      expect(z.object({profiles: z.array(profileOutputSchema)})
        .parse(JSON.parse(everyProfile.stdout)).profiles
        .map(({name, origin, status}) => ({name, origin, status})))
        .toEqual([
          {name: "alice-team", origin: teamOrigin, status: "authenticated"},
          {name: "bob-team", origin: teamOrigin, status: "authenticated"},
          {name: "lab", origin: labOrigin, status: "authenticated"},
        ]);

      // One origin with two accounts never guesses which account to use.
      const ambiguousOrigin = await runCli(
        ["auth", "status", "--server", teamOrigin, "--profile-data", profileData],
        environment,
      );
      expect(ambiguousOrigin.exitCode).not.toBe(0);
      expect(ambiguousOrigin.stderr).toContain("More than one account is saved");
      const labByOrigin = await runCli(
        ["auth", "status", "--server", labOrigin, "--profile-data", profileData],
        environment,
      );
      expect(labByOrigin.exitCode).toBe(0);
      expect(JSON.parse(labByOrigin.stdout)).toMatchObject({
        profiles: [{name: "lab", origin: labOrigin, status: "authenticated"}],
      });

      // The real server stops accepting the access token; status renews the
      // grant without a browser and the server accepts the renewed token.
      const aliceRefreshBefore = authorization.currentRefreshToken("usr_cli001_alice");
      authorization.expireAccessTokens();
      const authorizationsBeforeRenewal = authorization.observations.authorizationCount;
      const renewed = await runCli(
        ["auth", "status", "alice-team", "--profile-data", profileData],
        environment,
      );
      expect(renewed.exitCode).toBe(0);
      expect(authorization.observations.refreshCount).toBe(1);
      expect(authorization.observations.authorizationCount)
        .toBe(authorizationsBeforeRenewal);
      expect(authorization.observations.acceptedAccounts.at(-1))
        .toBe("usr_cli001_alice");
      const aliceRefreshAfter = authorization.currentRefreshToken("usr_cli001_alice");
      expect(aliceRefreshAfter).not.toBe(aliceRefreshBefore);
      const helperAfterRenewal = await readFile(helperState, "utf8");
      expect(helperAfterRenewal).toContain(aliceRefreshAfter);
      expect(helperAfterRenewal).not.toContain(aliceRefreshBefore);

      // Switch accounts and origins by profile name and by exact origin.
      const asAlice = await runCli([
        "publish", fixture, "--profile", "alice-team", "--profile-data", profileData,
      ], environment, "", project);
      expect({exitCode: asAlice.exitCode, stderr: asAlice.stderr})
        .toEqual({exitCode: 0, stderr: ""});
      expect(authorization.observations.acceptedAccounts.at(-1))
        .toBe("usr_cli001_alice");
      const aliceArtifact = publicationSchema.parse(JSON.parse(asAlice.stdout));
      expect(new URL(aliceArtifact.links.version).port).toBe(String(teamPort));

      const asBob = await runCli([
        "publish", bobFixture, "--profile", "bob-team", "--profile-data", profileData,
      ], environment, "", project);
      expect({exitCode: asBob.exitCode, stderr: asBob.stderr}).toEqual({exitCode: 0, stderr: ""});
      expect(authorization.observations.acceptedAccounts.at(-1))
        .toBe("usr_cli001_bob");
      expect(publicationSchema.parse(JSON.parse(asBob.stdout)).artifact.id)
        .not.toBe(aliceArtifact.artifact.id);

      const toLab = await runCli([
        "publish", labFixture, "--server", labOrigin, "--profile-data", profileData,
      ], environment, "", project);
      expect(toLab.exitCode).toBe(0);
      expect(new URL(publicationSchema.parse(JSON.parse(toLab.stdout)).links.version).port)
        .toBe(String(labPort));
      expect(await artifactCount(labOrigin, labKey)).toBe(1);
      expect(await artifactCount(teamOrigin, installation.apiToken)).toBe(2);

      const aliceLogout = await runCli(
        ["auth", "logout", "alice-team", "--profile-data", profileData],
        environment,
      );
      expect(aliceLogout.exitCode).toBe(0);
      expect(JSON.parse(aliceLogout.stdout)).toMatchObject({
        accountId: "usr_cli001_alice",
        remoteRevocation: "confirmed",
        status: "logged_out",
      });
      expect(authorization.observations.revokedTokens).toEqual([aliceRefreshAfter]);
      expect(await readFile(helperState, "utf8")).not.toContain(aliceRefreshAfter);
      const afterLogout = await runCli(
        ["auth", "status", "--profile-data", profileData],
        environment,
      );
      expect(afterLogout.exitCode).toBe(0);
      expect(z.object({profiles: z.array(profileOutputSchema)})
        .parse(JSON.parse(afterLogout.stdout)).profiles.map(({name}) => name))
        .toEqual(["bob-team", "lab"]);
      const teamByOrigin = await runCli(
        ["auth", "status", "--server", teamOrigin, "--profile-data", profileData],
        environment,
      );
      expect(teamByOrigin.exitCode).toBe(0);
      expect(JSON.parse(teamByOrigin.stdout)).toMatchObject({
        profiles: [{accountId: "usr_cli001_bob", name: "bob-team"}],
      });

      // CI: a scoped service credential from the secret manager, by
      // environment or by file, publishes without creating any profile.
      const ciProfileData = path.join(temporaryDirectory, "ci-profiles");
      const ciEnvironment = await credentialHelperEnvironment(
        helper,
        path.join(temporaryDirectory, "ci-helper.json"),
      );
      const ciByEnvironment = await runCli([
        "publish", fixture, "--name", "CI environment", "--profile-data", ciProfileData,
      ], {
        ...ciEnvironment,
        ARTIFACT_SERVER_API_TOKEN: labKey,
        ARTIFACT_SERVER_URL: labOrigin,
      }, "", project);
      expect(ciByEnvironment.exitCode).toBe(0);
      const secretDirectory = path.join(temporaryDirectory, "secret-manager");
      await mkdir(secretDirectory, {mode: 0o700});
      const tokenFile = path.join(secretDirectory, "artifact-server-token");
      await writeFile(tokenFile, `${labKey}\n`, {mode: 0o600});
      const ciByFile = await runCli([
        "publish", fixture, "--name", "CI file", "--new-artifact",
        "--server", labOrigin, "--token-file", tokenFile,
        "--profile-data", ciProfileData,
      ], ciEnvironment, "", project);
      expect(ciByFile.exitCode).toBe(0);
      expect(await artifactCount(labOrigin, labKey)).toBe(3);
      await expect(readFile(path.join(ciProfileData, "cli-profiles.json"), "utf8"))
        .rejects.toMatchObject({code: "ENOENT"});
      await expect(readFile(path.join(temporaryDirectory, "ci-helper.json"), "utf8"))
        .rejects.toMatchObject({code: "ENOENT"});

      // Local: the managed service authenticates automatically from private
      // user-only state; no login, profile, browser grant, or visible secret.
      const capturedUrl = path.join(temporaryDirectory, "opened-url");
      const capture = path.join(temporaryDirectory, "capture-browser");
      await writeFile(capture, '#!/bin/sh\nprintf "%s" "$1" > "$CLI001_OPENED_URL"\n', {
        mode: 0o700,
      });
      const localProfileData = path.join(temporaryDirectory, "local-profiles");
      const localEnvironment = {
        ...ciEnvironment,
        ARTIFACT_SERVER_BROWSER_COMMAND: capture,
        CLI001_OPENED_URL: capturedUrl,
      };
      const opened = await runCli(
        ["open", "--data", localData],
        localEnvironment,
        "",
        project,
      );
      expect(opened.exitCode).toBe(0);
      const serviceRecord = z.object({origin: z.url(), pid: z.number().int().positive()})
        .parse(JSON.parse(await readFile(path.join(localData, "local-service.json"), "utf8")));
      managedServicePid = serviceRecord.pid;
      const localToken = (await readFile(path.join(localData, "local-api-token"), "utf8"))
        .trim();
      expect((await stat(localData)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(localData, "local-api-token"))).mode & 0o777)
        .toBe(0o600);
      const localPublication = await runCli([
        "publish", fixture, "--data", localData, "--profile-data", localProfileData,
      ], localEnvironment, "", project);
      expect({exitCode: localPublication.exitCode, stderr: localPublication.stderr})
        .toEqual({exitCode: 0, stderr: ""});
      expect(new URL(publicationSchema.parse(JSON.parse(localPublication.stdout)).links.version).port)
        .toBe(new URL(serviceRecord.origin).port);
      expect(`${opened.stdout}${opened.stderr}${localPublication.stdout}`)
        .not.toContain(localToken);
      expect(new URL(await readFile(capturedUrl, "utf8")).search).toBe("");
      await expect(readFile(path.join(localProfileData, "cli-profiles.json"), "utf8"))
        .rejects.toMatchObject({code: "ENOENT"});
      expect((await readdir(project)).toSorted()).toEqual(["bob.txt", "lab.txt", "report.txt"]);
    } finally {
      if (managedServicePid !== undefined) {
        try {
          process.kill(managedServicePid, "SIGTERM");
        } catch {
          // The managed local service already stopped.
        }
      }
      await stopProcess(lab);
      await team.stop();
      await authorization.stop();
      await removeTestInstallation(installation);
      await rm(temporaryDirectory, {force: true, recursive: true});
    }
  }, 180_000);

  test("CLI-001-F: credentials stay out of output, arguments, project files, profiles, and server logs, never reach another origin, and fail closed when revoked or mismatched", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-cli-001-failure-"),
    );
    const profileData = path.join(temporaryDirectory, "profiles");
    const ciProfileData = path.join(temporaryDirectory, "ci-profiles");
    const helperState = path.join(temporaryDirectory, "credential-helper.json");
    const helper = path.join(temporaryDirectory, "credential-helper.mjs");
    const browser = path.join(temporaryDirectory, "browser.mjs");
    const argvLog = path.join(temporaryDirectory, "child-arguments.log");
    const project = path.join(temporaryDirectory, "project");
    const fixture = path.join(project, "report.txt");
    const labData = path.join(temporaryDirectory, "lab-server");
    const installation = await createTestInstallation();
    const environment = await credentialHelperEnvironment(helper, helperState);
    await writeBrowserHelper(browser);
    environment["ARTIFACT_SERVER_BROWSER_COMMAND"] = browser;
    environment["ARTIFACT_SERVER_TEST_ARGV_LOG"] = argvLog;
    await mkdir(project);
    await writeFile(fixture, "credential boundary publication\n");
    const authorization = await startArtifactServerAuthorization([
      {displayName: "Alice Example", id: "usr_cli001_alice"},
      {displayName: "Bob Example", id: "usr_cli001_bob"},
    ]);
    const teamPort = await reserveLoopbackPort();
    const teamOrigin = `http://127.0.0.1:${teamPort}`;
    const team = await startTestServer(installation, {
      apiOAuthResource: {
        authorizationServers: [authorization.origin],
        resource: `${teamOrigin}/api`,
      },
      externalApiBearerVerifier: authorization.verifier,
      port: teamPort,
    });
    const trap = await startRequestTrap();
    const labPort = await availablePort();
    const labOrigin = `http://127.0.0.1:${labPort}`;
    const lab = startServer(labData, labPort);
    const labOutput: string[] = [];
    lab.stdout.on("data", (chunk: Buffer) => labOutput.push(chunk.toString("utf8")));
    lab.stderr.on("data", (chunk: Buffer) => labOutput.push(chunk.toString("utf8")));
    const cliTranscript: string[] = [];
    const cli = async (
      argumentsToPass: readonly string[],
      processEnvironment: NodeJS.ProcessEnv = environment,
      standardInput = "",
    ): Promise<ProcessResult> => {
      const result = await runCli(argumentsToPass, processEnvironment, standardInput, project);
      cliTranscript.push(JSON.stringify(argumentsToPass), result.stdout, result.stderr);
      return result;
    };
    try {
      await waitForReady(lab, labPort);
      const labLocalToken = (await readFile(path.join(labData, "local-api-token"), "utf8"))
        .trim();
      const labAdministration = await administerLocalServer(
        `http://localhost:${labPort}`,
        labData,
      );
      const issuedKey = await labAdministration.issueKey("CLI-001 laptop key");

      authorization.signInAs("usr_cli001_alice");
      expect((await cli([
        "auth", "login", teamOrigin, "--name", "alpha", "--profile-data", profileData,
      ])).exitCode).toBe(0);
      authorization.signInAs("usr_cli001_bob");
      expect((await cli([
        "auth", "login", teamOrigin, "--name", "bravo", "--profile-data", profileData,
      ])).exitCode).toBe(0);
      expect((await cli([
        "auth", "login", labOrigin, "--api-key-stdin", "--name", "lab",
        "--profile-data", profileData,
      ], environment, `${issuedKey.token}\n`)).exitCode).toBe(0);
      authorization.expireAccessTokens();
      expect((await cli(["auth", "status", "--profile-data", profileData])).exitCode)
        .toBe(0);
      // Status renews both browser grants concurrently; each rotated grant
      // must be the one the credential store kept.
      const renewedStore = await readFile(helperState, "utf8");
      expect(renewedStore).toContain(authorization.currentRefreshToken("usr_cli001_alice"));
      expect(renewedStore).toContain(authorization.currentRefreshToken("usr_cli001_bob"));
      expect((await cli([
        "publish", fixture, "--profile", "alpha", "--profile-data", profileData,
      ])).exitCode).toBe(0);
      expect((await cli([
        "publish", fixture, "--profile", "lab", "--profile-data", profileData,
      ])).exitCode).toBe(0);
      expect((await cli([
        "publish", fixture, "--name", "CI", "--profile-data", ciProfileData,
      ], {
        ...environment,
        ARTIFACT_SERVER_API_TOKEN: labLocalToken,
        ARTIFACT_SERVER_URL: labOrigin,
      })).exitCode).toBe(0);

      // A saved profile is never sent to a different origin, whether named
      // explicitly or selected by origin, and the default is not substituted.
      const trapAttempts = [
        await cli([
          "auth", "status", "alpha", "--server", trap.origin,
          "--profile-data", profileData,
        ]),
        await cli([
          "publish", fixture, "--profile", "lab", "--server", trap.origin,
          "--profile-data", profileData,
        ]),
        await cli([
          "publish", fixture, "--server", trap.origin, "--profile-data", profileData,
        ]),
        await cli(["auth", "logout", "--server", trap.origin, "--profile-data", profileData]),
      ];
      for (const attempt of trapAttempts) {
        expect(attempt.exitCode).not.toBe(0);
        expect(attempt.stderr).toContain("CliProfileError");
      }
      expect(trap.requests).toEqual([]);

      // A credential that verifies as another account fails closed for the
      // profile that claims it.
      const profileIndex = z.object({
        profiles: z.array(z.object({credentialId: z.string(), name: z.string()}).loose()),
      }).loose().parse(JSON.parse(await readFile(path.join(profileData, "cli-profiles.json"), "utf8")));
      const credentialFor = (name: string): string => {
        const match = profileIndex.profiles.find((profile) => profile.name === name);
        if (match === undefined) throw new Error(`Missing profile ${name}.`);
        return match.credentialId;
      };
      const storedSecrets = z.record(z.string(), z.string())
        .parse(JSON.parse(await readFile(helperState, "utf8")));
      const alphaSecret = storedSecrets[credentialFor("alpha")];
      const bravoSecret = storedSecrets[credentialFor("bravo")];
      if (alphaSecret === undefined || bravoSecret === undefined) {
        throw new Error("The credential helper did not hold both browser grants.");
      }
      await writeFile(helperState, JSON.stringify({
        ...storedSecrets,
        [credentialFor("alpha")]: bravoSecret,
      }));
      const teamArtifactsBefore = await artifactCount(teamOrigin, installation.apiToken);
      const mismatchedStatus = await cli([
        "auth", "status", "alpha", "--profile-data", profileData,
      ]);
      expect(mismatchedStatus.exitCode).toBe(2);
      expect(JSON.parse(mismatchedStatus.stdout)).toMatchObject({
        profiles: [{name: "alpha", status: "invalid"}],
      });
      const mismatchedPublish = await cli([
        "publish", fixture, "--name", "Mismatched", "--new-artifact",
        "--profile", "alpha", "--profile-data", profileData,
      ]);
      expect(mismatchedPublish.exitCode).not.toBe(0);
      expect(mismatchedPublish.stderr)
        .toContain("belongs to a different Artifact Server account");
      expect(await artifactCount(teamOrigin, installation.apiToken))
        .toBe(teamArtifactsBefore);
      await writeFile(helperState, JSON.stringify({
        ...storedSecrets,
        [credentialFor("alpha")]: alphaSecret,
      }));

      // A grant revoked at the identity provider and a key revoked on the
      // server both fail closed instead of falling back to another credential.
      authorization.revokeAccount("usr_cli001_alice");
      const revokedGrant = await cli(["auth", "status", "alpha", "--profile-data", profileData]);
      expect(revokedGrant.exitCode).toBe(2);
      expect(JSON.parse(revokedGrant.stdout)).toMatchObject({
        profiles: [{name: "alpha", status: "invalid"}],
      });
      const revokedGrantPublish = await cli([
        "publish", fixture, "--name", "Revoked grant", "--new-artifact",
        "--profile", "alpha", "--profile-data", profileData,
      ]);
      expect(revokedGrantPublish.exitCode).not.toBe(0);
      expect(await artifactCount(teamOrigin, installation.apiToken))
        .toBe(teamArtifactsBefore);

      const labArtifactsBefore = await artifactCount(labOrigin, labLocalToken);
      await labAdministration.revokeKey(issuedKey.id);
      const revokedKey = await cli(["auth", "status", "lab", "--profile-data", profileData]);
      expect(revokedKey.exitCode).toBe(2);
      expect(JSON.parse(revokedKey.stdout)).toMatchObject({
        profiles: [{name: "lab", status: "invalid"}],
      });
      const revokedKeyPublish = await cli([
        "publish", fixture, "--name", "Revoked key", "--new-artifact",
        "--profile", "lab", "--profile-data", profileData,
      ]);
      expect(revokedKeyPublish.exitCode).not.toBe(0);
      const revokedCiPublish = await cli([
        "publish", fixture, "--name", "Revoked CI", "--new-artifact",
        "--profile-data", ciProfileData,
      ], {
        ...environment,
        ARTIFACT_SERVER_API_TOKEN: issuedKey.token,
        ARTIFACT_SERVER_URL: labOrigin,
      });
      expect(revokedCiPublish.exitCode).not.toBe(0);
      const malformedCiToken = "not a credential; contains spaces and is too short";
      const malformedCi = await cli([
        "publish", fixture, "--profile-data", ciProfileData,
      ], {
        ...environment,
        ARTIFACT_SERVER_API_TOKEN: malformedCiToken,
        ARTIFACT_SERVER_URL: labOrigin,
      });
      expect(malformedCi.exitCode).not.toBe(0);
      expect(malformedCi.stderr).toContain("ARTIFACT_SERVER_API_TOKEN is invalid.");
      expect(malformedCi.stderr).not.toContain(malformedCiToken);
      expect(await artifactCount(labOrigin, labLocalToken)).toBe(labArtifactsBefore);

      expect((await cli(["auth", "logout", "bravo", "--profile-data", profileData])).exitCode)
        .toBe(0);

      const secrets = [
        labLocalToken,
        issuedKey.token,
        installation.apiToken,
        ...authorization.issuedSecrets(),
      ];
      expect(authorization.issuedSecrets().length).toBeGreaterThanOrEqual(6);
      // The credential store and browser really ran; secrets reached them
      // only on standard input or through the authorization redirect.
      const childArguments = await readFile(argvLog, "utf8");
      expect(childArguments).toContain('["write"]');
      expect(childArguments).toContain(`${authorization.origin}/authorize?`);
      expect(labOutput.join("")).toContain("Artifact Server:");
      const surfaces: ReadonlyArray<readonly [string, string]> = [
        ["CLI arguments and output", cliTranscript.join("\n")],
        ["credential-helper and browser arguments", childArguments],
        ["Artifact Server process log", labOutput.join("")],
        ...await readTextTree(profileData),
        ...await readTextTree(ciProfileData),
        ...await readTextTree(project),
      ];
      expect(surfaces.length).toBeGreaterThan(5);
      for (const [surface, text] of surfaces) {
        for (const secret of secrets) {
          expect({surface, leaked: text.includes(secret)})
            .toEqual({surface, leaked: false});
        }
      }
      expect(await readdir(project)).toEqual(["report.txt"]);
    } finally {
      await stopProcess(lab);
      await trap.stop();
      await team.stop();
      await authorization.stop();
      await removeTestInstallation(installation);
      await rm(temporaryDirectory, {force: true, recursive: true});
    }
  }, 180_000);
});

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface LostCommitResponseProxy {
  readonly origin: string;
  droppedResponses(): number;
  errors(): readonly string[];
  stop(): Promise<void>;
}

async function startLostCommitResponseProxy(
  upstreamOrigin: string,
): Promise<LostCommitResponseProxy> {
  let origin = "";
  let droppedResponses = 0;
  const errors: string[] = [];
  const server = createHttpServer(async (request, response) => {
    try {
      const target = new URL(request.url ?? "/", upstreamOrigin);
      const requestBody = await readTextBody(request);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value === undefined
          || name === "host"
          || name === "connection"
          || name === "content-length"
          || name === "transfer-encoding"
        ) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const requestInit: RequestInit = requestBody.length === 0
        ? {headers, method: request.method ?? "GET"}
        : {body: requestBody, headers, method: request.method ?? "GET"};
      const upstream = await fetch(target, requestInit);
      const body = await upstream.text();
      if (
        request.method === "POST"
        && target.pathname.endsWith("/commit")
        && droppedResponses === 0
      ) {
        droppedResponses += 1;
        response.destroy();
        return;
      }
      let responseBody = body;
      if (request.method === "POST" && target.pathname === "/api/v1/uploads") {
        const decoded = z.object({
          commitUrl: z.url().optional(),
          files: z.array(z.object({uploadUrl: z.url()}).passthrough()).optional(),
        }).passthrough().parse(JSON.parse(body));
        // A committed replay has no plan URLs to rewrite; only fresh and
        // resumed upload plans carry origin-bound transfer URLs.
        if (decoded.commitUrl !== undefined && decoded.files !== undefined) {
          const commitUrl = decoded.commitUrl;
          const files = decoded.files;
          responseBody = JSON.stringify({
            ...decoded,
            commitUrl: replaceOrigin(commitUrl, origin),
            files: files.map((file) => Object.assign({}, file, {
              uploadUrl: replaceOrigin(file.uploadUrl, origin),
            })),
          });
        }
      }
      response.writeHead(upstream.status, {"Content-Type": "application/json"});
      response.end(responseBody.replaceAll(upstreamOrigin, origin));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Proxy failure");
      response.writeHead(502, {"Content-Type": "text/plain"});
      response.end(error instanceof Error ? error.message : "Proxy failure");
    }
  });
  await listenHttp(server);
  const address = assignedAddressSchema.parse(server.address());
  origin = `http://127.0.0.1:${address.port}`;
  return {
    droppedResponses: () => droppedResponses,
    errors: () => errors,
    origin,
    stop: () => closeHttp(server),
  };
}

function replaceOrigin(value: string, origin: string): string {
  const url = new URL(value);
  const replacement = new URL(origin);
  url.protocol = replacement.protocol;
  url.host = replacement.host;
  return url.toString();
}

function runCli(
  argumentsToPass: readonly string[],
  environment: NodeJS.ProcessEnv,
  standardInput = "",
  workingDirectory = repositoryRoot,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliExecutable, [cliEntrypoint, ...argumentsToPass], {
      cwd: workingDirectory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      exitCode: code ?? -1,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    }));
    child.stdin.end(standardInput, "utf8");
  });
}

function startServer(
  dataDirectory: string,
  port: number,
): ChildProcessWithoutNullStreams {
  const child = spawn(cliExecutable, [
    cliEntrypoint,
    "start",
    "--data",
    dataDirectory,
    "--port",
    String(port),
  ], {cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"]});
  runningProcesses.add(child);
  return child;
}

async function waitForReady(
  child: ChildProcessWithoutNullStreams,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const expected = `Artifact Server: http://localhost:${port}`;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Artifact Server did not become ready."));
    }, 10_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const exit = () => {
      cleanup();
      reject(new Error("Artifact Server exited before becoming ready."));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", receive);
      child.stderr.off("data", receive);
      child.off("exit", exit);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("exit", exit);
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!runningProcesses.delete(child) || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await exited;
}

async function credentialHelperEnvironment(
  helper: string,
  statePath: string,
): Promise<NodeJS.ProcessEnv> {
  // Real credential stores update one entry atomically, and the CLI renews
  // several profiles concurrently (auth status), so this file-backed store
  // serializes each read-modify-write under an exclusive lock and replaces
  // the file by rename. Without that, concurrent writes lose updates.
  await writeFile(helper, `#!/usr/bin/env node
import {appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from "node:fs";
const argvLog = process.env.ARTIFACT_SERVER_TEST_ARGV_LOG;
if (argvLog !== undefined) appendFileSync(argvLog, JSON.stringify(process.argv.slice(2)) + "\\n");
const input = JSON.parse(readFileSync(0, "utf8"));
const statePath = process.env.CREDENTIAL_HELPER_STATE;
if (statePath === undefined) process.exit(3);
const lockPath = statePath + ".lock";
const deadline = Date.now() + 15000;
let lock;
for (;;) {
  try {
    lock = openSync(lockPath, "wx");
    break;
  } catch (error) {
    if (error.code !== "EEXIST" || Date.now() > deadline) process.exit(4);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
let exitCode = 0;
try {
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {};
  const save = () => {
    const pending = statePath + "." + process.pid + ".tmp";
    writeFileSync(pending, JSON.stringify(state));
    renameSync(pending, statePath);
  };
  const operation = process.argv[2];
  if (operation === "read") {
    if (input.account in state) process.stdout.write(state[input.account]);
    else exitCode = 2;
  } else if (operation === "write") {
    state[input.account] = input.secret;
    save();
  } else if (operation === "delete") {
    if (input.account in state) {
      delete state[input.account];
      save();
    } else {
      exitCode = 2;
    }
  } else {
    exitCode = 3;
  }
} finally {
  closeSync(lock);
  unlinkSync(lockPath);
}
process.exitCode = exitCode;
`, {mode: 0o700});
  await chmod(helper, 0o700);
  const inherited = {...process.env};
  delete inherited["ARTIFACT_SERVER_URL"];
  delete inherited["ARTIFACT_SERVER_API_TOKEN"];
  return {
    ...inherited,
    ARTIFACT_SERVER_CREDENTIAL_HELPER: helper,
    CREDENTIAL_HELPER_STATE: statePath,
  };
}

async function writeBrowserHelper(target: string): Promise<void> {
  await writeFile(target, `#!/usr/bin/env node
import {appendFileSync} from "node:fs";
const argvLog = process.env.ARTIFACT_SERVER_TEST_ARGV_LOG;
if (argvLog !== undefined) appendFileSync(argvLog, JSON.stringify(process.argv.slice(2)) + "\\n");
const target = process.argv[2];
if (target === undefined) process.exit(2);
const response = await fetch(target, {redirect: "follow"});
if (!response.ok) process.exit(3);
`, {mode: 0o700});
  await chmod(target, 0o700);
}

interface OAuthFixtureObservations {
  authorizationCount: number;
  codeExchangeCount: number;
  lastSessionBearer: string | null;
  pkceVerified: boolean;
  refreshCount: number;
  registrationCount: number;
  revocationCount: number;
  revokedToken: string | null;
  sessionCount: number;
}

interface OAuthFixture {
  readonly observations: OAuthFixtureObservations;
  readonly origin: string;
  advertiseAuthorizationServer(origin: string): void;
  advertiseWrongResource(): void;
  redirectRevocationTo(origin: string | null): void;
  stop(): Promise<void>;
}

async function startOAuthFixture(): Promise<OAuthFixture> {
  const observations: OAuthFixtureObservations = {
    authorizationCount: 0,
    codeExchangeCount: 0,
    lastSessionBearer: null,
    pkceVerified: false,
    refreshCount: 0,
    registrationCount: 0,
    revocationCount: 0,
    revokedToken: null,
    sessionCount: 0,
  };
  let wrongResource = false;
  let advertisedAuthorizationServer: string | null = null;
  let revocationRedirect: string | null = null;
  let codeChallenge: string | null = null;
  let expectedRedirect: string | null = null;
  let origin = "";
  const server = createHttpServer(async (request, response) => {
    const target = new URL(request.url ?? "/", origin);
    if (target.pathname === "/.well-known/oauth-protected-resource/api") {
      sendJson(response, 200, {
        authorization_servers: [advertisedAuthorizationServer ?? origin],
        bearer_methods_supported: ["header"],
        resource: wrongResource ? `${origin}/wrong` : `${origin}/api`,
        scopes_supported: ["artifactserver"],
      });
      return;
    }
    if (
      target.pathname === "/.well-known/oauth-authorization-server"
      || target.pathname === "/.well-known/openid-configuration"
    ) {
      sendJson(response, 200, {
        authorization_endpoint: `${origin}/authorize`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: origin,
        jwks_uri: `${origin}/jwks`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        revocation_endpoint: `${origin}/revoke`,
        token_endpoint: `${origin}/token`,
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (target.pathname === "/register" && request.method === "POST") {
      observations.registrationCount += 1;
      const registration = z.object({
        redirect_uris: z.array(z.url()).min(1),
      }).passthrough().parse(JSON.parse(await readTextBody(request)));
      sendJson(response, 201, {
        client_id: "artifactserver-cli-test-client",
        redirect_uris: registration.redirect_uris,
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (target.pathname === "/authorize" && request.method === "GET") {
      observations.authorizationCount += 1;
      codeChallenge = target.searchParams.get("code_challenge");
      expectedRedirect = target.searchParams.get("redirect_uri");
      const state = target.searchParams.get("state");
      if (
        codeChallenge === null
        || target.searchParams.get("code_challenge_method") !== "S256"
        || expectedRedirect === null
        || state === null
      ) {
        response.writeHead(400).end();
        return;
      }
      const redirect = new URL(expectedRedirect);
      redirect.searchParams.set("code", "authorization-code-one");
      redirect.searchParams.set("iss", origin);
      redirect.searchParams.set("state", state);
      response.writeHead(302, {Location: redirect.toString()}).end();
      return;
    }
    if (target.pathname === "/token" && request.method === "POST") {
      const body = new URLSearchParams(await readTextBody(request));
      const grantType = body.get("grant_type");
      if (grantType === "authorization_code") {
        observations.codeExchangeCount += 1;
        const verifier = body.get("code_verifier");
        const redirect = body.get("redirect_uri");
        observations.pkceVerified = verifier !== null
          && codeChallenge === createHash("sha256")
            .update(verifier)
            .digest("base64url")
          && redirect === expectedRedirect;
        if (!observations.pkceVerified) {
          sendJson(response, 400, {error: "invalid_grant"});
          return;
        }
        sendJson(response, 200, {
          access_token: "oauth-access-one",
          expires_in: 3_600,
          refresh_token: "oauth-refresh-one",
          scope: "artifactserver offline_access",
          token_type: "Bearer",
        });
        return;
      }
      if (grantType === "refresh_token") {
        observations.refreshCount += 1;
        if (body.get("refresh_token") !== "oauth-refresh-one") {
          sendJson(response, 400, {error: "invalid_grant"});
          return;
        }
        sendJson(response, 200, {
          access_token: "oauth-access-two",
          expires_in: 3_600,
          refresh_token: "oauth-refresh-two",
          scope: "artifactserver offline_access",
          token_type: "Bearer",
        });
        return;
      }
    }
    if (target.pathname === "/api/v1/session" && request.method === "GET") {
      const authorization = request.headers.authorization;
      const bearer = authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length)
        : null;
      observations.lastSessionBearer = bearer;
      observations.sessionCount += 1;
      const accepted = bearer === "oauth-access-two"
        || (bearer === "oauth-access-one" && observations.sessionCount === 1);
      if (!accepted) {
        sendJson(response, 401, {error: {code: "AUTHENTICATION_REQUIRED"}});
        return;
      }
      sendJson(response, 200, {
        authenticationMethod: "bearer",
        principal: {
          authorizedByPrincipalId: null,
          capabilities: [
            "artifact:create",
            "artifact:publish:any",
            "artifact:read",
          ],
          id: "usr_oauth_test",
          installationId: "ins_oauth_test",
          kind: "human",
          membershipRole: "member",
        },
      });
      return;
    }
    if (target.pathname === "/revoke" && request.method === "POST") {
      if (revocationRedirect !== null) {
        response.writeHead(307, {Location: `${revocationRedirect}/revoke`}).end();
        return;
      }
      observations.revocationCount += 1;
      observations.revokedToken = new URLSearchParams(
        await readTextBody(request),
      ).get("token");
      response.writeHead(200).end();
      return;
    }
    if (target.pathname === "/jwks") {
      sendJson(response, 200, {keys: []});
      return;
    }
    response.writeHead(404).end();
  });
  await listenHttp(server);
  const address = assignedAddressSchema.parse(server.address());
  origin = `http://127.0.0.1:${address.port}`;
  return {
    advertiseAuthorizationServer: (value) => {
      advertisedAuthorizationServer = value;
    },
    advertiseWrongResource: () => {
      wrongResource = true;
    },
    observations,
    origin,
    redirectRevocationTo: (value) => {
      revocationRedirect = value;
    },
    stop: () => closeHttp(server),
  };
}

function readTextBody(
  request: IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("error", reject);
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: JsonValue,
): void {
  response.writeHead(status, {"Content-Type": "application/json"});
  response.end(JSON.stringify(value));
}

function listenHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = assignedAddressSchema.safeParse(server.address());
      if (!address.success) {
        server.close();
        reject(new Error("The operating system did not assign a TCP port."));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolve(address.data.port);
        else reject(error);
      });
    });
  });
}

interface AuthorizationAccount {
  readonly displayName: string;
  readonly id: string;
}

interface AuthorizationGrant {
  readonly accessToken: string;
  accessValid: boolean;
  readonly accountId: string;
  readonly refreshToken: string;
  refreshValid: boolean;
}

interface ArtifactServerAuthorizationObservations {
  readonly acceptedAccounts: string[];
  authorizationCount: number;
  readonly pkceResults: boolean[];
  refreshCount: number;
  readonly revokedTokens: string[];
}

interface ArtifactServerAuthorization {
  readonly observations: ArtifactServerAuthorizationObservations;
  readonly origin: string;
  /** The real Artifact Server's external API bearer port, backed by this issuer. */
  readonly verifier: BearerCredentialVerifier;
  currentRefreshToken(accountId: string): string;
  expireAccessTokens(): void;
  issuedSecrets(): readonly string[];
  revokeAccount(accountId: string): void;
  signInAs(accountId: string): void;
  stop(): Promise<void>;
}

/**
 * Stand-in for the deployment's identity provider: dynamic client
 * registration, S256 PKCE authorization, rotating refresh, and revocation.
 * Artifact Server itself is real and verifies the issued access tokens
 * through its external API bearer port.
 */
async function startArtifactServerAuthorization(
  accounts: readonly AuthorizationAccount[],
): Promise<ArtifactServerAuthorization> {
  const observations: ArtifactServerAuthorizationObservations = {
    acceptedAccounts: [],
    authorizationCount: 0,
    pkceResults: [],
    refreshCount: 0,
    revokedTokens: [],
  };
  const grants: AuthorizationGrant[] = [];
  const codes = new Map<string, {
    readonly accountId: string;
    readonly challenge: string;
    readonly redirectUri: string;
  }>();
  let signedInAccount: string | null = null;
  let origin = "";
  const issueGrant = (accountId: string): AuthorizationGrant => {
    const grant: AuthorizationGrant = {
      accessToken: randomBytes(32).toString("base64url"),
      accessValid: true,
      accountId,
      refreshToken: randomBytes(32).toString("base64url"),
      refreshValid: true,
    };
    grants.push(grant);
    return grant;
  };
  const server = createHttpServer(async (request, response) => {
    const target = new URL(request.url ?? "/", origin);
    if (
      target.pathname === "/.well-known/oauth-authorization-server"
      || target.pathname === "/.well-known/openid-configuration"
    ) {
      sendJson(response, 200, {
        authorization_endpoint: `${origin}/authorize`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: origin,
        jwks_uri: `${origin}/jwks`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        revocation_endpoint: `${origin}/revoke`,
        token_endpoint: `${origin}/token`,
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (target.pathname === "/register" && request.method === "POST") {
      const registration = z.object({redirect_uris: z.array(z.url()).min(1)})
        .loose().parse(JSON.parse(await readTextBody(request)));
      sendJson(response, 201, {
        client_id: `client-${randomBytes(8).toString("hex")}`,
        redirect_uris: registration.redirect_uris,
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (target.pathname === "/authorize" && request.method === "GET") {
      observations.authorizationCount += 1;
      const challenge = target.searchParams.get("code_challenge");
      const redirectUri = target.searchParams.get("redirect_uri");
      const state = target.searchParams.get("state");
      if (
        signedInAccount === null
        || challenge === null
        || target.searchParams.get("code_challenge_method") !== "S256"
        || redirectUri === null
        || state === null
      ) {
        response.writeHead(400).end();
        return;
      }
      const code = randomBytes(16).toString("base64url");
      codes.set(code, {accountId: signedInAccount, challenge, redirectUri});
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("iss", origin);
      redirect.searchParams.set("state", state);
      response.writeHead(302, {Location: redirect.toString()}).end();
      return;
    }
    if (target.pathname === "/token" && request.method === "POST") {
      const body = new URLSearchParams(await readTextBody(request));
      if (body.get("grant_type") === "authorization_code") {
        const code = codes.get(body.get("code") ?? "");
        codes.delete(body.get("code") ?? "");
        const verifier = body.get("code_verifier");
        const verified = code !== undefined
          && verifier !== null
          && code.challenge === createHash("sha256").update(verifier).digest("base64url")
          && body.get("redirect_uri") === code.redirectUri;
        observations.pkceResults.push(verified);
        if (!verified) {
          sendJson(response, 400, {error: "invalid_grant"});
          return;
        }
        sendJson(response, 200, tokenResponse(issueGrant(code.accountId)));
        return;
      }
      if (body.get("grant_type") === "refresh_token") {
        observations.refreshCount += 1;
        const grant = grants.find((candidate) =>
          candidate.refreshValid && candidate.refreshToken === body.get("refresh_token")
        );
        if (grant === undefined) {
          sendJson(response, 400, {error: "invalid_grant"});
          return;
        }
        grant.accessValid = false;
        grant.refreshValid = false;
        sendJson(response, 200, tokenResponse(issueGrant(grant.accountId)));
        return;
      }
      sendJson(response, 400, {error: "unsupported_grant_type"});
      return;
    }
    if (target.pathname === "/revoke" && request.method === "POST") {
      const token = new URLSearchParams(await readTextBody(request)).get("token") ?? "";
      observations.revokedTokens.push(token);
      for (const grant of grants) {
        if (grant.refreshToken !== token && grant.accessToken !== token) continue;
        grant.accessValid = false;
        grant.refreshValid = false;
      }
      response.writeHead(200).end();
      return;
    }
    if (target.pathname === "/jwks") {
      sendJson(response, 200, {keys: []});
      return;
    }
    response.writeHead(404).end();
  });
  await listenHttp(server);
  origin = `http://127.0.0.1:${assignedAddressSchema.parse(server.address()).port}`;
  const verifier: BearerCredentialVerifier = {
    verify: (credential) => {
      const grant = grants.find((candidate) =>
        candidate.accessValid && candidate.accessToken === Redacted.value(credential)
      );
      const account = accounts.find((candidate) => candidate.id === grant?.accountId);
      if (grant === undefined || account === undefined) {
        return Effect.fail(new AuthenticationRequired({
          message: "The identity provider access token is not active.",
        }));
      }
      observations.acceptedAccounts.push(account.id);
      const principal: Principal = {
        authorizedByPrincipalId: null,
        capabilities: [
          principalCapabilities.createArtifact,
          principalCapabilities.publishAnyArtifact,
          principalCapabilities.readArtifacts,
        ],
        displayName: account.displayName,
        id: account.id,
        installationId: "local",
        kind: principalKinds.human,
        membershipRole: membershipRoles.member,
      };
      return Effect.succeed(principal);
    },
  };
  return {
    currentRefreshToken: (accountId) => {
      const grant = grants.findLast((candidate) =>
        candidate.accountId === accountId && candidate.refreshValid
      );
      if (grant === undefined) throw new Error(`No active grant for ${accountId}.`);
      return grant.refreshToken;
    },
    expireAccessTokens: () => {
      for (const grant of grants) grant.accessValid = false;
    },
    issuedSecrets: () => grants.flatMap((grant) => [grant.accessToken, grant.refreshToken]),
    observations,
    origin,
    revokeAccount: (accountId) => {
      for (const grant of grants) {
        if (grant.accountId !== accountId) continue;
        grant.accessValid = false;
        grant.refreshValid = false;
      }
    },
    signInAs: (accountId) => {
      signedInAccount = accountId;
    },
    stop: () => closeHttp(server),
    verifier,
  };
}

function tokenResponse(grant: AuthorizationGrant): JsonValue {
  return {
    access_token: grant.accessToken,
    expires_in: 3_600,
    refresh_token: grant.refreshToken,
    scope: "artifactserver offline_access",
    token_type: "Bearer",
  };
}

interface RequestTrap {
  readonly origin: string;
  readonly requests: string[];
  stop(): Promise<void>;
}

/** An unrelated origin that records every request a misdirected CLI would send. */
async function startRequestTrap(): Promise<RequestTrap> {
  const requests: string[] = [];
  const server = createHttpServer((request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"} ${request.headers.authorization ?? ""}`);
    response.writeHead(404).end();
  });
  await listenHttp(server);
  return {
    origin: `http://127.0.0.1:${assignedAddressSchema.parse(server.address()).port}`,
    requests,
    stop: () => closeHttp(server),
  };
}

interface LocalServerAdministration {
  issueKey(name: string): Promise<{readonly id: string; readonly token: string}>;
  revokeKey(keyId: string): Promise<void>;
}

/** Sign in as the local owner through the browser path and manage API keys. */
async function administerLocalServer(
  applicationOrigin: string,
  dataDirectory: string,
): Promise<LocalServerAdministration> {
  const bootstrap = (await readFile(
    path.join(dataDirectory, "local-browser-token"),
    "utf8",
  )).trim();
  const issued = await fetch(new URL("/auth/local", applicationOrigin), {
    headers: {Authorization: `Bearer ${bootstrap}`},
    method: "POST",
  });
  expect(issued.status).toBe(201);
  const loginToken = z.object({token: z.string()}).loose()
    .parse(await issued.json()).token;
  const login = await fetch(
    new URL(`/auth/local?token=${encodeURIComponent(loginToken)}`, applicationOrigin),
    {redirect: "manual"},
  );
  expect(login.status).toBe(303);
  const cookies = login.headers.getSetCookie().map((value) => value.split(";", 1)[0] ?? "");
  const csrf = cookies.find((value) => value.startsWith("artifact_csrf="))
    ?.slice("artifact_csrf=".length);
  if (csrf === undefined) throw new Error("The local owner login issued no CSRF cookie.");
  const headers = new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.join("; "),
    Origin: applicationOrigin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": csrf,
  });
  return {
    issueKey: async (name) => {
      const response = await fetch(new URL("/api/v1/api-keys", applicationOrigin), {
        body: JSON.stringify({
          capabilities: [
            principalCapabilities.createArtifact,
            principalCapabilities.publishAnyArtifact,
            principalCapabilities.readArtifacts,
          ],
          expiresAt: "2099-01-01T00:00:00.000Z",
          name,
        }),
        headers,
        method: "POST",
      });
      expect(response.status).toBe(201);
      const key = z.object({
        apiKey: z.object({id: z.string()}).loose(),
        token: z.string().startsWith("as_key_"),
      }).loose().parse(await response.json());
      return {id: key.apiKey.id, token: key.token};
    },
    revokeKey: async (keyId) => {
      const response = await fetch(
        new URL(`/api/v1/api-keys/${encodeURIComponent(keyId)}/revoke`, applicationOrigin),
        {headers, method: "POST"},
      );
      expect(response.status).toBe(200);
    },
  };
}

async function artifactCount(origin: string, token: string): Promise<number> {
  const response = await fetch(`${origin}/api/v1/artifacts?limit=100`, {
    headers: {Authorization: `Bearer ${token}`},
  });
  expect(response.status).toBe(200);
  return z.object({artifacts: z.array(z.unknown())}).loose()
    .parse(await response.json()).artifacts.length;
}

/** Every regular file below a directory as [relative path, text]. */
async function readTextTree(
  directory: string,
): Promise<ReadonlyArray<readonly [string, string]>> {
  const entries = await readdir(directory, {recursive: true, withFileTypes: true});
  return Promise.all(entries
    .filter((entry) => entry.isFile())
    .map(async (entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(path.dirname(directory), file), await readFile(file, "utf8")] as const;
    }));
}
