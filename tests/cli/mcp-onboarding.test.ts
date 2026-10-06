import {spawn} from "node:child_process";
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
import {tmpdir} from "node:os";
import path from "node:path";

import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  connectMcpClient,
  disconnectMcpClient,
} from "../../src/cli/mcp-client-registrations.js";
import type {CliInvocation} from "../../src/cli/current-cli-invocation.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliEntrypoint = path.join(repositoryRoot, "src/cli/main.ts");
const connectFixture = path.join(
  repositoryRoot,
  "tests/cli/fixtures/run-connect-mcp-client.ts",
);
const tsxExecutable = path.join(repositoryRoot, "node_modules/.bin/tsx");
const modernProtocolRevision = "2026-07-28";
const processStartupTimeoutMilliseconds = 45_000;
const testTimeoutMilliseconds = 60_000;
const temporaryDirectories = new Set<string>();
const managedServicePids = new Set<number>();
const serviceRecordSchema = z.object({
  dataDirectory: z.string(),
  origin: z.url(),
  pid: z.number().int().positive(),
  productVersion: z.string(),
  schemaVersion: z.literal(1),
  startedAt: z.string(),
}).strict();
const doctorSchema = z.object({
  clients: z.array(z.object({client: z.string()}).loose()),
  discovery: z.object({
    protocolRevision: z.literal(modernProtocolRevision),
    status: z.literal("healthy"),
    tools: z.number().int().positive(),
  }),
  service: z.object({
    reachable: z.literal(true),
    recordState: z.literal("valid"),
  }),
  status: z.literal("healthy"),
}).loose();
const registrationFileSchema = z.object({
  registrations: z.array(z.object({client: z.string()})),
}).loose();
const systemErrorSchema = z.object({code: z.string().optional()});
const supportedClients = ["codex", "claude", "cursor", "vscode"] as const;
type SupportedClient = typeof supportedClients[number];
const connectOutputSchema = z.object({
  client: z.enum(supportedClients),
  serverAddress: z.url(),
}).strict();
const registeredCommandSchema = z.object({
  args: z.array(z.string()),
  command: z.string().min(1),
});
const registrationStateSchema = z.object({
  registrations: z.array(registeredCommandSchema.extend({client: z.string()})),
});
const cursorConfigurationSchema = z.object({
  mcpServers: z.object({"artifact-server": registeredCommandSchema.strict()}),
});
const vscodeConfigurationSchema = z.object({
  servers: z.object({
    "artifact-server": registeredCommandSchema.extend({type: z.literal("stdio")}).strict(),
  }),
});

afterEach(async () => {
  for (const pid of managedServicePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // A service that already stopped needs no further action.
    }
  }
  managedServicePids.clear();
  await Promise.all([...temporaryDirectories].map((directory) =>
    rm(directory, {force: true, recursive: true})
  ));
  temporaryDirectories.clear();
});

