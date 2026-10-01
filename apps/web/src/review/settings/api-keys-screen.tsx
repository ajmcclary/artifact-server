import {useEffect, useId, useState, type CSSProperties} from "react";

import {
  api,
  type AdministeredApiKey,
  type InstallationMember,
  type IssuedApiKey,
  type PrincipalCapability,
} from "@/api/client";
import {
  Alert,
  AutoGrid,
  Button,
  Checkbox,
  DataGrid,
  Eyebrow,
  FieldGrid,
  Input,
  Modal,
  RecordPanel,
  Select,
  SlideOver,
  StatusPill,
  SurfaceState,
  Tag,
  type GridColumn,
} from "@/arkcase";
import {CopyableCode} from "@/ui/copyable-code";
import {AdminConsole, useAdminInspectorFullscreen} from "./admin-console.tsx";
import {dateOrDash, dateTimeOrDash, keyStatusLabel, keyStatusTone, type KeyStatus} from "./admin-areas.ts";
import {AddRecordButton, AdminStack, nativeInputAttributes, RequestFailure} from "./admin-parts.tsx";
import {useSelectedRecord} from "./use-selected-record.ts";

interface KeyRow {
  readonly apiKey: AdministeredApiKey;
  readonly capabilityCount: number;
  readonly expires: string;
  readonly id: string;
  readonly lastUsed: string;
  readonly name: string;
  readonly owner: string;
  readonly status: KeyStatus;
}

const statusPill = (status: KeyStatus) => <StatusPill label={keyStatusLabel(status)} tone={keyStatusTone(status)} />;

const capabilities: readonly {
  readonly description: string;
  readonly label: string;
  readonly value: PrincipalCapability;
}[] = [
  { description: "List and read artifact metadata.", label: "Read artifacts", value: "artifact:read" },
  { description: "Create new artifacts.", label: "Create artifacts", value: "artifact:create" },
  { description: "Publish new immutable versions.", label: "Publish versions", value: "artifact:publish:any" },
  { description: "Restore, change tags and access, or tombstone.", label: "Manage artifacts", value: "artifact:manage:any" },
  { description: "Open account-required artifact content.", label: "Issue content sessions", value: "content-session:issue" },
  { description: "Create, rename, archive, and unarchive projects.", label: "Manage projects", value: "project:manage" },
  { description: "Register a coding agent and claim dispatched annotations.", label: "Connect agents", value: "agent:connect" },
  { description: "Read, reply to, and resolve review comments.", label: "Manage comments", value: "comment:write" },
];

/** Format one instant as the browser's local wall-clock minute value. */
export function formatDatetimeLocalMinimum(now: Date): string {
  const localMilliseconds = now.getTime() - now.getTimezoneOffset() * 60_000;
  return new Date(localMilliseconds).toISOString().slice(0, 16);
}

