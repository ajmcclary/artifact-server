import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

import {ApiError} from "@/api/client";
import {Alert, IconButton, Menu, RecordPanel, RecordTable, Tooltip, type MenuItem} from "@/arkcase";
import {errorMessage} from "@/lib/presentation";
import {useDensity} from "@/ui/density";

/** Container width in px below which a ledger stacks each row into labelled fields. */
export const LEDGER_STACK_BELOW = 640;

/** One ledger cell: its value plus the RecordTable cell treatments the admin screens use. */
export interface LedgerCell {
  readonly mono?: boolean;
  readonly muted?: boolean;
  readonly strong?: boolean;
  readonly value: ReactNode;
}

/**
 * One ledger column. A `field` column keeps its label beside the value when rows stack;
 * an `action` column joins the row's action strip without a label.
 */
export interface LedgerColumn<Row> {
  readonly align: "left" | "right";
  readonly cell: (row: Row) => LedgerCell;
  readonly key: string;
  readonly kind: "action" | "field";
  readonly label: ReactNode;
  readonly width: string;
}

export interface LedgerProps<Row> {
  readonly ariaLabel: string;
  readonly columns: readonly LedgerColumn<Row>[];
  readonly empty?: ReactNode;
  readonly rowKey: (row: Row) => string;
  readonly rows: readonly Row[];
  readonly stackBelow?: number;
}

/**
 * The admin ledger: a DS RecordTable on a wide container, the same rows as stacked,
 * labelled fields on a narrow one. Both forms keep `table`, `row` and `cell` roles and the
 * table's accessible name, so a row is found the same way at 1280 px and 390 px.
 */
export function Ledger<Row>({
  ariaLabel,
  columns,
  empty,
  rowKey,
  rows,
  stackBelow = LEDGER_STACK_BELOW,
}: LedgerProps<Row>) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    if (element === null) return undefined;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const stacked = width !== null && width < stackBelow;
  const keys = rows.map((row) => rowKey(row));
  return (
    <div data-ledger={stacked ? "stacked" : "table"} ref={frame}>
      {stacked ? (
        <StackedLedger ariaLabel={ariaLabel} columns={columns} empty={empty} keys={keys} rows={rows} />
      ) : (
        <RecordTable
          ariaLabel={ariaLabel}
          columns={columns.map((column) => ({
            align: column.align,
            label: column.label,
            width: column.width,
          }))}
          empty={empty}
          rowKey={(cells: readonly LedgerCell[], index: number) => keys[index] ?? String(index)}
          rows={rows.map((row) => columns.map((column) => column.cell(row)))}
        />
      )}
    </div>
  );
}

