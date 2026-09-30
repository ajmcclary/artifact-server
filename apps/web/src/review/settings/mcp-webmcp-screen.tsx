import {useId, useState, type CSSProperties} from "react";

import {
  Alert,
  AutoGrid,
  Button,
  CodeBlock,
  PageScaffold,
  SectionHeading,
  Switch,
  Tag,
} from "@/arkcase";
import {useAnnounce} from "@/ui/announcer";
import {copyText} from "@/ui/copy";
import {setWebmcpEnabled, webmcpEnabled} from "../webmcp.tsx";
import {AdminActions, AdminNote, AdminPanel, AdminStack, useDsDensity} from "./admin-parts.tsx";

const supportedClients = ["codex", "claude", "cursor", "vscode"] as const;

export interface McpWebmcpScreenProps {
  readonly administrator: boolean;
}

/** One screen for connecting external agents over MCP and for the browser-agent (WebMCP) preference. */
export function McpWebmcpScreen({administrator}: McpWebmcpScreenProps) {
  const announce = useAnnounce();
  const density = useDsDensity();
  const [failure, setFailure] = useState<string | null>(null);
  const mcpAddress = `${window.location.origin}/mcp`;

  const copy = async (value: string, confirmation: string): Promise<void> => {
    setFailure(null);
    if (await copyText(value)) {
      announce(confirmation);
      return;
    }
    setFailure("Unable to copy. Select the value and copy it manually.");
  };
  const onCopy = (value: string, confirmation: string): void => {
    void copy(value, confirmation);
  };

  return (
    <PageScaffold
      meta="Give AI clients authenticated access to projects, artifacts, versions, and comments. Choose the setup that matches where Artifact Server runs."
      title="MCP & WebMCP"
    >
      {failure === null ? null : (
        <Alert density={density} live="assertive" variant="danger">{failure}</Alert>
      )}
      <AutoGrid cellMinWidth0 min={280}>
        <AdminPanel label="Local installation" subtitle="server and client on one computer">
          <AdminStack>
            <SectionHeading level={3} size="sm" title="Connect automatically" />
            <AdminNote>
              Run this on the computer where Artifact Server and your AI client are installed. It
              detects Codex, Claude Code, Cursor, or VS Code, updates the client configuration, and
              verifies the connection.
            </AdminNote>
            <CommandWell
              confirmation="Local connection command copied"
              label="Copy local connection command"
              onCopy={onCopy}
              value="artifactserver connect"
            />
            <AdminNote>If more than one supported client is installed, add its name:</AdminNote>
            <AdminActions>
              {supportedClients.map((client) => <Tag key={client}>{client}</Tag>)}
            </AdminActions>
          </AdminStack>
        </AdminPanel>
        <AdminPanel label="Team or remote server" subtitle="one endpoint, browser sign-in">
          <AdminStack>
            <SectionHeading level={3} size="sm" title="Connect with the server address" />
            <AdminNote>
              Add this exact address in your client’s MCP settings. The client should open browser
              sign-in when it connects.
            </AdminNote>
            <CommandWell
              confirmation="MCP server address copied"
              label="Copy MCP server address"
              onCopy={onCopy}
              value={mcpAddress}
            />
            <AdminNote>
              If the client cannot use browser authentication, ask an administrator for a scoped
              API key. Never paste a key into chat.
            </AdminNote>
            {administrator ? (
              <AdminActions>
                <Button href="/review/settings/api-keys" icon="bi-key" outline size="sm" variant="secondary">
                  Manage API keys
                </Button>
              </AdminActions>
            ) : null}
          </AdminStack>
        </AdminPanel>
      </AutoGrid>

      <AdminPanel label="Check the connection">
        <AdminStack>
          <AdminNote>Inspect the managed service and client registration without changing either one.</AdminNote>
          <CommandWell
            confirmation="Connection check command copied"
            label="Copy connection check command"
            onCopy={onCopy}
            value="artifactserver doctor"
          />
          <AdminNote>
            To remove a managed local connection, run{" "}
            <code style={inlineCodeStyle}>artifactserver disconnect</code>.
          </AdminNote>
        </AdminStack>
      </AdminPanel>

      <AdminPanel label="Artifact Server skill" subtitle="optional">
        <AdminStack>
          <SectionHeading level={3} size="sm" title="Give agents the Artifact Server skill" />
          <AdminNote>
            The optional skill teaches an agent to use MCP for server data and the CLI for files on
            its computer. Artifact bytes are never copied into MCP tool arguments.
          </AdminNote>
          <CommandWell
            confirmation="Skill installation command copied"
            label="Copy skill installation command"
            onCopy={onCopy}
            value="npx skills add plannotator/artifact-server"
          />
        </AdminStack>
      </AdminPanel>

      <WebmcpPreference />
    </PageScaffold>
  );
}

function CommandWell({
  confirmation,
  label,
  onCopy,
  value,
}: {
  readonly confirmation: string;
  readonly label: string;
  readonly onCopy: (value: string, confirmation: string) => void;
  readonly value: string;
}) {
  return (
    <CodeBlock
      copy={{copiedLabel: confirmation, label, onCopy: () => onCopy(value, confirmation)}}
      tone="navy"
    >
      {value}
    </CodeBlock>
  );
}

/** The per-browser WebMCP preference; storage key and change event stay in webmcp.tsx. */
function WebmcpPreference() {
  const descriptionId = useId();
  const [enabled, setEnabled] = useState(webmcpEnabled);
  return (
    <AdminPanel label="WebMCP" subtitle="browser-provided review tools">
      <AdminStack>
        <Switch
          aria-describedby={descriptionId}
          checked={enabled}
          label="Browser agent tools"
          onChange={(event) => {
            setEnabled(event.currentTarget.checked);
            setWebmcpEnabled(event.currentTarget.checked);
          }}
        />
        <AdminNote id={descriptionId}>
          Let a browser-resident AI agent operate Review through WebMCP tools in this session.
          Dispatching to coding agents stays a human action.
        </AdminNote>
        <AdminNote>
          This preference applies to this browser profile. It does not change MCP connections in
          Codex, Claude Code, Cursor, VS Code, or other clients.
        </AdminNote>
      </AdminStack>
    </AdminPanel>
  );
}

const inlineCodeStyle: CSSProperties = {
  fontFamily: "var(--font-data, monospace)",
  fontSize: "0.95em",
};
