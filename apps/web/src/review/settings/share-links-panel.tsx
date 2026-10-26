import {useEffect, useState, type CSSProperties} from "react";

import {api, type ShareLinkInventoryPage} from "@/api/client";
import {Alert, Button, Modal} from "@/arkcase";
import {CopyAction} from "@/ui/copy-action";

import {linkSummary, revokeLinkWarning} from "../workspace/share-link-model.ts";
import {
  AdminPanel,
  artifactReviewHref,
  IdentityCell,
  Ledger,
  ledgerLinkStyle,
  RequestFailure,
  RowActionsMenu,
  type LedgerColumn,
} from "./admin-parts.tsx";
import {dateOrDash} from "./admin-areas.ts";

type InventoryLink = ShareLinkInventoryPage["items"][number];

/** Every active share link in the installation, with revoke. Administrators only. */
export function ShareLinksPanel() {
  const [items, setItems] = useState<readonly InventoryLink[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [revoking, setRevoking] = useState<InventoryLink | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  const load = async (cursor: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const [page, projects] = await Promise.all([api.shareLinkInventory(cursor), cursor === null ? api.projects() : null]);
      setItems((current) => cursor === null ? page.items : [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      if (projects !== null) setProjectNames(new Map(projects.map((project) => [project.id, project.name])));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Share links could not load."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(null);
  }, []);

  const revoke = async (link: InventoryLink) => {
    setPending(true);
    setError(null);
    try {
      await api.revokeShareLink(link);
      setItems((current) => current.filter((item) => item.id !== link.id));
      setNotice(`“${link.label}” no longer opens ${link.artifactName}.`);
      setRevoking(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The link could not be revoked."));
    } finally {
      setPending(false);
    }
  };

  const now = new Date().toISOString();
  const columns: readonly LedgerColumn<InventoryLink>[] = [
    {
      align: "left",
      cell: (link) => ({
        value: (
          <IdentityCell
            detail={`${projectNames.get(link.projectId) ?? link.projectId} · ${link.label}`}
            detailMono={false}
            primary={(
              <Button flush href={artifactReviewHref(link.projectId, link.artifactId)} size="sm" style={ledgerLinkStyle} variant="link">
                {link.artifactName}
              </Button>
            )}
          />
        ),
      }),
      key: "artifact",
      kind: "field",
      label: "Artifact",
      width: "minmax(0, 1fr)",
    },
    {
      align: "left",
      cell: (link) => ({value: linkSummary(link, now, null)}),
      key: "permissions",
      kind: "field",
      label: "Permissions",
      width: "minmax(0, 1.4fr)",
    },
    {
      align: "right",
      cell: (link) => ({mono: true, value: String(link.guestCount)}),
      key: "guests",
      kind: "field",
      label: "Guests",
      width: "72px",
    },
    {
      align: "left",
      cell: (link) => ({
        value: (
          <IdentityCell
            detail={link.createdByName}
            detailMono={false}
            primary={<span style={dateStyle}>{dateOrDash(link.createdAt)}</span>}
          />
        ),
      }),
      key: "created",
      kind: "field",
      label: "Created by",
      width: "150px",
    },
    {
      align: "right",
      cell: (link) => ({
        value: (
          <span style={actionsStyle}>
            <CopyAction label={`Copy ${link.label} link`} text={link.url} />
            <RowActionsMenu
              items={[{danger: true, disabled: pending, icon: "bi-x-circle", label: "Revoke", onClick: () => setRevoking(link)}]}
              label={`Actions for ${link.label}`}
            />
          </span>
        ),
      }),
      key: "actions",
      kind: "action",
      label: "",
      width: "96px",
    },
  ];

  return (
    <>
      {error === null ? null : <RequestFailure error={error} onRetry={() => void load(null)} />}
      {notice === null ? null : <Alert title="Share link revoked" variant="success">{notice}</Alert>}
      <AdminPanel
        actions={nextCursor === null ? null : (
          <Button disabled={loading} loading={loading} onClick={() => void load(nextCursor)} outline size="sm" variant="secondary">
            Load more
          </Button>
        )}
        label="Share links"
        padded={false}
        subtitle={loading && items.length === 0 ? "Loading…" : `${items.length} active`}
      >
        <Ledger
          ariaLabel="Share links inventory"
          columns={columns}
          empty="No active share links. Create one from Share on any artifact."
          rowKey={(link) => link.id}
          rows={items}
        />
      </AdminPanel>
      <Modal
        icon="bi-x-circle"
        inertSiblings
        onClose={() => setRevoking(null)}
        open={revoking !== null}
        portal
        primaryAction={{
          disabled: pending,
          label: pending ? "Revoking…" : "Revoke Link",
          onClick: () => {
            if (revoking !== null) void revoke(revoking);
          },
        }}
        size="sm"
        subtitle={revokeLinkWarning}
        title={revoking === null ? "Revoke link?" : `Revoke “${revoking.label}”?`}
      />
    </>
  );
}

const dateStyle: CSSProperties = {fontFamily: "var(--font-data, monospace)", fontWeight: 400};
const actionsStyle: CSSProperties = {alignItems: "center", display: "inline-flex", gap: 4};