function StackedLedger<Row>({
  ariaLabel,
  columns,
  empty,
  keys,
  rows,
}: {
  readonly ariaLabel: string;
  readonly columns: readonly LedgerColumn<Row>[];
  readonly empty: ReactNode;
  readonly keys: readonly string[];
  readonly rows: readonly Row[];
}) {
  const fields = columns.filter((column) => column.kind === "field");
  const actions = columns.filter((column) => column.kind === "action");
  return (
    <div aria-label={ariaLabel} role="table">
      <div role="rowgroup">
        {rows.length === 0 && empty !== undefined && empty !== null ? (
          <div role="row">
            <div role="cell" style={stackedEmptyStyle}>{empty}</div>
          </div>
        ) : null}
        {rows.map((row, index) => (
          <div key={keys[index] ?? String(index)} role="row" style={stackedRowStyle}>
            {fields.map((column) => (
              <div key={column.key} role="cell" style={stackedFieldStyle}>
                <span style={stackedLabelStyle}>{column.label}</span>
                <LedgerValue cell={column.cell(row)} />
              </div>
            ))}
            {actions.length === 0 ? null : (
              <div role="cell" style={stackedActionsStyle}>
                {actions.map((column) => <LedgerValue cell={column.cell(row)} key={column.key} />)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LedgerValue({cell}: {readonly cell: LedgerCell}) {
  return (
    <span
      style={{
        color: cell.muted === true ? "var(--text-secondary, #5a6268)" : "var(--text-data, #495057)",
        fontFamily: cell.mono === true ? "var(--font-data, monospace)" : undefined,
        fontSize: "var(--font-size-dense, 13px)",
        fontWeight: cell.strong === true ? 600 : undefined,
        lineHeight: 1.45,
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      {cell.value}
    </span>
  );
}

export interface AdminPanelProps {
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly label: string;
  readonly padded?: boolean;
  readonly subtitle?: ReactNode;
}

/** A RecordPanel exposed as a region named by its cap label. */
export function AdminPanel({actions, children, label, padded = true, subtitle}: AdminPanelProps) {
  return (
    <RecordPanel
      actions={actions}
      aria-label={label}
      label={label}
      padded={padded}
      role="region"
      subtitle={subtitle}
    >
      {children}
    </RecordPanel>
  );
}

/** A vertical run of blocks inside a panel or dialog, 12 px apart. */
export function AdminStack({children}: {readonly children: ReactNode}) {
  return <div style={adminStackStyle}>{children}</div>;
}

/** A wrapping row of buttons that keep their own width. */
export function AdminActions({children}: {readonly children: ReactNode}) {
  return <div style={adminActionsStyle}>{children}</div>;
}

/** Padding for content placed inside an unpadded panel beside a flush ledger. */
export function AdminInset({children}: {readonly children: ReactNode}) {
  return <div style={adminInsetStyle}>{children}</div>;
}

/** A secondary 13 px sentence that qualifies the block it sits in. */
export function AdminNote({children, id}: {readonly children: ReactNode; readonly id?: string}) {
  return <p id={id} style={adminNoteStyle}>{children}</p>;
}

export interface IdentityCellProps {
  readonly badge?: ReactNode;
  readonly detail: ReactNode;
  readonly detailMono?: boolean;
  readonly primary: ReactNode;
}

/** A ledger cell's primary value over its secondary detail, with an optional status badge. */
export function IdentityCell({badge, detail, detailMono = false, primary}: IdentityCellProps) {
  return (
    <span style={identityCellStyle}>
      <span style={identityPrimaryStyle}>
        {primary}
        {badge}
      </span>
      <span
        style={{
          ...identityDetailStyle,
          fontFamily: detailMono ? "var(--font-data, monospace)" : undefined,
        }}
      >
        {detail}
      </span>
    </span>
  );
}

export interface RequestFailureProps {
  readonly error: Error;
  readonly onRetry?: () => void;
}

/** A failed request, stated with the product's operator-facing message and an optional retry. */
export function RequestFailure({error, onRetry}: RequestFailureProps) {
  const density = useDsDensity();
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <Alert
      action={onRetry === undefined ? null : {label: "Try again", onClick: onRetry}}
      density={density}
      title={forbidden ? "Permission required" : "Request failed"}
      variant="danger"
    >
      {errorMessage(error)}
    </Alert>
  );
}

/** The app density mapped onto the DS `density` prop of Alert and FieldGrid. */
export function useDsDensity(): "compact" | "default" {
  return useDensity() === "compact" ? "compact" : "default";
}

/**
 * Native attributes the DS Input forwards to its `<input>` through `...rest`
 * (Input.jsx) but does not declare in Input.d.ts.
 */
export type NativeInputAttributes = Pick<InputHTMLAttributes<HTMLInputElement>, "maxLength" | "min">;

/** Spread into a DS Input to set native attributes its declaration omits. */
export function nativeInputAttributes(attributes: NativeInputAttributes): NativeInputAttributes {
  return attributes;
}

/** The review workspace URL for one artifact. */
export function artifactReviewHref(projectId: string, artifactId: string): string {
  return `/review?${new URLSearchParams({artifact: artifactId, project: projectId})}`;
}

/** Lets a flush link Button in a ledger cell wrap instead of pushing the table wider. */
export const ledgerLinkStyle: CSSProperties = {
  overflowWrap: "anywhere",
  textAlign: "left",
  whiteSpace: "normal",
};

const adminStackStyle: CSSProperties = {display: "flex", flexDirection: "column", gap: 12};
const adminActionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};
const adminInsetStyle: CSSProperties = {padding: 14};
const adminNoteStyle: CSSProperties = {
  color: "var(--text-secondary, #5a6268)",
  fontSize: "var(--font-size-dense, 13px)",
  lineHeight: 1.55,
  margin: 0,
};
const identityCellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};
const identityPrimaryStyle: CSSProperties = {
  alignItems: "center",
  color: "var(--text-body, #212529)",
  display: "flex",
  flexWrap: "wrap",
  fontWeight: 600,
  gap: 6,
  minWidth: 0,
};
const identityDetailStyle: CSSProperties = {
  color: "var(--text-secondary, #5a6268)",
  fontSize: "var(--font-size-xs, 12px)",
  minWidth: 0,
  overflowWrap: "anywhere",
};
const stackedRowStyle: CSSProperties = {
  borderBottom: "1px solid var(--list-divider, #e9ecef)",
  display: "flex",
  flexDirection: "column",
  gap: 7,
  padding: "12px 14px",
};
const stackedFieldStyle: CSSProperties = {
  alignItems: "baseline",
  display: "grid",
  gap: 10,
  gridTemplateColumns: "104px minmax(0, 1fr)",
};
const stackedLabelStyle: CSSProperties = {
  color: "var(--text-secondary, #5a6268)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.025em",
  textTransform: "uppercase",
};
const stackedActionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  paddingTop: 2,
};
const stackedEmptyStyle: CSSProperties = {
  color: "var(--text-secondary, #5a6268)",
  fontSize: "var(--font-size-dense, 13px)",
  padding: "14px 12px",
};

/** The "+" in a list panel's cap that starts the area's create flow. */
export function AddRecordButton({label, onClick}: {readonly label: string; readonly onClick: () => void}) {
  return (
    <Tooltip label={label} placement="bottom">
      <IconButton ariaLabel={label} icon="bi-plus-lg" onClick={onClick} size="sm" variant="primary" />
    </Tooltip>
  );
}

/** A row's kebab and its verbs; destructive verbs still confirm in their own dialog. */
export function RowActionsMenu({items, label}: {readonly items: readonly MenuItem[]; readonly label: string}) {
  const [open, setOpen] = useState(false);
  return (
    <span style={rowMenuAnchorStyle}>
      <IconButton
        ariaLabel={label}
        expanded={open}
        hasPopup="menu"
        icon="bi-three-dots-vertical"
        onClick={() => setOpen((current) => !current)}
        size="sm"
        variant="ghost"
      />
      <Menu align="end" items={[...items]} label={label} onClose={() => setOpen(false)} open={open} width={200} />
    </span>
  );
}

const rowMenuAnchorStyle: CSSProperties = {display: "inline-flex", position: "relative"};