/** Administrator-only managed API key issuance and lifecycle surface. */
export function ApiKeysScreen() {
  const capabilitiesHeadingId = useId();
  const [apiKeys, setApiKeys] = useState<readonly AdministeredApiKey[]>([]);
  const [members, setMembers] = useState<readonly InstallationMember[]>([]);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState("");
  const [memberId, setMemberId] = useState("");
  const [selectedCapabilities, setSelectedCapabilities] = useState<
    readonly PrincipalCapability[]
  >([]);
  const [revoking, setRevoking] = useState<AdministeredApiKey | null>(null);
  const [rotating, setRotating] = useState<AdministeredApiKey | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedKeys, loadedMembers] = await Promise.all([
        api.apiKeys(),
        api.members(),
      ]);
      setApiKeys(loadedKeys);
      setMembers(loadedMembers);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key list failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggleCapability = (capability: PrincipalCapability, checked: boolean) => {
    setSelectedCapabilities((current) => checked
      ? [...current, capability]
      : current.filter((candidate) => candidate !== capability));
  };

  const issue = async () => {
    setPending(true);
    setError(null);
    try {
      const expirationDate = new Date(expiration);
      const result = await api.issueApiKey(
        name,
        expirationDate.toISOString(),
        selectedCapabilities,
        memberId === "" ? undefined : memberId,
      );
      setIssueOpen(false);
      setIssued(result);
      setName("");
      setExpiration("");
      setMemberId("");
      setSelectedCapabilities([]);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key issuance failed."));
    } finally {
      setPending(false);
    }
  };

  const rotate = async (keyId: string) => {
    setPending(true);
    setError(null);
    try {
      setIssued(await api.rotateApiKey(keyId));
      setRotating(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key rotation failed."));
    } finally {
      setPending(false);
    }
  };

  const revoke = async (keyId: string) => {
    setPending(true);
    setError(null);
    try {
      await api.revokeApiKey(keyId);
      await load();
      setRevoking(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key revocation failed."));
    } finally {
      setPending(false);
    }
  };

  const ownerOptions = [
    {label: "Service principal", value: ""},
    ...members.filter((member) => member.status === "active").map((member) => ({
      label: `${member.displayName} · ${member.email}`,
      value: member.id,
    })),
  ];
  const [selectedId, selectRecord] = useSelectedRecord();
  const fullscreen = useAdminInspectorFullscreen();
  const capabilityLabel = new Map(capabilities.map((capability) => [capability.value, capability.label]));
  const rows: KeyRow[] = apiKeys.map((apiKey) => ({
    apiKey,
    capabilityCount: apiKey.capabilities.length,
    expires: dateOrDash(apiKey.expiresAt),
    id: apiKey.id,
    lastUsed: dateOrDash(apiKey.lastUsedAt),
    name: apiKey.name,
    owner: apiKey.ownerName ?? "—",
    status: apiKey.status,
  }));
  const columns: GridColumn<KeyRow>[] = [
    {
      cellRenderer: (_value: string, row: KeyRow) => (
        <span style={keyCellStyle}>
          <span>{row.name}</span>
          <span style={prefixStyle}>{row.apiKey.prefix}</span>
        </span>
      ),
      field: "name",
      headerName: "Key",
      onCellClick: (row) => selectRecord(row.id),
      width: 240,
    },
    {field: "owner", headerName: "Owner", width: 170},
    {field: "capabilityCount", headerName: "Capabilities", type: "count", width: 120},
    {field: "lastUsed", headerName: "Last used", type: "date", width: 120},
    {field: "expires", headerName: "Expires", type: "date", width: 120},
    {cellRenderer: (value: KeyStatus) => statusPill(value), field: "status", headerName: "Status", width: 110},
  ];
  const selected = apiKeys.find((apiKey) => apiKey.id === selectedId) ?? null;
  const inspector = selected === null ? null : (
    <SlideOver
      footer={selected.status === "active" ? (
        <Button danger icon="bi-x-circle" onClick={() => setRevoking(selected)} outline size="sm" variant="secondary">
          Revoke
        </Button>
      ) : null}
      fullscreen={fullscreen}
      onClose={() => selectRecord(null)}
      subtitle={selected.ownerName ?? undefined}
      title={selected.name}
      titleMeta={statusPill(selected.status)}
      width={360}
    >
      <div style={detailStackStyle}>
        <FieldGrid
          columns={1}
          fields={[
            {label: "Prefix", mono: true, value: selected.prefix},
            {label: "Created", mono: true, value: dateTimeOrDash(selected.createdAt)},
            {label: "Last used", mono: true, value: dateTimeOrDash(selected.lastUsedAt)},
            {label: "Expires", mono: true, value: dateTimeOrDash(selected.expiresAt)},
            ...(selected.revokedAt === null ? [] : [{
              label: "Revoked",
              value: `${dateTimeOrDash(selected.revokedAt)} by ${selected.revokedBy?.name ?? "Unknown"}`,
            }]),
          ]}
        />
        <div aria-label="Capabilities" role="list" style={tagListStyle}>
          {selected.capabilities.map((capability) => (
            <span key={capability} role="listitem"><Tag>{capabilityLabel.get(capability) ?? capability}</Tag></span>
          ))}
        </div>
      </div>
    </SlideOver>
  );
  const activeCount = apiKeys.filter((apiKey) => apiKey.status === "active").length;

  return (
    <AdminConsole administrator area="apiKeys" inspector={inspector}>
      {error === null || issueOpen || revoking !== null || rotating !== null
        ? null
        : <RequestFailure error={error} onRetry={() => void load()} />}
      {loading && apiKeys.length === 0 ? (
        <SurfaceState loadingTitle="Loading API keys" noun="API keys" phase="loading" skeleton={3} />
      ) : (
        <RecordPanel
          actions={<AddRecordButton label="Issue API key" onClick={() => setIssueOpen(true)} />}
          capAlign="center"
          label="API keys"
          metaWrap
          subtitle={`${apiKeys.length} keys · ${activeCount} active`}
        >
          <DataGrid
            ariaLabel="API keys"
            columns={columns}
            empty={(
              <SurfaceState
                count={0}
                density="inline"
                emptyBody="Issue a scoped key for automation or a compatible self-hosted MCP client."
                emptyIcon="bi-key"
                emptyTitle="No API keys"
                noun="API keys"
                phase="ready"
              />
            )}
            quickFilter
            rowActions={(row: KeyRow) => row.status === "active" ? [
              {danger: true, icon: "bi-arrow-repeat", label: "Rotate", onClick: () => setRotating(row.apiKey)},
              {danger: true, icon: "bi-x-circle", label: "Revoke", onClick: () => setRevoking(row.apiKey)},
            ] : null}
            rowActionsLabel={(row: KeyRow) => `Actions for ${row.name}`}
            rows={rows}
            selectable={false}
            statusBar={false}
          />
        </RecordPanel>
      )}
      <Modal
        fullscreenBelow={768}
        icon="bi-key"
        inertSiblings
        onClose={() => setIssueOpen(false)}
        open={issueOpen}
        portal
        primaryAction={{
          disabled: pending
            || name.trim() === ""
            || expiration === ""
            || selectedCapabilities.length === 0,
          label: pending ? "Issuing…" : "Issue API key",
          onClick: () => void issue(),
        }}
        subtitle="The secret appears once. Give the key only the capabilities it needs and choose a future expiration."
        title="Issue API key"
      >
        <AdminStack>
          {error === null ? null : <RequestFailure error={error} />}
          <Input
            {...nativeInputAttributes({maxLength: 200})}
            helper="Name the client or installation the key belongs to."
            label="Name"
            onChange={(event) => setName(event.currentTarget.value)}
            size="sm"
            value={name}
          />
          <AutoGrid gap={12} min={200}>
            <Input
              {...nativeInputAttributes({min: formatDatetimeLocalMinimum(new Date())})}
              helper="Expiration is required."
              label="Expires at"
              onChange={(event) => setExpiration(event.currentTarget.value)}
              size="sm"
              type="datetime-local"
              value={expiration}
            />
            <Select
              label="Owner"
              onChange={(event) => setMemberId(event.currentTarget.value)}
              options={ownerOptions}
              size="sm"
              value={memberId}
            />
          </AutoGrid>
          <div aria-labelledby={capabilitiesHeadingId} role="group" style={capabilityGroupStyle}>
            <Eyebrow id={capabilitiesHeadingId}>Capabilities</Eyebrow>
            {capabilities.map((capability) => (
              <Checkbox
                checked={selectedCapabilities.includes(capability.value)}
                description={capability.description}
                key={capability.value}
                label={capability.label}
                meta={capability.value}
                onChange={(event) => toggleCapability(capability.value, event.currentTarget.checked)}
              />
            ))}
          </div>
        </AdminStack>
      </Modal>

      <SecretModal issued={issued} onDiscard={() => setIssued(null)} />

      <Modal
        icon="bi-arrow-repeat"
        inertSiblings
        onClose={() => setRotating(null)}
        open={rotating !== null}
        portal
        primaryAction={{
          disabled: pending || rotating === null,
          label: pending ? "Rotating…" : "Rotate API key",
          onClick: () => {
            if (rotating !== null) void rotate(rotating.id);
          },
          variant: "danger",
        }}
        size="sm"
        subtitle={rotating === null
          ? ""
          : `${rotating.name} stops working immediately and a new secret with the same capabilities is shown once.`}
        title="Rotate API key"
      >
        {error === null ? null : <RequestFailure error={error} />}
      </Modal>

      <Modal
        icon="bi-x-circle"
        inertSiblings
        onClose={() => setRevoking(null)}
        open={revoking !== null}
        portal
        primaryAction={{
          disabled: pending || revoking === null,
          label: pending ? "Revoking…" : "Revoke API key",
          onClick: () => {
            if (revoking !== null) void revoke(revoking.id);
          },
          variant: "danger",
        }}
        size="sm"
        subtitle={revoking === null
          ? ""
          : `Requests using ${revoking.name} will stop immediately. Revocation does not remove prior action attribution.`}
        title="Revoke API key"
      >
        {error === null ? null : <RequestFailure error={error} />}
      </Modal>
    </AdminConsole>
  );
}

/** Shows a newly issued or rotated secret exactly once; every close discards it. */
function SecretModal({
  issued,
  onDiscard,
}: {
  readonly issued: IssuedApiKey | null;
  readonly onDiscard: () => void;
}) {
  const [refused, setRefused] = useState(false);
  useEffect(() => setRefused(false), [issued]);
  if (issued === null) return null;
  return (
    <Modal
      footer={<Button onClick={onDiscard} size="sm">I stored it</Button>}
      icon="bi-key"
      inertSiblings
      onClose={onDiscard}
      open
      portal
      subtitle="This secret is displayed once. Store it in the intended client's secret input or a deployment secret manager. Artifact Server cannot show it again."
      title="Copy API key now"
    >
      <CopyableCode
        code={issued.token}
        copiedLabel="API key copied"
        copyLabel="Copy API key"
        label="API key secret"
        onResult={(copied) => setRefused(!copied)}
      />
      {refused ? (
        <Alert live="assertive" style={{marginTop: 12}} variant="danger">
          The browser did not copy the API key. Select the secret above and copy it manually before closing.
        </Alert>
      ) : null}
    </Modal>
  );
}

const tagListStyle: CSSProperties = {display: "flex", flexWrap: "wrap", gap: 6};
const capabilityGroupStyle: CSSProperties = {display: "flex", flexDirection: "column", gap: 8};
const keyCellStyle: CSSProperties = {display: "inline-flex", flexDirection: "column", lineHeight: 1.3, minWidth: 0};
const prefixStyle: CSSProperties = {color: "var(--text-secondary, #5a6268)", fontFamily: "var(--font-data, monospace)", fontSize: 12};
const detailStackStyle: CSSProperties = {display: "flex", flexDirection: "column", gap: 14};
