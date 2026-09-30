import {useId, useState, type CSSProperties} from "react";

import type {AccessSetting, ArtifactDetails, ArtifactVersion} from "@/api/client";
import {
  Alert,
  Button,
  Checkbox,
  CodeBlock,
  IconButton,
  Popover,
} from "@/arkcase";
import {useThemeMode} from "@/theme/use-theme-mode";
import {copyText} from "@/ui/copy";
import {CopyAction} from "@/ui/copy-action";
import {ArtifactLinks} from "@/ui/review-ui";

import claudeLogoUrl from "../assets/agents/claude.svg";
import codexDarkLogoUrl from "../assets/agents/codex-dark.svg";
import codexLightLogoUrl from "../assets/agents/codex-light.svg";
import copilotDarkLogoUrl from "../assets/agents/copilot-dark.svg";
import copilotLightLogoUrl from "../assets/agents/copilot-light.svg";
import cursorDarkLogoUrl from "../assets/agents/cursor-dark.svg";
import cursorLightLogoUrl from "../assets/agents/cursor-light.svg";
import opencodeDarkLogoUrl from "../assets/agents/opencode-dark.svg";
import opencodeLightLogoUrl from "../assets/agents/opencode-light.svg";
import piLogoUrl from "../assets/agents/pi.svg";
import piLightLogoUrl from "../assets/agents/pi-light.svg";
import {accessChangeWarning, changeArtifactAccess} from "./artifact-access.ts";

type ShareScreen = "access" | "agents" | "overview";

export interface SharePopoverProps {
  readonly details: ArtifactDetails | null;
  readonly onArtifactChanged: (artifact: ArtifactDetails["artifact"]) => void;
  readonly selectedPath: string | null;
  readonly selectedVersion: ArtifactVersion | null;
}

const agentLogos = [
  {dark: claudeLogoUrl, light: claudeLogoUrl, name: "claude"},
  {dark: codexDarkLogoUrl, light: codexLightLogoUrl, name: "codex"},
  {dark: cursorDarkLogoUrl, light: cursorLightLogoUrl, name: "cursor"},
  {dark: copilotDarkLogoUrl, light: copilotLightLogoUrl, name: "copilot"},
  {dark: piLogoUrl, light: piLightLogoUrl, name: "pi"},
  {dark: opencodeDarkLogoUrl, light: opencodeLightLogoUrl, name: "opencode"},
] as const;

const contentStyle = {gap: 12, maxHeight: "75vh", overflowY: "auto", padding: 12} satisfies CSSProperties;
const headerStyle = {alignItems: "flex-start", display: "flex", gap: 8} satisfies CSSProperties;
const headerTextStyle = {flex: "1 1 auto", minWidth: 0} satisfies CSSProperties;
const headingStyle = {fontSize: "var(--font-size-md, 16px)", margin: 0, overflowWrap: "anywhere"} satisfies CSSProperties;
const subtleStyle = {color: "var(--text-secondary)", fontSize: "var(--font-size-xs, 12px)", margin: 0} satisfies CSSProperties;
const sectionStyle = {display: "flex", flexDirection: "column", gap: 8} satisfies CSSProperties;
const sectionHeadingStyle = {fontSize: "var(--font-size-sm, 14px)", margin: 0} satisfies CSSProperties;
const linkStyle = {
  color: "var(--text-link)",
  fontFamily: "var(--font-data)",
  fontSize: 12,
  overflowWrap: "anywhere",
} satisfies CSSProperties;
const rowStyle = {alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8} satisfies CSSProperties;
const logosStyle = {alignItems: "center", display: "inline-flex", gap: 4} satisfies CSSProperties;
const logoStyle = {height: 18, width: 18} satisfies CSSProperties;
const fieldsetStyle = {border: 0, display: "flex", flexDirection: "column", gap: 10, margin: 0, padding: 0} satisfies CSSProperties;
const visuallyHiddenStyle = {
  border: 0,
  clip: "rect(0 0 0 0)",
  height: 1,
  margin: -1,
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  whiteSpace: "nowrap",
  width: 1,
} satisfies CSSProperties;

