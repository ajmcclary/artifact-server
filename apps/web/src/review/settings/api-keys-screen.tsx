import {useEffect, useId, useState, type CSSProperties} from "react";

import {
  api,
  type InstallationMember,
  type IssuedApiKey,
  type ManagedApiKey,
  type PrincipalCapability,
} from "@/api/client";
import {
  Alert,
  AutoGrid,
  Button,
  Checkbox,
  Eyebrow,
  Input,
  Modal,
  PageScaffold,
  Select,
  StatusPill,
  SurfaceState,
  Tag,
} from "@/arkcase";
import {formatTimestamp} from "@/lib/presentation";
import {CopyableCode} from "@/ui/copyable-code";
import {
  AdminActions,
  AdminPanel,
  AdminStack,
  IdentityCell,
  Ledger,
  nativeInputAttributes,
  RequestFailure,
  type LedgerColumn,
} from "./admin-parts.tsx";

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
  const [apiKeys, setApiKeys] = useState<readonly ManagedApiKey[]>([]);
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
  const [revoking, setRevoking] = useState<ManagedApiKey | null>(null);

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
  const columns: readonly LedgerColumn<ManagedApiKey>[] = [
    {
      align: "left",
      cell: (apiKey) => ({
        value: (
          <IdentityCell
            badge={(
              <StatusPill
                label={apiKey.revokedAt === null ? "Active" : "Revoked"}
                tone={apiKey.revokedAt === null ? "success" : "danger"}
              />
            )}
            detail={apiKey.prefix}
            detailMono
            primary={apiKey.name}
          />
        ),
      }),
      key: "key",
      kind: "field",
      label: "Key",
      width: "minmax(0, 1.2fr)",
    },
    {
      align: "left",
      cell: (apiKey) => ({
        value: (
          <span style={tagListStyle}>
            {apiKey.capabilities.map((capability) => <Tag key={capability}>{capability}</Tag>)}
          </span>
        ),
      }),
      key: "capabilities",
      kind: "field",
      label: "Capabilities",
      width: "minmax(0, 1.5fr)",
    },
    {
      align: "left",
      cell: (apiKey) => ({mono: true, muted: true, value: formatTimestamp(apiKey.expiresAt)}),
      key: "expires",
      kind: "field",
      label: "Expires",
      width: "170px",
    },
    {
      align: "right",
      cell: (apiKey) => ({
        value: apiKey.revokedAt === null ? (
          <AdminActions>
            <Button
              disabled={pending}
              icon="bi-arrow-repeat"
              onClick={() => void rotate(apiKey.id)}
              outline
              size="sm"
              variant="secondary"
            >
              Rotate
            </Button>
            <Button
              danger
              disabled={pending}
              onClick={() => setRevoking(apiKey)}
              size="sm"
              variant="ghost"
            >
              Revoke
            </Button>
          </AdminActions>
        ) : "",
      }),
      key: "actions",
      kind: "action",
      label: "",
      width: "200px",
    },
  ];
  const activeCount = apiKeys.filter((apiKey) => apiKey.revokedAt === null).length;

  return (
    <PageScaffold
      actions={(
        <Button icon="bi-key" onClick={() => setIssueOpen(true)} size="sm">
          Issue API key
        </Button>
      )}
      count={loading && apiKeys.length === 0 ? null : `${activeCount} active`}
      meta="Managed API keys have explicit capabilities, a required expiration, and revocation. Secrets are never shown again."
      title="API keys"
    >
      {error === null || issueOpen || revoking !== null
        ? null
        : <RequestFailure error={error} onRetry={() => void load()} />}
      {loading && apiKeys.length === 0 ? (
        <SurfaceState loadingTitle="Loading API keys" noun="API keys" phase="loading" skeleton={3} />
      ) : apiKeys.length === 0 ? (
        <SurfaceState
          count={0}
          emptyBody="Issue a scoped key for automation or a compatible self-hosted MCP client."
          emptyIcon="bi-key"
          emptyTitle="No managed API keys"
          noun="API keys"
          phase="ready"
          titleLevel={3}
        />
      ) : (
        <AdminPanel label="Managed keys" padded={false} subtitle={`${activeCount} active`}>
          <Ledger
            ariaLabel="Managed API keys"
            columns={columns}
            rowKey={(apiKey) => apiKey.id}
            rows={apiKeys}
          />
        </AdminPanel>
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
    </PageScaffold>
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
