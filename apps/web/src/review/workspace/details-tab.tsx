import {useEffect, useState, type CSSProperties} from "react";

import type {AccessSetting, ArtifactDetails, ArtifactVersion} from "@/api/client";
import type {ProvenanceOutcome} from "@/api/views";
import {
  Alert,
  Button,
  ConfirmDialog,
  FieldGrid,
  Input,
  PanelSection,
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
import {CopyAction} from "@/ui/copy-action";
import {ArtifactLinks} from "@/ui/review-ui";

import {accessChangeWarning, accessOptions} from "./artifact-access.ts";

export interface DetailsTabProps {
  readonly archived: boolean;
  readonly canManage: boolean;
  readonly details: ArtifactDetails;
  readonly linkedArtifacts: boolean;
  /** Changes access for the current version; rejects with the server's error. */
  readonly onAccessChange: (next: AccessSetting) => Promise<void>;
  readonly onCapture: () => Promise<void>;
  /** Deletes the artifact after the confirmation; resolves whether it was deleted. */
  readonly onDelete: () => Promise<boolean>;
  readonly onOpenLive: () => Promise<void>;
  readonly onTagsChange: (tags: readonly string[]) => Promise<void>;
  /** The version's source-provenance outcome, or null while it loads. */
  readonly provenance: ProvenanceOutcome | null;
  /** The exact Review link of the version and page shown. */
  readonly reviewLink: string;
  readonly version: ArtifactVersion;
  readonly versionCount: number;
}

const noteStyle = {color: "var(--text-secondary)", fontSize: "var(--font-size-xs, 12px)", lineHeight: 1.45, margin: 0} satisfies CSSProperties;
const buttonRowStyle = {alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8} satisfies CSSProperties;
const tagRowStyle = {display: "flex", flexWrap: "wrap", gap: 6} satisfies CSSProperties;
const stackStyle = {display: "flex", flexDirection: "column", gap: 6} satisfies CSSProperties;
const deleteStyle = {alignItems: "flex-start", display: "flex", flexDirection: "column", gap: 10} satisfies CSSProperties;
const versionValueStyle = {alignItems: "center", display: "inline-flex", gap: 8} satisfies CSSProperties;
const versionNumberStyle = {color: "var(--text-data)", fontFamily: "var(--font-data)", fontWeight: 600} satisfies CSSProperties;
const labelWidth = 104;

/**
 * One scrolling column of sections, each under an 11px heading with a full-width rule
 * between them: this version, access, links, tags, hosting, the linked source,
 * identifiers and, last, deleting the artifact.
 */
export function DetailsTab({
  archived,
  canManage,
  details,
  linkedArtifacts,
  onAccessChange,
  onCapture,
  onDelete,
  onOpenLive,
  onTagsChange,
  provenance,
  reviewLink,
  version,
  versionCount,
}: DetailsTabProps) {
  const [deleteAsk, setDeleteAsk] = useState(false);
  const binding = details.sourceBinding;
  const driftDescription = binding === undefined
    ? null
    : sourceDriftDescription(binding.status, "captured");
  const current = version.version.id === details.artifact.currentVersionId;
  const name = details.artifact.name;
  return (
    <div>
      <PanelSection divided={false} title="This Version">
        <FieldGrid
          fields={[
            {
              label: "Version",
              note: current ? undefined : "Another version is current.",
              value: (
                <span style={versionValueStyle}>
                  <span style={versionNumberStyle}>v{version.version.number}</span>
                  <StatusPill label={current ? "Current" : "Preview"} tone={current ? "primary" : "neutral"} />
                </span>
              ),
            },
            {label: "Published", mono: true, value: formatTimestamp(version.version.createdAt)},
            {label: "Default Page", mono: true, value: version.manifest.entryPath},
          ]}
          labelWidth={labelWidth}
          layout="inline"
        />
      </PanelSection>
      <PanelSection title="Access">
        <AccessEditor
          canManage={canManage}
          current={details.artifact.accessSetting}
          key={details.artifact.id}
          onChange={onAccessChange}
        />
      </PanelSection>
      <PanelSection title="Links">
        <ArtifactLinks
          compact
          note={null}
          onCopy={(text, label) => <CopyAction label={`Copy ${label} link`} text={text} />}
          rows={[
            {description: "This version and page, with review and comments.", label: `Review · v${version.version.number}`, url: reviewLink},
            {description: "Moves when a new version is published.", label: "Latest", url: details.links.artifact},
            {description: "This version without review controls.", label: "Raw", url: version.links.version},
          ]}
          title="Links"
        />
      </PanelSection>
      <TagsEditor artifact={details.artifact} key={`tags-${details.artifact.id}`} onChange={onTagsChange} />
      <PanelSection title="Hosting">
        <FieldGrid
          fields={[
            {label: "Routing", value: version.version.routingMode === "spa" ? "Single-page app" : "Static"},
            {label: "Created", mono: true, value: formatTimestamp(details.artifact.createdAt)},
          ]}
          labelWidth={labelWidth}
          layout="inline"
        />
      </PanelSection>
      {binding === undefined ? null : (
        <PanelSection title="Linked Source">
          <FieldGrid
            fields={[
              {
                label: "State",
                value: <StatusPill label={sourceFreshnessLabel(binding.status)} tone={sourceFreshnessTone(binding.status)} />,
              },
              {label: "Path", mono: true, value: binding.path},
            ]}
            labelWidth={labelWidth}
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
        </PanelSection>
      )}
      <SourceSection provenance={provenance} version={version} />
      <PanelSection title="Identifiers">
        <FieldGrid
          fields={[
            {label: "Artifact", mono: true, value: details.artifact.id},
            {label: "Version", mono: true, value: version.version.id},
            {label: "Project", mono: true, value: details.artifact.projectId},
          ]}
          labelWidth={labelWidth}
          layout="inline"
        />
      </PanelSection>
      <PanelSection title="Delete Artifact">
        <div style={deleteStyle}>
          <p style={noteStyle}>
            {archived
              ? "The project is archived, so its artifacts cannot be deleted."
              : canManage
                ? `Deletes ${name} and its ${versionCount} ${versionCount === 1 ? "version" : "versions"} from normal use. Its review, latest and raw links stop working.`
                : "Only people who manage this project's artifacts can delete it."}
          </p>
          <Button
            disabled={!canManage}
            icon="bi-trash"
            onClick={() => setDeleteAsk(true)}
            outline
            size="sm"
            variant="danger"
          >
            Delete Artifact
          </Button>
        </div>
      </PanelSection>
      <ConfirmDialog
        confirmIcon="bi-trash"
        confirmLabel="Delete Artifact"
        message={`This deletes ${name} and its ${versionCount} ${versionCount === 1 ? "version" : "versions"}, with their pages and conversations, from normal use. Review, latest and raw links stop working. The server keeps a tombstone record.`}
        onClose={() => setDeleteAsk(false)}
        onConfirm={() => void onDelete()}
        open={deleteAsk}
        title={`Delete ${name}?`}
      />
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
    <div style={stackStyle}>
      <Select
        aria-label="Who can open this artifact"
        disabled={!canManage || pending}
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
    </div>
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
    <PanelSection
      actions={editing ? null : <Button onClick={() => setEditing(true)} size="xs" variant="link">Edit tags</Button>}
      title={`Tags · ${artifact.tags.length}`}
    >
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          style={stackStyle}
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
    </PanelSection>
  );
}

/** The authored source behind this version, kept apart from its manifest identity. */
function SourceSection({provenance, version}: {
  readonly provenance: ProvenanceOutcome | null;
  readonly version: ArtifactVersion;
}) {
  if (provenance === null || provenance.status === "not-recorded") {
    return (
      <PanelSection title="Source">
        <p style={noteStyle}>Source not recorded. Agents can inspect this version but not edit its source.</p>
      </PanelSection>
    );
  }
  if (provenance.status === "invalid" || provenance.status === "unsupported-version") {
    return (
      <PanelSection title="Source">
        <p style={noteStyle}>
          {provenance.status === "invalid"
            ? `The source record is invalid: ${provenance.diagnostic}`
            : `The source record uses unsupported version ${provenance.version}.`}
        </p>
      </PanelSection>
    );
  }
  const {coverage, record} = provenance;
  return (
    <PanelSection title="Source">
      <FieldGrid
        fields={[
          {
            label: "Check",
            value: provenance.status === "verified"
              ? <StatusPill label="Verified" tone="success" />
              : <StatusPill label={`Mismatch · ${provenance.mismatchCount}`} tone="danger" />,
          },
          {label: "Repository", mono: true, value: record.source.repository},
          {
            label: "Authored commit",
            mono: true,
            note: record.source.dirty ? "Built from uncommitted changes." : undefined,
            noteTone: "warning",
            value: record.source.commit,
          },
          {label: "Manifest", mono: true, value: version.manifest.digest},
          {
            label: "Coverage",
            value: `${coverage.declaredOutputs} of ${coverage.manifestFiles} files declared · dependency edges ${coverage.dependencyEdges}`,
          },
        ]}
        labelWidth={labelWidth}
        layout="inline"
      />
      {provenance.status === "mismatch" ? (
        <p style={noteStyle}>{`Differs from the record: ${provenance.mismatches.slice(0, 5).map((item) => item.path).join(", ")}`}</p>
      ) : null}
    </PanelSection>
  );
}