describe("local MCP onboarding", {timeout: testTimeoutMilliseconds}, () => {
  test("stdio reuses one service and preserves modern discovery", async () => {
    const workspace = await temporaryWorkspace("artifact-server-mcp-stdio-");
    const dataDirectory = path.join(workspace, "data");

    const first = await connectStdio(dataDirectory);
    const firstTools = await first.client.listTools();
    expect(first.client.getNegotiatedProtocolVersion()).toBe(modernProtocolRevision);
    expect(firstTools.tools).toHaveLength(34);
    const capabilities = await first.client.callTool({
      arguments: {},
      name: "artifact_capabilities",
    });
    expect(capabilities.isError).not.toBe(true);
    await first.client.close();

    const serviceRecord = serviceRecordSchema.parse(JSON.parse(await readFile(
      path.join(dataDirectory, "local-service.json"),
      "utf8",
    )));
    managedServicePids.add(serviceRecord.pid);
    expect((await stat(path.join(dataDirectory, "local-service.json"))).mode & 0o777)
      .toBe(0o600);
    expect((await stat(path.join(dataDirectory, "local-service.log"))).mode & 0o777)
      .toBe(0o600);
    expect(await fetch(new URL("/health", serviceRecord.origin)).then((response) =>
      response.json()
    )).toEqual({status: "ok"});

    const second = await connectStdio(dataDirectory);
    expect((await second.client.listTools()).tools).toHaveLength(34);
    await second.client.close();

    const legacy = await connectStdio(dataDirectory, "legacy");
    expect((await legacy.client.listTools()).tools).toHaveLength(34);
    const legacyCapabilities = await legacy.client.callTool({
      arguments: {},
      name: "artifact_capabilities",
    });
    expect(legacyCapabilities.isError).not.toBe(true);
    await legacy.client.close();
    const secondRecord = serviceRecordSchema.parse(JSON.parse(await readFile(
      path.join(dataDirectory, "local-service.json"),
      "utf8",
    )));
    expect(secondRecord.pid).toBe(serviceRecord.pid);

    const doctor = await runCli(["doctor", "--data", dataDirectory]);
    expect(doctor.exitCode).toBe(0);
    expect(doctorSchema.parse(JSON.parse(doctor.stdout))).toMatchObject({
      discovery: {tools: 34},
      status: "healthy",
    });
    const apiCredential = (await readFile(
      path.join(dataDirectory, "local-api-token"),
      "utf8",
    )).trim();
    const browserCredential = (await readFile(
      path.join(dataDirectory, "local-browser-token"),
      "utf8",
    )).trim();
    const safeSurfaces = [
      doctor.stdout,
      doctor.stderr,
      await readFile(path.join(dataDirectory, "local-service.json"), "utf8"),
      await readFile(path.join(dataDirectory, "local-service.log"), "utf8"),
      await readProcessCommand(serviceRecord.pid),
    ].join("\n");
    expect(safeSurfaces).not.toContain(apiCredential);
    expect(safeSurfaces).not.toContain(browserCredential);
    expect(safeSurfaces).not.toContain("Local API token:");
    expect(safeSurfaces).not.toContain("Browser login:");
  }, 30_000);

  test("connect and disconnect preserve unrelated client configuration", async () => {
    const workspace = await temporaryWorkspace("artifact-server-mcp-clients-");
    const dataDirectory = path.join(workspace, "data");
    const binaryDirectory = path.join(workspace, "bin");
    const fakeStateDirectory = path.join(workspace, "fake-client-state");
    const cursorConfig = path.join(workspace, "cursor", "mcp.json");
    const vscodeConfig = path.join(workspace, "vscode", "mcp.json");
    await Promise.all([
      mkdir(binaryDirectory, {recursive: true}),
      mkdir(fakeStateDirectory, {recursive: true}),
      mkdir(path.dirname(cursorConfig), {recursive: true}),
      mkdir(path.dirname(vscodeConfig), {recursive: true}),
    ]);
    await Promise.all([
      writeFile(cursorConfig, `{
  // This entry belongs to the user.
  "mcpServers": {"existing": {"command": "existing-command"}},
}
`),
      writeFile(vscodeConfig, `{
  // Preserve inputs and unrelated servers.
  "inputs": [{"id": "safe", "type": "promptString"}],
  "servers": {"existing": {"command": "existing-command"}},
}
`),
      writeFakeClient(path.join(binaryDirectory, "codex")),
      writeFakeClient(path.join(binaryDirectory, "claude")),
    ]);
    const environment = {
      ...process.env,
      ARTIFACT_SERVER_CURSOR_MCP_CONFIG: cursorConfig,
      ARTIFACT_SERVER_VSCODE_MCP_CONFIG: vscodeConfig,
      FAKE_CLIENT_STATE_DIRECTORY: fakeStateDirectory,
      PATH: binaryDirectory,
    };
    const invocation: CliInvocation = {
      command: "/opt/artifact-server/node",
      prefixArguments: ["/opt/artifact-server/main.js"],
    };

    await connectMcpClient("codex", dataDirectory, invocation, environment);
    await connectMcpClient("claude", dataDirectory, invocation, environment);
    await connectMcpClient("cursor", dataDirectory, invocation, environment);
    await connectMcpClient("vscode", dataDirectory, invocation, environment);

    const connectedCursor = await readFile(cursorConfig, "utf8");
    const connectedVscode = await readFile(vscodeConfig, "utf8");
    expect(connectedCursor).toContain("This entry belongs to the user.");
    expect(connectedCursor).toContain('"existing"');
    expect(connectedCursor).toContain('"artifact-server"');
    expect(connectedVscode).toContain("Preserve inputs and unrelated servers.");
    expect(connectedVscode).toContain('"inputs"');
    expect(connectedVscode).toContain('"artifact-server"');
    expect(connectedVscode).toContain('"type": "stdio"');

    const registrations = await readFile(
      path.join(dataDirectory, "mcp-registrations.json"),
      "utf8",
    );
    const nativeCalls = await readFile(
      path.join(fakeStateDirectory, "calls.log"),
      "utf8",
    );
    expect(nativeCalls).toContain("codex mcp add artifact-server --");
    expect(nativeCalls).toContain(
      "claude mcp add --transport stdio --scope user artifact-server --",
    );
    expect([connectedCursor, connectedVscode, registrations, nativeCalls].join("\n"))
      .not.toMatch(/[A-Za-z0-9_-]{43}/u);

    await expect(disconnectMcpClient("codex", dataDirectory, environment))
      .resolves.toBe(true);
    await expect(disconnectMcpClient("claude", dataDirectory, environment))
      .resolves.toBe(true);
    await expect(disconnectMcpClient("cursor", dataDirectory, environment))
      .resolves.toBe(true);
    await expect(disconnectMcpClient("vscode", dataDirectory, environment))
      .resolves.toBe(true);
    await expect(disconnectMcpClient("vscode", dataDirectory, environment))
      .resolves.toBe(false);

    const disconnectedCursor = await readFile(cursorConfig, "utf8");
    const disconnectedVscode = await readFile(vscodeConfig, "utf8");
    expect(disconnectedCursor).toContain('"existing"');
    expect(disconnectedCursor).not.toContain('"artifact-server"');
    expect(disconnectedVscode).toContain('"existing"');
    expect(disconnectedVscode).toContain('"inputs"');
    expect(disconnectedVscode).not.toContain('"artifact-server"');
  });

  test("MCP-016-B: connect registers every supported client, whose registered command serves tools across a service restart until disconnect", async () => {
    const host = await isolatedClientHost("artifact-server-mcp-016-b-");
    const {dataDirectory, environment, projectDirectory} = host;

    await inSequence(supportedClients, async (client) => {
      const connected = await runCli(
        ["connect", client, "--data", dataDirectory],
        environment,
        projectDirectory,
      );
      expect({exitCode: connected.exitCode, stderr: connected.stderr})
        .toEqual({exitCode: 0, stderr: ""});
      expect(connectOutputSchema.parse(JSON.parse(connected.stdout)))
        .toMatchObject({client});
    });
    const firstService = await readServiceRecord(dataDirectory);
    managedServicePids.add(firstService.pid);

    const registered = await readRegisteredClientCommands(host);
    const ownedRegistrations = registrationStateSchema.parse(JSON.parse(
      await readFile(path.join(dataDirectory, "mcp-registrations.json"), "utf8"),
    )).registrations;
    await inSequence(supportedClients, async (client) => {
      const command = registered[client];
      expect(command.args.slice(-3)).toEqual(["mcp", "--data", dataDirectory]);
      expect(ownedRegistrations.find((item) => item.client === client))
        .toMatchObject({args: command.args, command: command.command});
      const session = await launchRegisteredCommand(command, host);
      expect(session.client.getNegotiatedProtocolVersion()).toBe(modernProtocolRevision);
      expect((await session.client.listTools()).tools.length).toBeGreaterThan(0);
      const calls = await Promise.all(
        ["artifact_capabilities", "project_list", "artifact_list"].map(async (name) => ({
          isError: (await session.client.callTool({arguments: {}, name})).isError === true,
          name,
        })),
      );
      expect(calls.filter((call) => call.isError)).toEqual([]);
      await session.client.close();
    });
    expect((await readServiceRecord(dataDirectory)).pid).toBe(firstService.pid);

    const healthy = await runCli(["doctor", "--data", dataDirectory], environment, projectDirectory);
    expect(healthy.exitCode).toBe(0);
    expect(doctorSchema.parse(JSON.parse(healthy.stdout)).clients).toEqual(
      supportedClients.map((client) => ({
        client,
        installed: true,
        managed: true,
        registration: "matching",
      })),
    );

    await stopManagedService(firstService.pid);
    const afterStop = await runCli(
      ["doctor", "claude", "--data", dataDirectory],
      environment,
      projectDirectory,
    );
    expect(afterStop.exitCode).toBe(2);
    expect(JSON.parse(afterStop.stdout)).toMatchObject({
      service: {reachable: false, recordState: "missing"},
      status: "unhealthy",
    });
    const restarted = await launchRegisteredCommand(registered.claude, host);
    const restartedCapabilities = await restarted.client.callTool({
      arguments: {},
      name: "artifact_capabilities",
    });
    expect(restartedCapabilities.isError).not.toBe(true);
    await restarted.client.close();
    const secondService = await readServiceRecord(dataDirectory);
    managedServicePids.add(secondService.pid);
    expect(secondService.pid).not.toBe(firstService.pid);
    const reconnected = await runCli(
      ["doctor", "claude", "--data", dataDirectory],
      environment,
      projectDirectory,
    );
    expect(reconnected.exitCode).toBe(0);

    await inSequence(supportedClients, async (client) => {
      const disconnected = await runCli(
        ["disconnect", client, "--data", dataDirectory],
        environment,
        projectDirectory,
      );
      expect(disconnected.exitCode).toBe(0);
      expect(JSON.parse(disconnected.stdout)).toEqual({client, status: "disconnected"});
    });
    expect(await readFile(host.cursorConfig, "utf8")).not.toContain("artifact-server");
    expect(await readFile(host.vscodeConfig, "utf8")).not.toContain("artifact-server");
    await expect(stat(path.join(host.fakeStateDirectory, "codex.connected")))
      .rejects.toMatchObject({code: "ENOENT"});
    await expect(stat(path.join(host.fakeStateDirectory, "claude.connected")))
      .rejects.toMatchObject({code: "ENOENT"});
    const afterDisconnect = await runCli(
      ["doctor", "cursor", "--data", dataDirectory],
      environment,
      projectDirectory,
    );
    expect(afterDisconnect.exitCode).toBe(2);
    expect(JSON.parse(afterDisconnect.stdout)).toMatchObject({
      clients: [{client: "cursor", installed: true, managed: false, registration: "none"}],
      remediation: ["artifactserver connect cursor"],
      service: {reachable: true},
      status: "unhealthy",
    });
  }, 180_000);

  test("MCP-016-F: ambiguity asks for a client, stale and corrupt registrations are diagnosed without repair, and no surface exposes the local credential", async () => {
    const host = await isolatedClientHost("artifact-server-mcp-016-f-");
    const {dataDirectory, environment, projectDirectory} = host;
    const outputs: string[] = [];

    const ambiguous = await runCli(["connect", "--data", dataDirectory], environment, projectDirectory);
    outputs.push(ambiguous.stdout, ambiguous.stderr);
    expect(ambiguous.exitCode).not.toBe(0);
    expect(ambiguous.stderr).toContain(
      "More than one supported AI client is installed: codex, claude, cursor, vscode. Run the command again with one client name.",
    );
    await expect(stat(dataDirectory)).rejects.toMatchObject({code: "ENOENT"});
    await expect(stat(host.cursorConfig)).rejects.toMatchObject({code: "ENOENT"});
    await expect(stat(host.vscodeConfig)).rejects.toMatchObject({code: "ENOENT"});
    await expect(stat(path.join(host.fakeStateDirectory, "calls.log")))
      .rejects.toMatchObject({code: "ENOENT"});

    await inSequence(["cursor", "codex"], async (client) => {
      const connected = await runCli(["connect", client, "--data", dataDirectory], environment, projectDirectory);
      outputs.push(connected.stdout, connected.stderr);
      expect(connected.exitCode).toBe(0);
    });
    const service = await readServiceRecord(dataDirectory);
    managedServicePids.add(service.pid);
    const cursorRegistration = cursorConfigurationSchema.parse(JSON.parse(
      await readFile(host.cursorConfig, "utf8"),
    )).mcpServers["artifact-server"];
    const session = await launchRegisteredCommand(cursorRegistration, host);
    expect((await session.client.callTool({arguments: {}, name: "project_list"})).isError)
      .not.toBe(true);
    const bridgeCommand = await readProcessCommand(session.pid);
    await session.client.close();
    const healthy = await runCli(["doctor", "--data", dataDirectory], environment, projectDirectory);
    outputs.push(healthy.stdout, healthy.stderr);
    expect(healthy.exitCode).toBe(0);

    const cursorConnected = await readFile(host.cursorConfig, "utf8");
    await writeFile(host.cursorConfig, "{\n  \"mcpServers\": {}\n}\n");
    const removedEntry = await runCli(["doctor", "cursor", "--data", dataDirectory], environment, projectDirectory);
    outputs.push(removedEntry.stdout, removedEntry.stderr);
    expect(removedEntry.exitCode).toBe(2);
    expect(JSON.parse(removedEntry.stdout)).toMatchObject({
      clients: [{
        client: "cursor",
        managed: true,
        reason: "Cursor no longer has the artifact-server entry that Artifact Server created.",
        registration: "missing",
      }],
      discovery: {status: "healthy"},
      remediation: [
        "artifactserver disconnect cursor",
        "artifactserver connect cursor",
      ],
      status: "unhealthy",
    });
    expect(await readFile(host.cursorConfig, "utf8")).toBe("{\n  \"mcpServers\": {}\n}\n");
    const unscopedDoctor = await runCli(["doctor", "--data", dataDirectory], environment, projectDirectory);
    expect(unscopedDoctor.exitCode).toBe(2);
    await inSequence(["disconnect", "connect"], async (command) => {
      const repaired = await runCli([command, "cursor", "--data", dataDirectory], environment, projectDirectory);
      outputs.push(repaired.stdout, repaired.stderr);
      expect({exitCode: repaired.exitCode, stderr: repaired.stderr}).toEqual({exitCode: 0, stderr: ""});
    });
    expect(await readFile(host.cursorConfig, "utf8")).toContain("\"artifact-server\"");
    const repairedDoctor = await runCli(["doctor", "cursor", "--data", dataDirectory], environment, projectDirectory);
    expect(repairedDoctor.exitCode).toBe(0);

    const movedInstallation = JSON.stringify({
      mcpServers: {
        "artifact-server": {
          args: ["/missing/artifact-server/main.js", "mcp", "--data", dataDirectory],
          command: "/missing/artifact-server/node",
        },
      },
    });
    await writeFile(host.cursorConfig, movedInstallation);
    const changedEntry = await runCli(["doctor", "cursor", "--data", dataDirectory], environment, projectDirectory);
    outputs.push(changedEntry.stdout, changedEntry.stderr);
    expect(changedEntry.exitCode).toBe(2);
    expect(JSON.parse(changedEntry.stdout)).toMatchObject({
      clients: [{
        client: "cursor",
        reason: "Cursor's artifact-server entry changed after Artifact Server created it.",
        registration: "changed",
      }],
      remediation: [
        `Restore or remove the artifact-server entry in ${host.cursorConfig}, then run artifactserver disconnect cursor and artifactserver connect cursor.`,
      ],
      status: "unhealthy",
    });
    const refusedOverwrite = await runCli(["connect", "cursor", "--data", dataDirectory], environment, projectDirectory);
    outputs.push(refusedOverwrite.stdout, refusedOverwrite.stderr);
    expect(refusedOverwrite.exitCode).not.toBe(0);
    expect(await readFile(host.cursorConfig, "utf8")).toBe(movedInstallation);
    await writeFile(host.cursorConfig, cursorConnected);

    await rm(path.join(host.fakeStateDirectory, "codex.connected"));
    const nativeRemoved = await runCli(["doctor", "codex", "--data", dataDirectory], environment, projectDirectory);
    outputs.push(nativeRemoved.stdout, nativeRemoved.stderr);
    expect(nativeRemoved.exitCode).toBe(2);
    expect(JSON.parse(nativeRemoved.stdout)).toMatchObject({
      clients: [{client: "codex", registration: "missing"}],
      status: "unhealthy",
    });
    await expect(stat(path.join(host.fakeStateDirectory, "codex.connected")))
      .rejects.toMatchObject({code: "ENOENT"});
    const forgotten = await runCli(["disconnect", "codex", "--data", dataDirectory], environment, projectDirectory);
    outputs.push(forgotten.stdout, forgotten.stderr);
    expect(forgotten.exitCode).toBe(0);
    expect(JSON.parse(forgotten.stdout)).toEqual({client: "codex", status: "disconnected"});

    const registrationPath = path.join(dataDirectory, "mcp-registrations.json");
    const corruptRegistration = "{\"registrations\": [{\"client\": \"cursor\"";
    await writeFile(registrationPath, corruptRegistration);
    const corrupt = await runCli(["doctor", "--data", dataDirectory], environment, projectDirectory);
    outputs.push(corrupt.stdout, corrupt.stderr);
    expect(corrupt.exitCode).toBe(2);
    expect(JSON.parse(corrupt.stdout)).toMatchObject({
      registrations: {
        path: registrationPath,
        reason: "The Artifact Server MCP registration record is not valid JSON.",
        state: "invalid",
      },
      remediation: [
        `Restore ${registrationPath} from a backup, or remove it together with the artifact-server entries it managed, then run artifactserver connect.`,
      ],
      status: "unhealthy",
    });
    expect(corrupt.stderr).toBe("");
    const cursorBeforeRefusal = await readFile(host.cursorConfig, "utf8");
    const refusedOverCorruptRecord = await runCli(
      ["connect", "vscode", "--data", dataDirectory],
      environment,
      projectDirectory,
    );
    outputs.push(refusedOverCorruptRecord.stdout, refusedOverCorruptRecord.stderr);
    expect(refusedOverCorruptRecord.exitCode).not.toBe(0);
    await expect(stat(host.vscodeConfig)).rejects.toMatchObject({code: "ENOENT"});
    expect(await readFile(host.cursorConfig, "utf8")).toBe(cursorBeforeRefusal);
    expect(await readFile(registrationPath, "utf8")).toBe(corruptRegistration);

    const apiCredential = (await readFile(path.join(dataDirectory, "local-api-token"), "utf8")).trim();
    const browserCredential = (await readFile(path.join(dataDirectory, "local-browser-token"), "utf8")).trim();
    expect(apiCredential.length).toBeGreaterThanOrEqual(32);
    const supportManifest = await runCli(
      ["support", "manifest", "--data", dataDirectory],
      environment,
      projectDirectory,
    );
    outputs.push(supportManifest.stdout, supportManifest.stderr);
    expect(supportManifest.stdout.length + supportManifest.stderr.length).toBeGreaterThan(0);
    const projectFiles = await readTree(projectDirectory);
    expect(projectFiles).toEqual([]);
    const surfaces = [
      ...outputs,
      session.stderr(),
      bridgeCommand,
      await readProcessCommand(service.pid),
      await readFile(host.cursorConfig, "utf8"),
      await readFile(path.join(host.fakeStateDirectory, "calls.log"), "utf8"),
      await readFile(path.join(dataDirectory, "local-service.json"), "utf8"),
      await readFile(path.join(dataDirectory, "local-service.log"), "utf8"),
      ...(await readTree(host.homeDirectory)).map((file) => file.contents),
    ].join("\n");
    expect(surfaces).not.toContain(apiCredential);
    expect(surfaces).not.toContain(browserCredential);
    expect(bridgeCommand).toContain(" mcp --data ");
  }, 180_000);

  test("foundation: native inspection failures stop before client mutation", async () => {
    const workspace = await temporaryWorkspace("artifact-server-mcp-inspection-");
    const dataDirectory = path.join(workspace, "data");
    const binaryDirectory = path.join(workspace, "bin");
    await mkdir(binaryDirectory, {recursive: true});
    await writeFakeClient(path.join(binaryDirectory, "codex"));
    const environment = {
      ...process.env,
      FAKE_CLIENT_GET_ERROR: "1",
      FAKE_CLIENT_STATE_DIRECTORY: workspace,
      PATH: binaryDirectory,
    };
    const invocation: CliInvocation = {
      command: "/opt/artifact-server/node",
      prefixArguments: ["/opt/artifact-server/main.js"],
    };

    await expect(
      connectMcpClient("codex", dataDirectory, invocation, environment),
    ).rejects.toThrow("permission denied while reading client configuration");
    expect(await readFile(path.join(workspace, "calls.log"), "utf8"))
      .toBe("codex mcp get artifact-server --json\n");
  });

  test("MCP-020-B: resumes a journaled native-client change after process interruption", async () => {
    const workspace = await temporaryWorkspace("artifact-server-mcp-resume-");
    const dataDirectory = path.join(workspace, "data");
    const binaryDirectory = path.join(workspace, "bin");
    const fakeStateDirectory = path.join(workspace, "fake-client-state");
    await Promise.all([
      mkdir(binaryDirectory, {recursive: true}),
      mkdir(fakeStateDirectory, {recursive: true}),
    ]);
    await writeFakeClient(path.join(binaryDirectory, "codex"));
    const environment = {
      ...process.env,
      FAKE_CLIENT_PAUSE_AFTER_ADD: "1",
      FAKE_CLIENT_STATE_DIRECTORY: fakeStateDirectory,
      PATH: binaryDirectory,
    };
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      connectFixture,
      "codex",
      dataDirectory,
    ], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const clientState = path.join(fakeStateDirectory, "codex.connected");
    const journal = path.join(dataDirectory, "mcp-onboarding-transaction.json");
    await Promise.all([waitForFile(clientState), waitForFile(journal)]);
    expect((await stat(journal)).mode & 0o777).toBe(0o600);
    await killProcess(child);

    const recoveryEnvironment: NodeJS.ProcessEnv = {...environment};
    delete recoveryEnvironment["FAKE_CLIENT_PAUSE_AFTER_ADD"];
    await connectMcpClient(
      "codex",
      dataDirectory,
      {
        command: "/opt/artifact-server/node",
        prefixArguments: ["/opt/artifact-server/main.js"],
      },
      recoveryEnvironment,
    );
    const registrations = registrationFileSchema.parse(JSON.parse(await readFile(
      path.join(dataDirectory, "mcp-registrations.json"),
      "utf8",
    )));
    expect(registrations.registrations).toMatchObject([{client: "codex"}]);
    await expect(stat(journal)).rejects.toMatchObject({code: "ENOENT"});
  });

  test("MCP-020-F: rolls back failed mutation and preserves an independent interrupted change", async () => {
    const workspace = await temporaryWorkspace("artifact-server-mcp-rollback-");
    const dataDirectory = path.join(workspace, "data");
    const conflictDataDirectory = path.join(workspace, "conflict-data");
    const binaryDirectory = path.join(workspace, "bin");
    const fakeStateDirectory = path.join(workspace, "fake-client-state");
    await Promise.all([
      mkdir(binaryDirectory, {recursive: true}),
      mkdir(fakeStateDirectory, {recursive: true}),
    ]);
    await writeFakeClient(path.join(binaryDirectory, "codex"));
    const invocation: CliInvocation = {
      command: "/opt/artifact-server/node",
      prefixArguments: ["/opt/artifact-server/main.js"],
    };
    const baseEnvironment = {
      ...process.env,
      FAKE_CLIENT_STATE_DIRECTORY: fakeStateDirectory,
      PATH: binaryDirectory,
    };

    await expect(connectMcpClient("codex", dataDirectory, invocation, {
      ...baseEnvironment,
      FAKE_CLIENT_FAIL_AFTER_ADD: "1",
    })).rejects.toThrow("Could not add Artifact Server to Codex");
    await expect(stat(path.join(fakeStateDirectory, "codex.connected")))
      .rejects.toMatchObject({code: "ENOENT"});
    await expect(stat(path.join(dataDirectory, "mcp-onboarding-transaction.json")))
      .rejects.toMatchObject({code: "ENOENT"});
    await expect(stat(path.join(dataDirectory, "mcp-registrations.json")))
      .rejects.toMatchObject({code: "ENOENT"});

    const interruptedEnvironment = {
      ...baseEnvironment,
      FAKE_CLIENT_PAUSE_AFTER_ADD: "1",
    };
    const child = spawn(
      process.execPath,
      ["--import", "tsx", connectFixture, "codex", conflictDataDirectory],
      {
        cwd: repositoryRoot,
        env: interruptedEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const clientState = path.join(fakeStateDirectory, "codex.connected");
    const journal = path.join(
      conflictDataDirectory,
      "mcp-onboarding-transaction.json",
    );
    await Promise.all([waitForFile(clientState), waitForFile(journal)]);
    await killProcess(child);
    const independentlyChangedState = `${await readFile(clientState, "utf8")}  EXTRA=value\n`;
    await writeFile(clientState, independentlyChangedState);

    await expect(connectMcpClient(
      "codex",
      conflictDataDirectory,
      invocation,
      baseEnvironment,
    )).rejects.toThrow("changed independently");
    expect(await readFile(clientState, "utf8")).toBe(independentlyChangedState);
    expect((await stat(journal)).mode & 0o777).toBe(0o600);
  });

  test("refuses foreign and malformed JSON client configuration", async () => {
    const workspace = await temporaryWorkspace("artifact-server-mcp-conflict-");
    const dataDirectory = path.join(workspace, "data");
    const cursorConfig = path.join(workspace, "cursor.json");
    const vscodeConfig = path.join(workspace, "vscode.json");
    const invocation: CliInvocation = {
      command: "/opt/artifact-server/node",
      prefixArguments: ["/opt/artifact-server/main.js"],
    };
    await writeFile(cursorConfig, JSON.stringify({
      mcpServers: {"artifact-server": {command: "foreign"}},
    }));
    await writeFile(vscodeConfig, "{not valid JSONC");

    await expect(connectMcpClient("cursor", dataDirectory, invocation, {
      ...process.env,
      ARTIFACT_SERVER_CURSOR_MCP_CONFIG: cursorConfig,
    })).rejects.toThrow("unmanaged artifact-server entry");
    await expect(connectMcpClient("vscode", dataDirectory, invocation, {
      ...process.env,
      ARTIFACT_SERVER_VSCODE_MCP_CONFIG: vscodeConfig,
    })).rejects.toThrow("malformed MCP configuration");
    expect(await readFile(cursorConfig, "utf8")).toContain('"foreign"');
    expect(await readFile(vscodeConfig, "utf8")).toBe("{not valid JSONC");
  });

  test("ambiguous connect and doctor failures do not create or repair state", async () => {
    const workspace = await temporaryWorkspace("artifact-server-mcp-diagnostics-");
    const binaryDirectory = path.join(workspace, "bin");
    const missingDataDirectory = path.join(workspace, "missing-data");
    await mkdir(binaryDirectory, {recursive: true});
    await Promise.all([
      writeFakeClient(path.join(binaryDirectory, "codex")),
      writeFakeClient(path.join(binaryDirectory, "claude")),
    ]);
    const environment = {
      ...process.env,
      FAKE_CLIENT_STATE_DIRECTORY: workspace,
      PATH: [
        binaryDirectory,
        path.dirname(process.execPath),
        "/usr/bin",
        "/bin",
      ].join(path.delimiter),
    };
    const ambiguous = await runCli(
      ["connect", "--data", missingDataDirectory],
      environment,
    );
    expect(ambiguous.exitCode).not.toBe(0);
    expect(ambiguous.stderr).toContain("codex, claude");
    await expect(stat(missingDataDirectory)).rejects.toMatchObject({code: "ENOENT"});

    const invalidClient = await runCli(
      ["doctor", "invalid-client", "--data", missingDataDirectory],
      environment,
    );
    expect(invalidClient.exitCode).not.toBe(0);
    expect(invalidClient.stderr).toContain(
      "Unsupported AI client \"invalid-client\". Choose codex, claude, cursor, or vscode.",
    );
    expect(invalidClient.stderr).not.toContain("ZodError");
    expect(invalidClient.stderr).not.toContain("src/cli/");
    expect(invalidClient.stderr).not.toContain("\n    at ");
    expect(invalidClient.stderr).not.toContain("Node.js v");
    await expect(stat(missingDataDirectory)).rejects.toMatchObject({code: "ENOENT"});

    const missingDoctor = await runCli(
      ["doctor", "codex", "--data", missingDataDirectory],
      environment,
    );
    expect(missingDoctor.exitCode).toBe(2);
    expect(JSON.parse(missingDoctor.stdout)).toMatchObject({
      service: {reachable: false, recordState: "missing"},
      status: "unhealthy",
    });
    await expect(stat(missingDataDirectory)).rejects.toMatchObject({code: "ENOENT"});

    const staleDataDirectory = path.join(workspace, "stale-data");
    await mkdir(staleDataDirectory, {recursive: true});
    const staleRecord = `${JSON.stringify({
      dataDirectory: staleDataDirectory,
      origin: "http://localhost:1",
      pid: 999_999,
      productVersion: "0.0.0",
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`;
    const staleRecordPath = path.join(staleDataDirectory, "local-service.json");
    await writeFile(staleRecordPath, staleRecord);
    const staleDoctor = await runCli(
      ["doctor", "codex", "--data", staleDataDirectory],
      environment,
    );
    expect(staleDoctor.exitCode).toBe(2);
    expect(JSON.parse(staleDoctor.stdout)).toMatchObject({
      service: {reachable: false, recordState: "stale"},
      status: "unhealthy",
    });
    expect(await readFile(staleRecordPath, "utf8")).toBe(staleRecord);

    const runningUnhealthyRecord = `${JSON.stringify({
      dataDirectory: staleDataDirectory,
      origin: "http://127.0.0.1:1",
      pid: process.pid,
      productVersion: "0.0.0",
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`;
    await writeFile(staleRecordPath, runningUnhealthyRecord);
    const refused = await runCli(
      ["connect", "codex", "--data", staleDataDirectory],
      environment,
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("a second process was not started against the same database");
    expect(await readFile(staleRecordPath, "utf8")).toBe(runningUnhealthyRecord);
  });
});

async function connectStdio(
  dataDirectory: string,
  protocolEra: "legacy" | "modern" = "modern",
): Promise<{readonly client: Client}> {
  const transport = new StdioClientTransport({
    args: [cliEntrypoint, "mcp", "--data", dataDirectory],
    command: tsxExecutable,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client(
    {name: "artifact-server-test-client", version: "0.0.0"},
    {
      versionNegotiation: protocolEra === "modern"
        ? {mode: {pin: modernProtocolRevision}}
        : {mode: "legacy"},
    },
  );
  await client.connect(transport);
  return {client};
}

function runCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = repositoryRoot,
): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxExecutable, [cliEntrypoint, ...arguments_], {
      cwd: workingDirectory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
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
  });
}

function readProcessCommand(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ps", ["-p", String(pid), "-o", "command="], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(`ps failed: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

async function writeFakeClient(target: string): Promise<void> {
  const name = path.basename(target);
  await writeFile(target, `#!/bin/sh
set -eu
state="$FAKE_CLIENT_STATE_DIRECTORY/${name}.connected"
printf '%s %s\\n' '${name}' "$*" >> "$FAKE_CLIENT_STATE_DIRECTORY/calls.log"
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then
  if [ -f "$state" ]; then
    /bin/cat "$state"
    exit 0
  fi
  if [ "\${FAKE_CLIENT_GET_ERROR:-}" = "1" ]; then
    printf 'permission denied while reading client configuration\n' >&2
    exit 7
  fi
  if [ '${name}' = "codex" ]; then
    printf "Error: No MCP server named 'artifact-server' found.\n" >&2
  else
    printf 'No MCP server named "artifact-server".\n' >&2
  fi
  exit 1
fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  if [ '${name}' = "codex" ]; then
    shift 4
  else
    shift 8
  fi
  command="$1"
  shift
  printf 'Type: stdio\\nCommand: %s\\nArgs: %s\\nEnvironment:\\n' \
    "$command" "$*" > "$state"
  if [ "\${FAKE_CLIENT_FAIL_AFTER_ADD:-}" = "1" ]; then
    exit 9
  fi
  if [ "\${FAKE_CLIENT_PAUSE_AFTER_ADD:-}" = "1" ]; then
    /bin/sleep 30
  fi
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "remove" ]; then
  /bin/rm -f "$state"
  exit 0
fi
exit 2
`, {mode: 0o700});
  await chmod(target, 0o700);
}

async function temporaryWorkspace(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

async function waitForFile(filePath: string): Promise<void> {
  return waitForFileUntil(
    filePath,
    Date.now() + processStartupTimeoutMilliseconds,
  );
}

async function waitForFileUntil(filePath: string, deadline: number): Promise<void> {
  try {
    await stat(filePath);
    return;
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (!parsed.success || parsed.data.code !== "ENOENT") throw error;
  }
  if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}.`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return waitForFileUntil(filePath, deadline);
}

function killProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

interface IsolatedClientHost {
  readonly cursorConfig: string;
  readonly dataDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly fakeStateDirectory: string;
  readonly homeDirectory: string;
  readonly projectDirectory: string;
  readonly vscodeConfig: string;
}

type RegisteredCommand = z.infer<typeof registeredCommandSchema>;

/**
 * Build a clean user account with all four supported clients installed.
 *
 * Codex and Claude Code are executables that implement their native
 * `mcp get/add/remove` commands; Cursor and VS Code are discovered on PATH and
 * configured through their default user files under the isolated HOME. No
 * Artifact Server credential is placed in the environment.
 */
async function isolatedClientHost(prefix: string): Promise<IsolatedClientHost> {
  const workspace = await temporaryWorkspace(prefix);
  const homeDirectory = path.join(workspace, "home");
  const binaryDirectory = path.join(workspace, "bin");
  const fakeStateDirectory = path.join(workspace, "fake-client-state");
  const projectDirectory = path.join(workspace, "project");
  await Promise.all([
    mkdir(homeDirectory, {recursive: true}),
    mkdir(binaryDirectory, {recursive: true}),
    mkdir(fakeStateDirectory, {recursive: true}),
    mkdir(projectDirectory, {recursive: true}),
  ]);
  await Promise.all([
    writeFakeClient(path.join(binaryDirectory, "codex")),
    writeFakeClient(path.join(binaryDirectory, "claude")),
    writePresentExecutable(path.join(binaryDirectory, "cursor")),
    writePresentExecutable(path.join(binaryDirectory, "code")),
  ]);
  const environment: NodeJS.ProcessEnv = {
    FAKE_CLIENT_STATE_DIRECTORY: fakeStateDirectory,
    HOME: homeDirectory,
    PATH: [binaryDirectory, path.dirname(process.execPath), "/usr/bin", "/bin"]
      .join(path.delimiter),
    TMPDIR: tmpdir(),
  };
  return {
    cursorConfig: path.join(homeDirectory, ".cursor", "mcp.json"),
    dataDirectory: path.join(workspace, "data"),
    environment,
    fakeStateDirectory,
    homeDirectory,
    projectDirectory,
    vscodeConfig: process.platform === "darwin"
      ? path.join(homeDirectory, "Library", "Application Support", "Code", "User", "mcp.json")
      : path.join(homeDirectory, ".config", "Code", "User", "mcp.json"),
  };
}

async function writePresentExecutable(target: string): Promise<void> {
  await writeFile(target, "#!/bin/sh\nexit 0\n", {mode: 0o700});
  await chmod(target, 0o700);
}

/** Read each client's own record of the server it will launch. */
async function readRegisteredClientCommands(
  host: IsolatedClientHost,
): Promise<Record<SupportedClient, RegisteredCommand>> {
  const cursor = cursorConfigurationSchema.parse(JSON.parse(
    await readFile(host.cursorConfig, "utf8"),
  )).mcpServers["artifact-server"];
  const vscode = vscodeConfigurationSchema.parse(JSON.parse(
    await readFile(host.vscodeConfig, "utf8"),
  )).servers["artifact-server"];
  return {
    claude: await readNativeRegistration(host, "claude"),
    codex: await readNativeRegistration(host, "codex"),
    cursor: {args: cursor.args, command: cursor.command},
    vscode: {args: vscode.args, command: vscode.command},
  };
}

async function readNativeRegistration(
  host: IsolatedClientHost,
  client: "claude" | "codex",
): Promise<RegisteredCommand> {
  const lines = (await readFile(
    path.join(host.fakeStateDirectory, `${client}.connected`),
    "utf8",
  )).split("\n");
  const value = (label: string): string => {
    const line = lines.find((candidate) => candidate.startsWith(`${label}: `));
    if (line === undefined) throw new Error(`${client} has no ${label} line.`);
    return line.slice(label.length + 2);
  };
  expect(value("Type")).toBe("stdio");
  expect(lines).toContain("Environment:");
  return {args: value("Args").split(" "), command: value("Command")};
}

/** Launch a registered stdio server the way an AI client does. */
async function launchRegisteredCommand(
  registered: RegisteredCommand,
  host: IsolatedClientHost,
): Promise<{readonly client: Client; readonly pid: number; stderr(): string}> {
  const clientEnvironment = {
    HOME: host.homeDirectory,
    PATH: host.environment["PATH"] ?? "",
    TMPDIR: tmpdir(),
  };
  const transport = new StdioClientTransport({
    args: [...registered.args],
    command: registered.command,
    cwd: host.projectDirectory,
    env: clientEnvironment,
    stderr: "pipe",
  });
  const stderr: Uint8Array[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const client = new Client(
    {name: "artifact-server-registered-client", version: "0.0.0"},
    {versionNegotiation: {mode: {pin: modernProtocolRevision}}},
  );
  await client.connect(transport);
  const pid = transport.pid;
  if (pid === null) throw new Error("The registered MCP command did not start.");
  return {client, pid, stderr: () => Buffer.concat(stderr).toString("utf8")};
}

async function readServiceRecord(
  dataDirectory: string,
): Promise<z.infer<typeof serviceRecordSchema>> {
  return serviceRecordSchema.parse(JSON.parse(await readFile(
    path.join(dataDirectory, "local-service.json"),
    "utf8",
  )));
}

async function stopManagedService(pid: number): Promise<void> {
  process.kill(pid, "SIGTERM");
  await waitForProcessExit(pid, Date.now() + processStartupTimeoutMilliseconds);
  managedServicePids.delete(pid);
}

async function waitForProcessExit(pid: number, deadline: number): Promise<void> {
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  if (Date.now() >= deadline) throw new Error(`Process ${pid} did not stop.`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitForProcessExit(pid, deadline);
}

/** Run one step at a time: onboarding commands share one journal per installation. */
async function inSequence<Item>(
  items: readonly Item[],
  step: (item: Item) => Promise<void>,
): Promise<void> {
  await items.reduce<Promise<void>>(
    (previous, item) => previous.then(() => step(item)),
    Promise.resolve(),
  );
}

async function readTree(
  directory: string,
): Promise<readonly {readonly contents: string; readonly path: string}[]> {
  const entries = await readdir(directory, {recursive: true, withFileTypes: true});
  return Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(entry.parentPath, entry.name);
    return {contents: await readFile(filePath, "utf8"), path: filePath};
  }));
}
