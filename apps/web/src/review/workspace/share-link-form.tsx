import {useState, type CSSProperties} from "react";

import {api, type AccessPolicy, type ArtifactDetails, type ArtifactVersion, type ShareLink} from "@/api/client";
import {Alert, Button, Checkbox, ChoiceGroup, Input, Select} from "@/arkcase";
import {errorMessage} from "@/lib/presentation";

import {
  expiryChoices,
  expiryInstant,
  type GuestPermission,
  presetLabel,
  presetPermissions,
  type ShareLinkPreset,
} from "./share-link-model.ts";

export interface ShareLinkFormProps {
  readonly details: ArtifactDetails;
  readonly onCancel: () => void;
  readonly onCreated: (link: ShareLink) => void;
  /** Administrators see the installation policy; everyone else is bounded by the server's answer. */
  readonly policy: AccessPolicy | null;
  readonly selectedVersion: ArtifactVersion;
}

const formStyle = {display: "flex", flexDirection: "column", gap: 12} satisfies CSSProperties;
const rowStyle = {alignItems: "center", display: "flex", gap: 8, justifyContent: "flex-end"} satisfies CSSProperties;
const customStyle = {display: "flex", flexDirection: "column", gap: 6, paddingLeft: 4} satisfies CSSProperties;

const presets: readonly ShareLinkPreset[] = ["view", "comment", "custom"];

/** Create one share link for the open artifact. */
export function ShareLinkForm({details, onCancel, onCreated, policy, selectedVersion}: ShareLinkFormProps) {
  const allowed = new Set(policy?.shareLinks.guestPermissionsMax ?? ["artifact.view", "comment.read", "comment.write"]);
  const commentAllowed = allowed.has("comment.read") && allowed.has("comment.write");
  const choices = expiryChoices(policy?.shareLinks.maxExpiryDays ?? null);
  const [label, setLabel] = useState("");
  const [preset, setPreset] = useState<ShareLinkPreset>(commentAllowed ? "comment" : "view");
  const [custom, setCustom] = useState<readonly GuestPermission[]>(["artifact.view", "comment.read"]);
  const [target, setTarget] = useState<"latest" | "pinned">("pinned");
  const [expiryIndex, setExpiryIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const toggleCustom = (permission: GuestPermission, checked: boolean) => {
    setCustom((current) => checked ? [...current, permission] : current.filter((held) => held !== permission));
  };

  const create = async () => {
    setPending(true);
    setFailure(null);
    try {
      const link = await api.createShareLink(details.artifact.projectId, details.artifact.id, {
        expiresAt: expiryInstant(choices[expiryIndex]?.days ?? null, new Date()),
        label: label.trim(),
        permissions: [...presetPermissions(preset, custom)],
        target: target === "latest" ? {kind: "latest"} : {kind: "pinned", versionId: selectedVersion.version.id},
      });
      onCreated(link);
    } catch (caught) {
      setFailure(caught instanceof Error ? errorMessage(caught) : "The link could not be created.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={formStyle}>
      <Input
        disabled={pending}
        label="Label"
        onChange={(event) => setLabel(event.currentTarget.value)}
        placeholder="For example, Client review"
        size="sm"
        value={label}
      />
      <ChoiceGroup
        label="Guests can"
        minColumnWidth={100}
        onChange={(id) => {
          if (id === "view" || id === "comment" || id === "custom") setPreset(id);
        }}
        options={presets.map((candidate) => ({
          disabled: candidate === "comment" && !commentAllowed,
          id: candidate,
          title: presetLabel(candidate),
        }))}
        value={preset}
      />
      {preset === "custom" ? (
        <div style={customStyle}>
          <Checkbox checked disabled label="View this version" />
          <Checkbox
            checked={custom.includes("comment.read")}
            disabled={pending || !allowed.has("comment.read")}
            label="Read comments"
            onChange={(event) => toggleCustom("comment.read", event.currentTarget.checked)}
          />
          <Checkbox
            checked={custom.includes("comment.write")}
            disabled={pending || !allowed.has("comment.write")}
            label="Write comments"
            onChange={(event) => toggleCustom("comment.write", event.currentTarget.checked)}
          />
        </div>
      ) : null}
      <ChoiceGroup
        label="Link opens"
        minColumnWidth={140}
        onChange={(id) => {
          if (id === "latest" || id === "pinned") setTarget(id);
        }}
        options={[
          {description: `Version ${selectedVersion.version.number}, even after new ones`, id: "pinned", title: "This version"},
          {description: "Moves when a new version is published", id: "latest", title: "Latest"},
        ]}
        value={target}
      />
      <Select
        disabled={pending}
        label="Expires"
        onChange={(event) => setExpiryIndex(Number.parseInt(event.currentTarget.value, 10))}
        options={choices.map((choice, index) => ({label: choice.label, value: String(index)}))}
        size="sm"
        value={String(expiryIndex)}
      />
      {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
      <div style={rowStyle}>
        <Button disabled={pending} onClick={onCancel} outline size="sm" variant="secondary">Cancel</Button>
        <Button disabled={pending || label.trim() === ""} onClick={() => void create()} size="sm">
          {pending ? "Creating…" : "Create Link"}
        </Button>
      </div>
    </div>
  );
}
