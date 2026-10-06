import {useId, useState, type CSSProperties} from "react";

import {api, type AccessSetting, type AdministeredInvite, type ArtifactDetails, type ArtifactVersion} from "@/api/client";
import {
  Alert,
  Button,
  Checkbox,
  ChoiceGroup,
  IconButton,
  Input,
  PanelSection,
  Popover,
} from "@/arkcase";
import {useThemeMode} from "@/theme/use-theme-mode";
import {CopyAction} from "@/ui/copy-action";
import {CopyableCode} from "@/ui/copyable-code";

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
import {InviteForm} from "../invites/invite-form.tsx";
import {InviteLinkReady} from "../invites/invite-link-ready.tsx";
import {focusButtonStyle} from "./focus-mode.tsx";
import {accessChangeWarning, changeArtifactAccess} from "./artifact-access.ts";

type ShareScreen = "access" | "agents" | "invite" | "inviteReady" | "overview";
type ShareTarget = "latest" | "version";

export interface SharePopoverProps {
  /** Administrators on a team installation can invite people. */
  readonly canInvite: boolean;
  readonly chrome?: "navy" | "workspace";
  readonly details: ArtifactDetails | null;
  readonly onArtifactChanged: (artifact: ArtifactDetails["artifact"]) => void;
  /** Opens the access controls elsewhere (the Details panel); without it Share edits access itself. */
  readonly onManageAccess?: (() => void) | undefined;
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
const overviewContentStyle = {gap: 0, maxHeight: "80vh", overflowY: "auto", padding: 0} satisfies CSSProperties;
const linkRowStyle = {alignItems: "center", display: "flex", gap: 8} satisfies CSSProperties;
const linkFieldStyle = {flex: "1 1 auto", minWidth: 0} satisfies CSSProperties;
const accessLineStyle = {
  alignItems: "flex-start",
  color: "var(--text-secondary)",
  display: "flex",
  fontSize: 13,
  gap: 8,
  lineHeight: 1.45,
} satisfies CSSProperties;
const accessIconStyle = {marginTop: 2} satisfies CSSProperties;
const bandTitleStyle = {color: "var(--text-strong)", fontSize: 13, fontWeight: 600} satisfies CSSProperties;
const bandTextStyle = {display: "flex", flex: "1 1 auto", flexDirection: "column", gap: 2, minWidth: 0} satisfies CSSProperties;
const inviteRowStyle = {alignItems: "center", display: "flex", gap: 12} satisfies CSSProperties;
const headerStyle = {alignItems: "flex-start", display: "flex", gap: 8} satisfies CSSProperties;
const headerTextStyle = {flex: "1 1 auto", minWidth: 0} satisfies CSSProperties;
const headingStyle = {fontSize: "var(--font-size-md, 16px)", margin: 0, overflowWrap: "anywhere"} satisfies CSSProperties;
const subtleStyle = {color: "var(--text-secondary)", fontSize: "var(--font-size-xs, 12px)", margin: 0} satisfies CSSProperties;
const sectionStyle = {display: "flex", flexDirection: "column", gap: 8} satisfies CSSProperties;
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
  canInvite,
  chrome = "workspace",
  details,
  onArtifactChanged,
  onManageAccess,
  selectedPath,
  selectedVersion,
}: SharePopoverProps) {
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<ShareScreen>("overview");
  const [target, setTarget] = useState<ShareTarget>("version");
  const [selectedAccess, setSelectedAccess] = useState<AccessSetting>(
    details?.artifact.accessSetting ?? "account_required",
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [issued, setIssued] = useState<{readonly invite: AdministeredInvite; readonly url: string} | null>(null);
  const headingId = useId();

  const updateOpen = (next: boolean): void => {
    if (pending && !next) return;
    setOpen(next);
    if (next) {
      setScreen("overview");
      setFailure(null);
      setIssued(null);
      if (canInvite) void countMembers();
    }
  };

  const countMembers = async (): Promise<void> => {
    try {
      const members = await api.members();
      setMemberCount(members.filter((member) => member.status === "active").length);
    } catch {
      setMemberCount(null);
    }
  };

  const reviewLink = selectedVersion === null ? null : exactReviewLink(selectedVersion, selectedPath);
  const shareLink = target === "latest" ? details?.links.artifact ?? null : reviewLink;

  const openAccess = (): void => {
    if (details === null) return;
    if (onManageAccess !== undefined) {
      setOpen(false);
      onManageAccess();
      return;
    }
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
    : screen === "access" ? "Artifact access"
    : screen === "invite" ? "Invite People"
    : screen === "inviteReady" ? "Invite Link Ready"
    : "Connect MCP";
  const subtitle = screen === "overview"
    ? `Exact version · Version ${selectedVersion?.version.number ?? "—"}`
    : details?.artifact.name ?? "No artifact selected";

  return (
    <Popover
      contentStyle={screen === "overview" ? overviewContentStyle : contentStyle}
      label="Share this version"
      onOpenChange={updateOpen}
      open={open}
      placement="bottom-end"
      trigger={(
        <IconButton
          ariaLabel="Share this version"
          disabled={details === null || selectedVersion === null}
          icon="bi-share"
          size={chrome === "navy" ? "xs" : "sm"}
          style={chrome === "navy" ? focusButtonStyle : {}}
          title="Share"
          variant={chrome === "navy" ? "navy" : "ghost"}
        />
      )}
      width={380}
      zIndex={1200}
    >
      {screen === "overview" ? null : (
        <header style={headerStyle}>
          <IconButton
            ariaLabel="Back to Share"
            disabled={pending}
            icon="bi-chevron-left"
            onClick={() => setScreen("overview")}
            size="sm"
          />
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
      )}

      {screen === "overview" ? (
        <>
          <PanelSection divided={false} gap={12} headingLevel={2} title="Link Opens">
            <ChoiceGroup
              label="Link opens"
              minColumnWidth={150}
              onChange={(id) => {
                if (id === "version" || id === "latest") setTarget(id);
              }}
              options={[
                {
                  description: "Exact version, with review and comments",
                  id: "version",
                  title: `This version · v${selectedVersion?.version.number ?? "—"}`,
                },
                {description: "Moves when a new version is published", id: "latest", title: "Latest"},
              ]}
              value={target}
            />
            {shareLink === null ? null : (
              <div style={linkRowStyle}>
                <Input
                  aria-label="Link"
                  icon="bi-link-45deg"
                  mono
                  readOnly
                  size="sm"
                  style={linkFieldStyle}
                  value={shareLink.replace(/^https?:\/\//u, "")}
                />
                <CopyAction
                  copiedLabel="Link copied"
                  label={target === "latest" ? "Copy Latest link" : "Copy Review link"}
                  text={shareLink}
                  variant="outline"
                >
                  Copy Link
                </CopyAction>
              </div>
            )}
            <div style={accessLineStyle}>
              <i aria-hidden="true" className="bi bi-people" style={accessIconStyle} />
              <span style={headerTextStyle}>
                {publicArtifact
                  ? "Anyone with the latest link can open it. People with access to this Artifact Server can review it."
                  : "People with access to this Artifact Server can review it."}
              </span>
              <Button disabled={details === null} onClick={openAccess} size="xs" variant="link">
                Manage Access
              </Button>
            </div>
            {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
            {notice === null ? null : <Alert variant="success">{notice}</Alert>}
          </PanelSection>
          {canInvite ? (
            <PanelSection gap={8} padding="12px 16px">
              <div style={inviteRowStyle}>
                <i aria-hidden="true" className="bi bi-people" />
                <span style={bandTextStyle}>
                  <span style={bandTitleStyle}>{memberCount === null ? "Members" : `${memberCount} members`}</span>
                  <span style={subtleStyle}>Invite someone with a link they redeem by signing in.</span>
                </span>
                <Button icon="bi-person-plus" onClick={() => setScreen("invite")} outline size="sm" variant="primary">
                  Invite
                </Button>
              </div>
            </PanelSection>
          ) : null}
          <PanelSection padding="12px 16px 16px" tone="band">
            <div style={bandTextStyle}>
              <span style={bandTitleStyle}>Review with an AI agent</span>
              <span style={subtleStyle}>One complete prompt for Claude, Codex, Cursor, GitHub Copilot, Pi or OpenCode.</span>
            </div>
            <div style={rowStyle}>
              <AgentLogos />
              {details === null || selectedVersion === null || reviewLink === null ? null : (
                <CopyAction
                  copiedLabel="Review prompt copied"
                  label="Copy Review Prompt"
                  text={buildAgentReviewPrompt(details, selectedVersion, reviewLink)}
                  variant="outline"
                >
                  Copy Review Prompt
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
          </PanelSection>
        </>
      ) : screen === "invite" ? (
        <InviteForm
          onCancel={() => setScreen("overview")}
          onCreated={(created) => {
            setIssued(created);
            setScreen("inviteReady");
          }}
          opens={details === null || selectedVersion === null ? undefined : {
            artifactId: details.artifact.id,
            projectId: details.artifact.projectId,
            versionId: selectedVersion.version.id,
          }}
        />
      ) : screen === "inviteReady" && issued !== null ? (
        <InviteLinkReady
          allInvitesHref="/review/settings/invites"
          invite={issued.invite}
          onDone={() => updateOpen(false)}
          onRevoked={() => setScreen("overview")}
          url={issued.url}
        />
      ) : screen === "agents" ? (
        <>
          <p style={subtleStyle}>Choose the connection that matches where Artifact Server is running.</p>
          <section style={sectionStyle}>
            <div style={rowStyle}><strong>On this computer</strong><span style={subtleStyle}>Recommended for local use</span></div>
            <p style={subtleStyle}>Detect a supported client, install its private MCP connection, and verify it without copying a token.</p>
            <CopyableCode
              code="artifactserver connect"
              copiedLabel="Copied"
              copyLabel="Copy local connection command"
              onResult={(copied) => setFailure(copied ? null : copyRefusal("local connection command"))}
              tone="navy"
            />
          </section>
          <section style={sectionStyle}>
            <div style={rowStyle}><strong>Team or remote server</strong><span style={subtleStyle}>MCP</span></div>
            <p style={subtleStyle}>Add this server address to the agent. Compatible deployments open browser sign-in; other self-hosted deployments use an administrator-issued scoped key.</p>
            <CopyableCode
              code={mcpAddress}
              copiedLabel="Copied"
              copyLabel="Copy MCP server address"
              onResult={(copied) => setFailure(copied ? null : copyRefusal("MCP server address"))}
              tone="navy"
            />
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

function copyRefusal(subject: string): string {
  return `The browser did not copy the ${subject}. Select it and copy it manually.`;
}

/** The Review link pinned to this exact version and, when it is in the version, this page. */
export function exactReviewLink(
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