/** Share one exact version from the review toolbar or the focus controls. */
export function SharePopover({
  details,
  onArtifactChanged,
  selectedPath,
  selectedVersion,
}: SharePopoverProps) {
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<ShareScreen>("overview");
  const [selectedAccess, setSelectedAccess] = useState<AccessSetting>(
    details?.artifact.accessSetting ?? "account_required",
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const headingId = useId();

  const updateOpen = (next: boolean): void => {
    if (pending && !next) return;
    setOpen(next);
    if (next) {
      setScreen("overview");
      setFailure(null);
    }
  };

  const reviewLink = selectedVersion === null ? null : exactReviewLink(selectedVersion, selectedPath);

  const openAccess = (): void => {
    if (details === null) return;
    setSelectedAccess(details.artifact.accessSetting);
    setFailure(null);
    setNotice(null);
    setScreen("access");
  };

  const saveAccess = async (): Promise<void> => {
    if (details === null) return;
    if (selectedAccess === details.artifact.accessSetting) {
      setScreen("overview");
      return;
    }
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const changed = await changeArtifactAccess(details, selectedAccess);
      onArtifactChanged(changed.artifact);
      setNotice(changed.notice);
      setScreen("overview");
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "Artifact access could not be changed.");
    } finally {
      setPending(false);
    }
  };

  const publicArtifact = details?.artifact.accessSetting === "public_link";
  const serverOrigin = details === null ? "" : new URL(details.links.artifact).origin;
  const mcpAddress = `${serverOrigin}/mcp`;
  const title = screen === "overview"
    ? details?.artifact.name ?? "Artifact"
    : screen === "access" ? "Artifact access" : "Connect MCP";
  const subtitle = screen === "overview"
    ? `Exact version · Version ${selectedVersion?.version.number ?? "—"}`
    : details?.artifact.name ?? "No artifact selected";

  return (
    <Popover
      contentStyle={contentStyle}
      label="Share artifact"
      onOpenChange={updateOpen}
      open={open}
      placement="bottom-end"
      trigger={(
        <Button
          aria-label="Share"
          disabled={details === null || selectedVersion === null}
          icon="bi-share"
          outline
          size="sm"
          variant="secondary"
        >
          Share
        </Button>
      )}
      width={380}
      zIndex={1200}
    >
      <header style={headerStyle}>
        {screen === "overview" ? null : (
          <IconButton
            ariaLabel="Back to Share"
            disabled={pending}
            icon="bi-chevron-left"
            onClick={() => setScreen("overview")}
            size="sm"
          />
        )}
        <div style={headerTextStyle}>
          <h2 style={headingStyle}>{title}</h2>
          <p style={subtleStyle}>{subtitle}</p>
        </div>
        <IconButton
          ariaLabel="Close Share"
          disabled={pending}
          icon="bi-x-lg"
          onClick={() => updateOpen(false)}
          size="sm"
        />
      </header>

      {screen === "overview" ? (
        <>
          <section aria-labelledby={`${headingId}-review`} style={sectionStyle}>
            <h3 id={`${headingId}-review`} style={sectionHeadingStyle}>Review and comment</h3>
            <code style={linkStyle}>{reviewLink ?? ""}</code>
            {reviewLink === null ? null : (
              <CopyAction copiedLabel="Copied" label="Copy Review link" text={reviewLink} variant="outline">
                Copy Review link
              </CopyAction>
            )}
          </section>
          <section style={sectionStyle}>
            <p style={subtleStyle}>
              People with access to this Artifact Server can review this exact version.
              {publicArtifact ? " The latest raw artifact is public." : ""}
            </p>
            <div style={rowStyle}>
              <Button disabled={details === null} onClick={openAccess} outline size="sm" variant="secondary">
                Manage access
              </Button>
            </div>
          </section>
          {details === null || selectedVersion === null ? null : (
            <ArtifactLinks
              note="Copy a link to hand this artifact on."
              onCopy={(text, label) => <CopyAction label={`${label} link`} text={text} />}
              rows={[
                {description: "Moves when a new version is published", label: "Latest", url: details.links.artifact},
                {description: "Exact version without Review controls", label: "Raw", url: selectedVersion.links.version},
              ]}
              title="Other links"
            />
          )}
          <section aria-labelledby={`${headingId}-agent`} style={sectionStyle}>
            <h3 id={`${headingId}-agent`} style={sectionHeadingStyle}>Review with an AI agent</h3>
            <p style={subtleStyle}>Copy one complete prompt into Claude, Codex, Cursor, GitHub Copilot, Pi, or OpenCode.</p>
            <div style={rowStyle}>
              <AgentLogos />
              {details === null || selectedVersion === null || reviewLink === null ? null : (
                <CopyAction
                  copiedLabel="Prompt copied"
                  label="Copy review prompt"
                  text={buildAgentReviewPrompt(details, selectedVersion, reviewLink)}
                  variant="outline"
                >
                  Copy review prompt
                </CopyAction>
              )}
              <Button
                disabled={details === null}
                iconRight="bi-chevron-right"
                onClick={() => {
                  setFailure(null);
                  setScreen("agents");
                }}
                size="sm"
                variant="link"
              >
                Connect MCP
              </Button>
            </div>
          </section>
          {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
          {notice === null ? null : <Alert variant="success">{notice}</Alert>}
          <p style={subtleStyle}>
            This Review link stays pinned to Version {selectedVersion?.version.number ?? "—"}
            {selectedPath === null ? "." : ` and ${selectedPath}.`}
          </p>
        </>
      ) : screen === "agents" ? (
        <>
          <p style={subtleStyle}>Choose the connection that matches where Artifact Server is running.</p>
          <section style={sectionStyle}>
            <div style={rowStyle}><strong>On this computer</strong><span style={subtleStyle}>Recommended for local use</span></div>
            <p style={subtleStyle}>Detect a supported client, install its private MCP connection, and verify it without copying a token.</p>
            <CodeBlock
              copy={{copiedLabel: "Copied", label: "Copy local connection command", onCopy: () => void copyText("artifactserver connect")}}
              tone="navy"
            >
              artifactserver connect
            </CodeBlock>
          </section>
          <section style={sectionStyle}>
            <div style={rowStyle}><strong>Team or remote server</strong><span style={subtleStyle}>MCP</span></div>
            <p style={subtleStyle}>Add this server address to the agent. Compatible deployments open browser sign-in; other self-hosted deployments use an administrator-issued scoped key.</p>
            <CodeBlock
              copy={{copiedLabel: "Copied", label: "Copy MCP server address", onCopy: () => void copyText(mcpAddress)}}
              tone="navy"
            >
              {mcpAddress}
            </CodeBlock>
          </section>
          <section style={sectionStyle}>
            <div style={rowStyle}><strong>Without MCP</strong><span style={subtleStyle}>HTTP API</span></div>
            <p style={subtleStyle}>The review prompt includes an exact authenticated API request for this version. Use a scoped API key from an administrator and never paste it into chat.</p>
          </section>
          {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
        </>
      ) : (
        <>
          <p style={subtleStyle}>Choose who can open the current version from the stable artifact link.</p>
          <fieldset style={fieldsetStyle}>
            <legend style={visuallyHiddenStyle}>Who can open this artifact</legend>
            <Checkbox
              checked={selectedAccess === "account_required"}
              description="An admitted installation account is required."
              disabled={pending}
              label="Private"
              name={`${headingId}-access`}
              onChange={() => setSelectedAccess("account_required")}
              radio
            />
            <Checkbox
              checked={selectedAccess === "public_link"}
              description="No sign-in. Anyone who can reach this server and has the link can open the current version."
              disabled={pending}
              label="Public link"
              name={`${headingId}-access`}
              onChange={() => setSelectedAccess("public_link")}
              radio
            />
          </fieldset>
          <p style={subtleStyle}>Public access does not create a tunnel, open a firewall, or make an unreachable server reachable.</p>
          {selectedAccess === details?.artifact.accessSetting ? null : (
            <Alert variant="warning">{accessChangeWarning(selectedAccess)}</Alert>
          )}
          {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
          <div style={rowStyle}>
            <Button disabled={pending} onClick={() => setScreen("overview")} outline size="sm" variant="secondary">
              Cancel
            </Button>
            <Button
              disabled={details === null || pending || selectedAccess === details.artifact.accessSetting}
              onClick={() => void saveAccess()}
              size="sm"
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </>
      )}
    </Popover>
  );
}

/** The six supported agents' marks, drawn for the current theme. */
export function AgentLogos() {
  const {theme} = useThemeMode();
  return (
    <span aria-label="Claude, Codex, Cursor, GitHub Copilot, Pi, and OpenCode" role="img" style={logosStyle}>
      {agentLogos.map((logo) => (
        <img alt="" aria-hidden="true" key={logo.name} src={theme === "dark" ? logo.dark : logo.light} style={logoStyle} />
      ))}
    </span>
  );
}

function exactReviewLink(
  selectedVersion: ArtifactVersion,
  selectedPath: string | null,
): string {
  const reviewUrl = new URL(selectedVersion.links.review);
  reviewUrl.searchParams.set("view", "focus");
  if (
    selectedPath !== null
    && selectedVersion.manifest.entries.some((entry) => entry.path === selectedPath)
  ) {
    reviewUrl.searchParams.set("path", selectedPath);
  } else {
    reviewUrl.searchParams.delete("path");
  }
  return reviewUrl.toString();
}

function buildAgentReviewPrompt(
  details: ArtifactDetails,
  selectedVersion: ArtifactVersion,
  reviewLink: string,
): string {
  const serverOrigin = new URL(details.links.artifact).origin;
  const apiUrl = new URL(
    `/api/v1/artifacts/${encodeURIComponent(details.artifact.id)}/versions/${encodeURIComponent(selectedVersion.version.id)}`,
    serverOrigin,
  );
  apiUrl.searchParams.set("projectId", details.artifact.projectId);
  const manifestResource = `artifact://projects/${details.artifact.projectId}/artifacts/${details.artifact.id}/versions/${selectedVersion.version.id}/manifest`;

  return `Review this Artifact Server artifact. Inspect the exact saved version below and do not silently substitute a newer version.

Artifact: ${details.artifact.name}
Project ID: ${details.artifact.projectId}
Artifact ID: ${details.artifact.id}
Version: ${selectedVersion.version.number}
Version ID: ${selectedVersion.version.id}
Access: ${details.artifact.accessSetting === "public_link" ? "public link" : "private"}
Review and comment: ${reviewLink}
Raw exact version: ${selectedVersion.links.version}
Moving latest link: ${details.links.artifact}

Preferred path — Artifact Server MCP:
1. Call artifact_get with projectId "${details.artifact.projectId}" and artifactId "${details.artifact.id}".
2. Keep versionId "${selectedVersion.version.id}" pinned. If artifact_get reports a different current version, use artifact_version_list and review the pinned version instead.
3. Read the exact manifest resource when available: ${manifestResource}
4. Use artifact_open.reviewUrl for the full-screen Review experience. Use artifact_open.browserUrl only when you need the raw rendered artifact.
5. Review the artifact and report findings in priority order. When comment tools are available, use comment_create against this exact version for precise, actionable findings.

If Artifact Server MCP is not connected:
- Local setup: run artifactserver connect, then retry with MCP.
- Remote or team setup: add ${serverOrigin}/mcp to the agent and complete browser sign-in, or use an administrator-issued scoped key when OAuth is unavailable.
- Direct HTTP fallback: GET ${apiUrl.toString()} with an admitted session or scoped API key.
- curl example: curl --fail-with-body --header "Authorization: Bearer $ARTIFACT_SERVER_API_KEY" '${apiUrl.toString()}'

Never paste credentials into chat, source files, or the review. If access fails, state which connection or permission is missing.`;
}
