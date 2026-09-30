import {useEffect, useState, type CSSProperties} from "react";

import type {AccessSetting, ArtifactDetails, ArtifactVersion} from "@/api/client";
import {
  Alert,
  Button,
  FieldGrid,
  Input,
  SectionHeading,
  Select,
  StatusPill,
  Tag,
} from "@/arkcase";
import {
  formatTimestamp,
  sourceDriftDescription,
  sourceFreshnessLabel,
  sourceFreshnessTone,
} from "@/lib/presentation";

import {accessChangeWarning, accessOptions} from "./artifact-access.ts";

export interface DetailsTabProps {
  readonly canManage: boolean;
  readonly details: ArtifactDetails;
  readonly linkedArtifacts: boolean;
  /** Changes access for the current version; rejects with the server's error. */
  readonly onAccessChange: (next: AccessSetting) => Promise<void>;
  readonly onCapture: () => Promise<void>;
  readonly onOpenLive: () => Promise<void>;
  readonly onTagsChange: (tags: readonly string[]) => Promise<void>;
  readonly version: ArtifactVersion;
}

const stackStyle = {display: "flex", flexDirection: "column", gap: 16, padding: "12px 14px 16px"} satisfies CSSProperties;
const sectionStyle = {display: "flex", flexDirection: "column", gap: 8} satisfies CSSProperties;
const noteStyle = {color: "var(--text-secondary)", fontSize: "var(--font-size-xs, 12px)", margin: 0} satisfies CSSProperties;
const buttonRowStyle = {alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8} satisfies CSSProperties;
const tagRowStyle = {display: "flex", flexWrap: "wrap", gap: 6} satisfies CSSProperties;

/** The artifact's record, access, tags and linked source. */
export function DetailsTab({
  canManage,
  details,
  linkedArtifacts,
  onAccessChange,
  onCapture,
  onOpenLive,
  onTagsChange,
  version,
}: DetailsTabProps) {
  const binding = details.sourceBinding;
  const driftDescription = binding === undefined
    ? null
    : sourceDriftDescription(binding.status, "captured");
  return (
    <div style={stackStyle}>
      <section style={sectionStyle}>
        <SectionHeading level={3} size="sm" title="Artifact" />
        <FieldGrid
          columns={1}
          fields={[
            {label: "Name", value: details.artifact.name},
            {label: "Access", value: details.artifact.accessSetting === "public_link" ? "Public link" : "Private"},
            {label: "Created", value: formatTimestamp(details.artifact.createdAt)},
            {label: "Artifact ID", mono: true, value: details.artifact.id},
            {label: "Project ID", mono: true, value: details.artifact.projectId},
          ]}
          layout="inline"
        />
      </section>
      <section style={sectionStyle}>
        <SectionHeading level={3} size="sm" title="Version" />
        <FieldGrid
          columns={1}
          fields={[
            {label: "Number", value: String(version.version.number)},
            {label: "Saved", value: formatTimestamp(version.version.createdAt)},
            {label: "Entry", mono: true, value: version.manifest.entryPath},
            {label: "Routing", value: version.version.routingMode},
            {label: "Version ID", mono: true, value: version.version.id},
          ]}
          layout="inline"
        />
      </section>
      <AccessEditor
        canManage={canManage}
        current={details.artifact.accessSetting}
        key={details.artifact.id}
        onChange={onAccessChange}
      />
      <TagsEditor artifact={details.artifact} key={`tags-${details.artifact.id}`} onChange={onTagsChange} />
      {binding === undefined ? null : (
        <section style={sectionStyle}>
          <SectionHeading level={3} size="sm" title="Linked source" />
          <FieldGrid
            columns={1}
            fields={[
              {
                label: "State",
                value: <StatusPill label={sourceFreshnessLabel(binding.status)} tone={sourceFreshnessTone(binding.status)} />,
              },
              {label: "Path", mono: true, value: binding.path},
            ]}
            layout="inline"
          />
          {driftDescription === null ? null : <p style={noteStyle}>{driftDescription}</p>}
          <div style={buttonRowStyle}>
            {canManage && binding.status !== "in-sync" ? (
              <Button onClick={() => void onCapture()} size="sm">Capture current file</Button>
            ) : null}
            {linkedArtifacts && details.links.live !== undefined ? (
              <Button onClick={() => void onOpenLive()} outline size="sm" variant="secondary">Open live file</Button>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}

interface AccessEditorProps {
  readonly canManage: boolean;
  readonly current: AccessSetting;
  readonly onChange: (next: AccessSetting) => Promise<void>;
}

function AccessEditor({canManage, current, onChange}: AccessEditorProps) {
  const [draft, setDraft] = useState<AccessSetting>(current);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!pending) setDraft(current);
  }, [current, pending]);
  const save = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onChange(draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Artifact access could not be changed."));
    } finally {
      setPending(false);
    }
  };
  return (
    <section style={sectionStyle}>
      <Select
        disabled={!canManage || pending}
        label="Access"
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "account_required" || value === "public_link") setDraft(value);
        }}
        options={[...accessOptions]}
        size="sm"
        value={draft}
      />
      {draft === current ? null : (
        <>
          <p style={noteStyle}>{accessChangeWarning(draft)}</p>
          <div style={buttonRowStyle}>
            <Button disabled={pending} onClick={() => void save()} size="sm">
              {pending ? "Saving…" : "Save access"}
            </Button>
            <Button disabled={pending} onClick={() => setDraft(current)} outline size="sm" variant="secondary">
              Cancel
            </Button>
          </div>
        </>
      )}
      {error === null ? null : <Alert variant="danger">{error.message}</Alert>}
    </section>
  );
}

interface TagsEditorProps {
  readonly artifact: ArtifactDetails["artifact"];
  readonly onChange: (tags: readonly string[]) => Promise<void>;
}

function TagsEditor({artifact, onChange}: TagsEditorProps) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState(artifact.tags.join(", "));

  useEffect(() => {
    if (!editing) setValue(artifact.tags.join(", "));
  }, [artifact.tags, editing]);

  const cancel = (): void => {
    setEditing(false);
    setError(null);
    setValue(artifact.tags.join(", "));
  };
  const save = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onChange(
        value.split(",").map((tag) => tag.trim()).filter((tag) => tag !== ""),
      );
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Tag update failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <section style={sectionStyle}>
      <SectionHeading count={artifact.tags.length} level={3} size="sm" title="Tags">
        {editing ? null : (
          <Button onClick={() => setEditing(true)} size="xs" variant="link">Edit tags</Button>
        )}
      </SectionHeading>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          style={sectionStyle}
        >
          <Input
            autoFocus
            disabled={pending}
            helper="Separate tags with commas. Saving replaces the complete set."
            label="Tags"
            onChange={(event) => setValue(event.currentTarget.value)}
            placeholder="prototype, approved"
            value={value}
          />
          {error === null ? null : <Alert variant="danger">{error.message}</Alert>}
          <div style={buttonRowStyle}>
            <Button disabled={pending} size="sm" type="submit">{pending ? "Saving…" : "Save tags"}</Button>
            <Button disabled={pending} onClick={cancel} outline size="sm" variant="secondary">Cancel</Button>
          </div>
        </form>
      ) : artifact.tags.length === 0 ? (
        <p style={noteStyle}>No tags on this artifact.</p>
      ) : (
        <div style={tagRowStyle}>
          {artifact.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
        </div>
      )}
    </section>
  );
}
