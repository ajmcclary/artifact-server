import {useEffect, useMemo, useState, type CSSProperties} from "react";

import {
  api,
  type MakePublicLinkPrivateItem,
  type PublicLinkItem,
  type PublicLinkMutationResult,
  type PublicLinkPage,
} from "@/api/client";
import {Alert, Button, Checkbox, Modal, StatusPill, SurfaceState} from "@/arkcase";
import {errorMessage} from "@/lib/presentation";
import {CopyAction} from "@/ui/copy-action";
import {
  AdminActions,
  AdminNote,
  AdminPanel,
  AdminStack,
  artifactReviewHref,
  IdentityCell,
  Ledger,
  ledgerLinkStyle,
  RequestFailure,
  RowActionsMenu,
  useDsDensity,
  type LedgerColumn,
} from "./admin-parts.tsx";
import {AdminConsole} from "./admin-console.tsx";
import {dateOrDash} from "./admin-areas.ts";

const maximumBulkSize = 100;

type FailedMutationResult = Extract<
  PublicLinkMutationResult,
  {readonly status: "failed"}
>;

interface FailedMutation {
  readonly command: MakePublicLinkPrivateItem;
  readonly item: PublicLinkItem;
  readonly result: FailedMutationResult;
}

/** Administrator-only cross-project inventory and shutdown surface for public links. */
export function PublicLinksScreen() {
  const density = useDsDensity();
  const [pages, setPages] = useState<readonly PublicLinkPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [confirmation, setConfirmation] = useState<readonly PublicLinkItem[]>([]);
  const [failures, setFailures] = useState<readonly FailedMutation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  const loadedItems = useMemo(
    () => pages.flatMap((page) => page.publicLinks),
    [pages],
  );
  const currentPage = pages[pageIndex] ?? null;
  const visibleItems = currentPage?.publicLinks ?? [];
  const selectedItems = loadedItems.filter((item) =>
    selectedKeys.has(selectionKey(item))
  );
  const fullyLoaded = pages.length > 0 && pages.at(-1)?.nextCursor === null;
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((item) =>
    selectedKeys.has(selectionKey(item))
  );

  const loadFirstPage = async () => {
    setLoading(true);
    setError(null);
    try {
      const firstPage = await api.publicLinks(null);
      setPages([firstPage]);
      setPageIndex(0);
      setSelectedKeys(new Set());
      setFailures([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Public-link inventory failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFirstPage();
  }, []);

  const showNextPage = async () => {
    const cached = pages[pageIndex + 1];
    if (cached !== undefined) {
      setPageIndex((current) => current + 1);
      return;
    }
    if (currentPage?.nextCursor === null || currentPage === null) return;
    setLoading(true);
    setError(null);
    try {
      const nextPage = await api.publicLinks(currentPage.nextCursor);
      setPages((current) => [...current, nextPage]);
      setPageIndex((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Public-link page failed."));
    } finally {
      setLoading(false);
    }
  };

  const selectItems = (items: readonly PublicLinkItem[], checked: boolean) => {
    setSelectionMessage(null);
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const item of items) {
        const key = selectionKey(item);
        if (!checked) {
          next.delete(key);
          continue;
        }
        if (next.size >= maximumBulkSize && !next.has(key)) {
          setSelectionMessage(
            `Bulk changes are limited to ${maximumBulkSize} public links. Clear part of the selection before adding more.`,
          );
          break;
        }
        next.add(key);
      }
      return next;
    });
  };

  const removeItems = (keys: ReadonlySet<string>) => {
    setPages((current) => current.map((page) => ({
      ...page,
      publicLinks: page.publicLinks.filter((item) => !keys.has(selectionKey(item))),
    })));
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  };

  const executeMutation = async (
    items: readonly PublicLinkItem[],
    commands: readonly MakePublicLinkPrivateItem[],
    retainedFailures: readonly FailedMutation[] = [],
  ) => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.makePublicLinksPrivate(commands);
      const itemByKey = new Map(items.map((item) => [selectionKey(item), item]));
      const commandByKey = new Map(commands.map((command) => [commandKey(command), command]));
      const succeeded = new Set<string>();
      const nextFailures: FailedMutation[] = [...retainedFailures];
      for (const result of response.results) {
        const key = resultKey(result);
        if (result.status === "made_private") {
          succeeded.add(key);
          continue;
        }
        const item = itemByKey.get(key);
        const command = commandByKey.get(key);
        if (item === undefined || command === undefined) {
          throw new Error("A public-link mutation result did not match its bounded request.");
        }
        nextFailures.push({command, item, result});
      }
      removeItems(succeeded);
      setFailures(nextFailures);
      setSelectedKeys(new Set(nextFailures.map(({item}) => selectionKey(item))));
      if (response.summary.succeeded > 0) {
        setNotice(
          `${response.summary.succeeded} public ${response.summary.succeeded === 1 ? "link is" : "links are"} now private. ${response.warning}`,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Making public links private failed."));
    } finally {
      setPending(false);
    }
  };

  const confirmMutation = async () => {
    const items = confirmation;
    setConfirmation([]);
    await executeMutation(items, items.map(makePrivateCommand));
  };

  const retryFailures = async () => {
    const retained = failures.filter(({result}) =>
      result.retry === "not_retryable"
    );
    const retryable = failures.filter(({result}) =>
      result.retry !== "not_retryable"
    );
    setPending(true);
    setError(null);
    try {
      const prepared = await Promise.all(retryable.map(async (failure) => {
        if (failure.result.retry === "same_command") return failure;
        const details = await api.artifact(
          failure.item.project.id,
          failure.item.artifact.id,
        );
        if (details.artifact.accessSetting === "account_required") {
          return {alreadyPrivate: failure.item} as const;
        }
        return {
          command: {
            ...failure.command,
            expectedCurrentVersionId: details.artifact.currentVersionId,
            idempotencyKey: crypto.randomUUID(),
          },
          item: {
            ...failure.item,
            artifact: details.artifact,
            currentVersion: details.current.version,
          },
        } as const;
      }));
      const alreadyPrivate = new Set(prepared.flatMap((entry) =>
        "alreadyPrivate" in entry ? [selectionKey(entry.alreadyPrivate)] : []
      ));
      removeItems(alreadyPrivate);
      const ready = prepared.flatMap((entry) =>
        "alreadyPrivate" in entry ? [] : [entry]
      );
      if (ready.length === 0) {
        setFailures(retained);
        if (alreadyPrivate.size > 0) {
          setNotice("The remaining public links were already private when their current state was refreshed.");
        }
        return;
      }
      await executeMutation(
        ready.map(({item}) => item),
        ready.map(({command}) => command),
        retained,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Retrying public links failed."));
    } finally {
      setPending(false);
    }
  };

  if (loading && pages.length === 0) {
    return (
      <AdminConsole administrator area="publicLinks">
        <SurfaceState loadingTitle="Loading public links" noun="public links" phase="loading" skeleton={3} />
      </AdminConsole>
    );
  }
  if (error !== null && pages.length === 0) {
    return (
      <AdminConsole administrator area="publicLinks">
        <SurfaceState
          failedBody={errorMessage(error)}
          failedTitle="Public links could not load"
          noun="public links"
          onRetry={() => void loadFirstPage()}
          phase="failed"
        />
      </AdminConsole>
    );
  }

  const reloadButton = (
    <Button icon="bi-arrow-counterclockwise" onClick={() => void loadFirstPage()} outline size="sm" variant="secondary">
      Reload
    </Button>
  );
  const columns: readonly LedgerColumn<PublicLinkItem>[] = [
    {
      align: "left",
      cell: (item) => ({
        value: (
          <Checkbox
            aria-label={`Select ${item.artifact.name}`}
            checked={selectedKeys.has(selectionKey(item))}
            onChange={(event) => selectItems([item], event.currentTarget.checked)}
          />
        ),
      }),
      key: "select",
      kind: "action",
      label: (
        <Checkbox
          aria-label="Select all visible public links"
          checked={allVisibleSelected}
          onChange={(event) => selectItems(visibleItems, event.currentTarget.checked)}
        />
      ),
      width: "44px",
    },
    {
      align: "left",
      cell: (item) => ({
        value: (
          <IdentityCell
            badge={item.project.archivedAt === null ? null : <StatusPill label="Archived" tone="neutral" />}
            detail={item.project.name}
            primary={(
              <Button flush href={artifactReviewHref(item.project.id, item.artifact.id)} size="sm" style={ledgerLinkStyle} variant="link">
                {item.artifact.name}
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
      align: "right",
      cell: (item) => ({mono: true, value: `v${item.currentVersion.number}`}),
      key: "version",
      kind: "field",
      label: "Version",
      width: "80px",
    },
    {
      align: "left",
      cell: (item) => ({
        value: (
          <span style={linkCellStyle}>
            <Button flush href={item.links.public} size="sm" style={publicUrlStyle} target="_blank" title={item.links.public} variant="link">
              {item.links.public}
            </Button>
            <CopyAction label={`Copy link to ${item.artifact.name}`} text={item.links.public} />
          </span>
        ),
      }),
      key: "link",
      kind: "field",
      label: "Link",
      width: "minmax(0, 1.4fr)",
    },
    {
      align: "left",
      cell: (item) => ({
        value: (
          <IdentityCell
            detail={item.madePublicBy?.name ?? "—"}
            detailMono={false}
            primary={<span style={{fontFamily: "var(--font-data, monospace)", fontWeight: 400}}>{dateOrDash(item.madePublicAt)}</span>}
          />
        ),
      }),
      key: "madePublic",
      kind: "field",
      label: "Made public",
      width: "150px",
    },
    {
      align: "right",
      cell: (item) => ({
        value: (
          <RowActionsMenu
            items={[{danger: true, disabled: pending, icon: "bi-lock", label: "Make private", onClick: () => setConfirmation([item])}]}
            label={`Actions for ${item.artifact.name}`}
          />
        ),
      }),
      key: "actions",
      kind: "action",
      label: "",
      width: "56px",
    },
  ];

  return (
    <AdminConsole administrator area="publicLinks">
      {error === null ? null : <RequestFailure error={error} onRetry={() => void loadFirstPage()} />}
      {notice === null ? null : (
        <Alert density={density} title="Public access changed" variant="success">{notice}</Alert>
      )}
      {failures.length === 0 ? null : (
        <Alert
          action={failures.some(({result}) => result.retry !== "not_retryable")
            ? {
              disabled: pending,
              label: pending ? "Retrying…" : "Retry failed",
              onClick: () => void retryFailures(),
              outline: true,
              variant: "danger",
            }
            : null}
          density={density}
          title={`${failures.length} ${failures.length === 1 ? "link was" : "links were"} not changed`}
          variant="danger"
        >
          <ul style={failureListStyle}>
            {failures.map(({item, result}) => (
              <li key={selectionKey(item)}>
                {item.project.name} / {item.artifact.name}: {result.error.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {loadedItems.length === 0 && fullyLoaded ? (
        <SurfaceState
          count={0}
          emptyBody="No active artifact in this installation currently allows public-link access."
          emptyIcon="bi-lock"
          emptyTitle="No public links"
          noun="public links"
          phase="ready"
          titleLevel={2}
        />
      ) : (
        <>
          <AdminPanel label="Bulk selection" subtitle={`${selectedItems.length} selected · maximum ${maximumBulkSize}`}>
            <AdminStack>
              <AdminActions>
                <Button
                  disabled={visibleItems.length === 0}
                  onClick={() => selectItems(visibleItems, true)}
                  outline
                  size="sm"
                  variant="secondary"
                >
                  Select visible ({visibleItems.length})
                </Button>
                <Button
                  disabled={loadedItems.length === 0 || loadedItems.length > maximumBulkSize}
                  onClick={() => selectItems(loadedItems, true)}
                  outline
                  size="sm"
                  variant="secondary"
                >
                  {fullyLoaded ? "Select all" : "Select all loaded"} ({loadedItems.length})
                </Button>
                <Button
                  disabled={selectedKeys.size === 0}
                  onClick={() => setSelectedKeys(new Set())}
                  size="sm"
                  variant="ghost"
                >
                  Clear selection
                </Button>
                <Button
                  disabled={pending || selectedItems.length === 0}
                  icon="bi-lock"
                  onClick={() => setConfirmation(selectedItems)}
                  size="sm"
                >
                  Make {selectedItems.length} private
                </Button>
              </AdminActions>
              <AdminNote>
                {fullyLoaded
                  ? "All inventory pages are loaded, so Select all covers every listed public link."
                  : "More inventory pages exist. Select all loaded never includes pages you have not visited."}
                {loadedItems.length > maximumBulkSize
                  ? ` Select visible or choose up to ${maximumBulkSize} links for one bulk change.`
                  : ""}
              </AdminNote>
              {selectionMessage === null ? null : (
                <Alert density={density} live="assertive" variant="warning">{selectionMessage}</Alert>
              )}
            </AdminStack>
          </AdminPanel>

          <AdminPanel actions={reloadButton} label="Public links" padded={false} subtitle={`${loadedItems.length} loaded`}>
            <Ledger
              ariaLabel="Public links inventory"
              columns={columns}
              empty={currentPage?.nextCursor === null
                ? "Every public link on this page is now private. Return to a previous page to inspect the remaining loaded links."
                : "Every public link on this loaded page is now private. Continue to the next page to inspect older public links."}
              rowKey={selectionKey}
              rows={visibleItems}
            />
          </AdminPanel>

          <nav aria-label="Public links pagination" style={paginationStyle}>
            <Button
              disabled={loading || pageIndex === 0}
              onClick={() => setPageIndex((current) => current - 1)}
              outline
              size="sm"
              variant="secondary"
            >
              Previous
            </Button>
            <span style={pageLabelStyle}>Page {pageIndex + 1}</span>
            <Button
              disabled={loading || currentPage?.nextCursor === null}
              loading={loading}
              onClick={() => void showNextPage()}
              outline
              size="sm"
              variant="secondary"
            >
              Next
            </Button>
          </nav>
        </>
      )}

      <Modal
        icon="bi-lock"
        inertSiblings
        onClose={() => setConfirmation([])}
        open={confirmation.length > 0}
        portal
        primaryAction={{
          disabled: pending,
          label: pending ? "Making private…" : "Make private",
          onClick: () => void confirmMutation(),
        }}
        size="sm"
        subtitle="New requests to successful items will require an admitted account. Copies already downloaded or cached outside Artifact Server cannot be recalled."
        title={`Make ${confirmation.length} public ${confirmation.length === 1 ? "link" : "links"} private?`}
      >
        <AdminNote>
          Each item is checked against the current version shown when you selected it. If an
          artifact changed, that item fails without changing its access and can be retried after
          refreshing its version.
        </AdminNote>
      </Modal>
    </AdminConsole>
  );
}

function makePrivateCommand(item: PublicLinkItem): MakePublicLinkPrivateItem {
  return {
    artifactId: item.artifact.id,
    expectedCurrentVersionId: item.artifact.currentVersionId,
    idempotencyKey: crypto.randomUUID(),
    projectId: item.project.id,
  };
}

function selectionKey(item: PublicLinkItem): string {
  return `${item.project.id}\0${item.artifact.id}`;
}

function commandKey(command: MakePublicLinkPrivateItem): string {
  return `${command.projectId}\0${command.artifactId}`;
}

function resultKey(result: PublicLinkMutationResult): string {
  return `${result.projectId}\0${result.artifactId}`;
}

const linkCellStyle: CSSProperties = {alignItems: "center", display: "inline-flex", gap: 6, minWidth: 0};
const publicUrlStyle: CSSProperties = {
  display: "inline-block",
  fontWeight: 400,
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  verticalAlign: "bottom",
  whiteSpace: "nowrap",
};
const failureListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  margin: "6px 0 0",
  paddingLeft: 20,
};
const paginationStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 8,
  justifyContent: "space-between",
};
const pageLabelStyle: CSSProperties = {
  color: "var(--text-secondary, #5a6268)",
  fontSize: "var(--font-size-dense, 13px)",
};
