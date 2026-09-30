import {type CSSProperties, useEffect, useId, useRef, useState} from "react";
import {z} from "zod";

import {api, type AgentDispatch, type AgentPresence} from "@/api/client";
import {
  Alert,
  Button,
  Checkbox,
  DiscardDialog,
  Modal,
  Popover,
  SelectableRow,
  Spinner,
  Textarea,
} from "@/arkcase";
import type {DispatchBundle} from "@/components/dispatch/dispatch-bundle";
import {
  maximumDispatchBundleSize,
  maximumDispatchNoteCharacters,
} from "@/components/dispatch/dispatch-limits";
import type {DispatchFeedback} from "@/components/dispatch/dispatch-toast";
import {PresenceGlyph, presenceRing} from "@/components/dispatch/presence-avatar";
import {errorMessage, formatRelativeTime} from "@/lib/presentation";
import {readStored, removeStored, writeStored} from "@/lib/safe-storage";

function annotationCount(count: number): string {
  return count === 1 ? "1 annotation" : `${count} annotations`;
}

function defaultAgentStorageKey(principalId: string, projectId: string): string {
  return `dispatch-default:${principalId}:${projectId}`;
}

interface RememberedAgent {
  readonly displayName: string;
  readonly id: string;
}

interface RememberedAgentPreference {
  readonly agent: RememberedAgent | null;
  readonly storageKey: string;
}

const rememberedAgentSchema = z.object({
  displayName: z.string().min(1),
  id: z.string().min(1),
});

function readRememberedAgent(storageKey: string): RememberedAgent | null {
  const stored = readStored("local", storageKey);
  if (stored === null) return null;
  try {
    const parsed = rememberedAgentSchema.safeParse(JSON.parse(stored));
    if (parsed.success) return parsed.data;
  } catch {
    // Invalid local convenience state is disposable; it is never authority.
  }
  removeStored("local", storageKey);
  return null;
}

function dispatchBatches(threadIds: readonly string[]): readonly (readonly string[])[] {
  return Array.from(
    {length: Math.ceil(threadIds.length / maximumDispatchBundleSize)},
    (_, index) => threadIds.slice(
      index * maximumDispatchBundleSize,
      (index + 1) * maximumDispatchBundleSize,
    ),
  );
}

interface DispatchAttemptResult {
  readonly dispatches: readonly AgentDispatch[];
  readonly failure: Error | null;
}

async function createDispatchBatches(
  projectId: string,
  agentId: string,
  note: string | null,
  batches: readonly (readonly string[])[],
  idempotencyKeys: readonly string[],
  index = 0,
  created: readonly AgentDispatch[] = [],
): Promise<DispatchAttemptResult> {
  const threadIds = batches[index];
  if (threadIds === undefined) return {dispatches: created, failure: null};
  try {
    const result = await api.createAgentDispatch(
      projectId,
      {agentId, note, threadIds},
      idempotencyKeys[index] ?? crypto.randomUUID(),
    );
    return createDispatchBatches(
      projectId,
      agentId,
      note,
      batches,
      idempotencyKeys,
      index + 1,
      [...created, result.dispatch],
    );
  } catch (caught) {
    return {
      dispatches: created,
      failure: caught instanceof Error ? caught : new Error("Sending failed."),
    };
  }
}

const controlStyle = {alignItems: "center", display: "inline-flex", flexWrap: "wrap", gap: 8, minWidth: 0} satisfies CSSProperties;
const splitStyle = {display: "inline-flex", minWidth: 0} satisfies CSSProperties;
const mainButtonStyle = {borderBottomRightRadius: 0, borderTopRightRadius: 0, gap: 6, maxWidth: "100%", minWidth: 0} satisfies CSSProperties;
const caretButtonStyle = {borderBottomLeftRadius: 0, borderTopLeftRadius: 0, marginLeft: -1} satisfies CSSProperties;
const labelStyle = {minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"} satisfies CSSProperties;
const reasonStyle = {color: "var(--text-secondary)", fontSize: "var(--font-size-xs, 12px)"} satisfies CSSProperties;
const agentRowStyle = {alignItems: "center", display: "flex", gap: 10, textAlign: "left", width: "100%"} satisfies CSSProperties;
const agentTextStyle = {display: "flex", flexDirection: "column", minWidth: 0} satisfies CSSProperties;
const blockStyle = {display: "block", fontSize: "var(--font-size-sm, 14px)"} satisfies CSSProperties;
const pathStyle = {color: "var(--text-secondary)", display: "block", fontFamily: "var(--font-data)", fontSize: 12, overflowWrap: "anywhere"} satisfies CSSProperties;
const fieldsetStyle = {border: 0, display: "flex", flexDirection: "column", gap: 10, margin: 0, padding: 0} satisfies CSSProperties;
const legendStyle = {fontSize: "var(--font-size-label, 11px)", fontWeight: 600, letterSpacing: ".06em", marginBottom: 6, textTransform: "uppercase"} satisfies CSSProperties;
const choiceStyle = {alignItems: "flex-start", display: "inline-flex", gap: 10} satisfies CSSProperties;
const bodyTextStyle = {color: "var(--text-secondary)", fontSize: "var(--font-size-sm, 14px)", margin: 0} satisfies CSSProperties;
const footerStyle = {display: "flex", gap: 8, justifyContent: "flex-end"} satisfies CSSProperties;

/**
 * Send one exact annotation set to an agent with an honest tier-aware control.
 *
 * The remembered destination is a per-principal, per-project convenience. A
 * disconnected remembered agent disables the main action instead of silently
 * choosing another. The caret remains available to pick a connected agent or
 * add the optional bundle note. Sets above the server's per-dispatch bound are
 * split into ordered batches while one human click remains the initiating act.
 */
export function SendToAgentControl({
  agents,
  buttonSize = "xs",
  buttonVariant = "outline",
  feedback,
  label,
  onSent,
  oneAgentLabel,
  openCount,
  principalId,
  projectId,
  reasonDisplay = "inline",
  resolveBundle,
}: {
  /** The polled presence list, or null while the surface is reading it. */
  readonly agents: readonly AgentPresence[] | null;
  readonly buttonSize?: "sm" | "xs";
  readonly buttonVariant?: "outline" | "primary";
  readonly feedback: DispatchFeedback;
  /** Label used before the first destination is chosen. */
  readonly label: string;
  readonly onSent: () => Promise<void>;
  /** Exact number of open, undispatched annotations represented. */
  readonly openCount: number;
  readonly oneAgentLabel?: (name: string) => string;
  readonly principalId: string;
  readonly projectId: string;
  /** Whether this control repeats its disabled-state explanation beside the buttons. */
  readonly reasonDisplay?: "hidden" | "inline";
  readonly resolveBundle: () => Promise<DispatchBundle>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [quickPending, setQuickPending] = useState(false);
  const [dialogAgents, setDialogAgents] = useState<readonly AgentPresence[]>([]);
  const [bundle, setBundle] = useState<DispatchBundle | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [discardOpen, setDiscardOpen] = useState(false);
  const attemptKeys = useRef<readonly string[]>([]);
  const dialogId = useId();
  const storageKey = defaultAgentStorageKey(principalId, projectId);
  const [rememberedPreference, setRememberedPreference] =
    useState<RememberedAgentPreference>(() => ({
      agent: readRememberedAgent(storageKey),
      storageKey,
    }));

  useEffect(() => {
    setRememberedPreference({
      agent: readRememberedAgent(storageKey),
      storageKey,
    });
  }, [storageKey]);

  const rememberedDefault = rememberedPreference.storageKey === storageKey
    ? rememberedPreference.agent
    : null;
  const knownConnected = agents?.filter((agent) => agent.connected) ?? null;
  const rememberedAgent = agents?.find((agent) => agent.id === rememberedDefault?.id) ?? null;
  const rememberedDefaultMissing = agents !== null
    && rememberedDefault !== null
    && rememberedAgent === null;

  useEffect(() => {
    if (!rememberedDefaultMissing) return;
    removeStored("local", storageKey);
    setRememberedPreference({agent: null, storageKey});
  }, [rememberedDefaultMissing, storageKey]);

  const mainAgent = rememberedAgent?.connected === true
    ? rememberedAgent
    : (rememberedDefault === null || rememberedDefaultMissing)
        && knownConnected?.length === 1
      ? knownConnected[0] ?? null
      : null;
  const disconnectedDefaultName = rememberedAgent !== null && !rememberedAgent.connected
    ? rememberedAgent.displayName
    : null;
  const noAgents = knownConnected !== null && knownConnected.length === 0;
  const nothingToSend = openCount === 0;
  const mainReason = nothingToSend
    ? "Nothing open to send."
    : disconnectedDefaultName !== null
      ? `${disconnectedDefaultName} disconnected — pick another`
      : noAgents
        ? "No agent connected — connect one to send."
        : null;
  const mainLabel = mainAgent === null
    ? disconnectedDefaultName === null || oneAgentLabel === undefined
      ? label
      : oneAgentLabel(disconnectedDefaultName)
    : oneAgentLabel === undefined
      ? label
      : oneAgentLabel(mainAgent.displayName);
  const trimmedNote = note.trim();
  const noteTooLong = trimmedNote.length > maximumDispatchNoteCharacters;
  const connectedDialogAgents = dialogAgents.filter((agent) => agent.connected);
  const threadIds = bundle?.threadIds ?? [];

  const rememberAgent = (agent: AgentPresence): void => {
    const next = {displayName: agent.displayName, id: agent.id};
    writeStored("local", storageKey, JSON.stringify(next));
    setRememberedPreference({agent: next, storageKey});
  };

  const reportAttempt = async (
    agent: AgentPresence,
    resolved: DispatchBundle,
    result: DispatchAttemptResult,
  ): Promise<void> => {
    if (result.dispatches.length > 0) {
      rememberAgent(agent);
      const sentCount = result.dispatches.reduce(
        (count, dispatch) => count + dispatch.threadIds.length,
        0,
      );
      if (result.failure === null) {
        feedback.sent({agent, dispatches: result.dispatches});
      } else {
        feedback.sent({
          agent,
          dispatches: result.dispatches,
          incompleteCount: resolved.threadIds.length - sentCount,
        });
      }
      await onSent();
      return;
    }
    feedback.sendFailed(result.failure ?? new Error("Sending failed."));
  };

  const dispatchTo = async (
    agent: AgentPresence,
    resolved: DispatchBundle,
    dispatchNote: string | null,
    keys: readonly string[],
  ): Promise<void> => {
    const result = await createDispatchBatches(
      projectId,
      agent.id,
      dispatchNote,
      dispatchBatches(resolved.threadIds),
      keys,
    );
    await reportAttempt(agent, resolved, result);
  };

  const quickSend = async (agent: AgentPresence): Promise<void> => {
    setQuickPending(true);
    try {
      const resolved = await resolveBundle();
      if (resolved.threadIds.length === 0) {
        feedback.sendFailed(new Error("Nothing open to send."));
        return;
      }
      await dispatchTo(
        agent,
        resolved,
        null,
        dispatchBatches(resolved.threadIds).map(() => crypto.randomUUID()),
      );
    } catch (caught) {
      feedback.sendFailed(
        caught instanceof Error ? caught : new Error("Sending failed."),
      );
    } finally {
      setQuickPending(false);
    }
  };

  const prepareNote = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    attemptKeys.current = [];
    try {
      const [listedAgents, resolved] = await Promise.all([
        api.agentPresence(),
        resolveBundle(),
      ]);
      setDialogAgents(listedAgents);
      setBundle(resolved);
      const preferred = listedAgents.find((agent) =>
        agent.id === rememberedDefault?.id && agent.connected
      ) ?? listedAgents.find((agent) => agent.connected) ?? null;
      setAgentId(preferred?.id ?? null);
      setNow(Date.now());
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Agent loading failed."),
      );
    } finally {
      setLoading(false);
    }
  };

  const changeNoteOpen = (nextOpen: boolean): void => {
    setNoteOpen(nextOpen);
    if (nextOpen) {
      void prepareNote();
      return;
    }
    setDialogAgents([]);
    setBundle(null);
    setAgentId(null);
    setNote("");
    setError(null);
    attemptKeys.current = [];
  };

  const sendWithNote = async (): Promise<void> => {
    const chosen = dialogAgents.find((agent) =>
      agent.id === agentId && agent.connected
    ) ?? null;
    if (chosen === null || bundle === null || threadIds.length === 0 || noteTooLong) return;
    const batches = dispatchBatches(threadIds);
    if (attemptKeys.current.length !== batches.length) {
      attemptKeys.current = batches.map(() => crypto.randomUUID());
    }
    setPending(true);
    setError(null);
    try {
      await dispatchTo(
        chosen,
        bundle,
        trimmedNote === "" ? null : trimmedNote,
        attemptKeys.current,
      );
      changeNoteOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Sending failed."));
    } finally {
      setPending(false);
    }
  };

  const requestNoteClose = (): void => {
    if (pending) return;
    if (note.trim() !== "") {
      setDiscardOpen(true);
      return;
    }
    changeNoteOpen(false);
  };

  const menuAgents = knownConnected?.filter((agent) =>
    mainAgent === null || agent.id !== mainAgent.id
  ) ?? [];
  const caretDisabled = agents === null || noAgents || nothingToSend || quickPending;

  const variant = buttonVariant === "outline" ? "secondary" : "primary";
  const outline = buttonVariant === "outline";

  return (
    <div style={controlStyle}>
      <div style={splitStyle}>
        <Button
          aria-busy={quickPending || agents === null}
          disabled={mainAgent === null || mainReason !== null || quickPending}
          onClick={() => {
            if (mainAgent !== null) void quickSend(mainAgent);
          }}
          outline={outline}
          size={buttonSize}
          style={mainButtonStyle}
          variant={variant}
        >
          {agents === null ? (
            <span aria-hidden="true"><Spinner size={12} /></span>
          ) : mainAgent === null ? null : (
            <PresenceGlyph kind={mainAgent.kind} ring={presenceRing(mainAgent)} />
          )}
          <span style={labelStyle}>{quickPending ? "Sending…" : mainLabel}</span>
        </Button>
        <Popover
          contentStyle={{gap: 4, padding: 6}}
          label="Choose an agent"
          onOpenChange={setMenuOpen}
          open={menuOpen}
          placement="bottom-end"
          trigger={(
            <Button
              aria-label="Choose agent or send with a note"
              disabled={caretDisabled}
              icon="bi-chevron-down"
              outline={outline}
              size={buttonSize}
              style={caretButtonStyle}
              variant={variant}
            />
          )}
          width={320}
        >
          {menuAgents.map((agent) => (
            <SelectableRow
              as="button"
              key={agent.id}
              onSelect={() => {
                setMenuOpen(false);
                void quickSend(agent);
              }}
              padding="8px 10px"
              style={agentRowStyle}
            >
              <PresenceGlyph kind={agent.kind} ring={presenceRing(agent)} />
              <span style={agentTextStyle}>
                <strong style={blockStyle}>{agent.displayName}</strong>
                <span style={pathStyle}>{agent.workingDirectory}</span>
              </span>
            </SelectableRow>
          ))}
          <Button
            block
            onClick={() => {
              setMenuOpen(false);
              changeNoteOpen(true);
            }}
            size="sm"
            variant="ghost"
          >
            Send with a note…
          </Button>
        </Popover>
      </div>
      {mainReason === null || reasonDisplay === "hidden" ? null : (
        <span role="status" style={reasonStyle}>{mainReason}</span>
      )}

      <Modal
        footer={(
          <div style={footerStyle}>
            <Button disabled={pending} onClick={requestNoteClose} outline size="sm" variant="secondary">Cancel</Button>
            {connectedDialogAgents.length === 0 ? null : (
              <Button
                disabled={pending || loading || agentId === null || threadIds.length === 0 || noteTooLong}
                onClick={() => void sendWithNote()}
                size="sm"
              >
                {pending ? "Sending…" : `Send ${annotationCount(threadIds.length)}`}
              </Button>
            )}
          </div>
        )}
        onClose={requestNoteClose}
        open={noteOpen}
        portal
        size="md"
        subtitle="The annotations in this send leave the open list when it succeeds. Undo can call them back while the agent has not completed the send."
        title="Send with a note"
      >
        {error === null ? null : <Alert variant="danger">{errorMessage(error)}</Alert>}
        {loading ? (
          <p style={bodyTextStyle}>Reading connected agents…</p>
        ) : connectedDialogAgents.length === 0 ? (
          <p style={bodyTextStyle}>No agent connected — connect one to send.</p>
        ) : (
          <>
            <fieldset style={fieldsetStyle}>
              <legend style={legendStyle}>Connected agents</legend>
              {dialogAgents.map((agent) => (
                <Checkbox
                  checked={agentId === agent.id}
                  disabled={!agent.connected || pending}
                  key={agent.id}
                  label={(
                    <span style={choiceStyle}>
                      <PresenceGlyph kind={agent.kind} ring={presenceRing(agent)} />
                      <span style={agentTextStyle}>
                        <strong style={blockStyle}>{agent.displayName}</strong>
                        <span style={pathStyle}>{agent.workingDirectory}</span>
                        <span style={reasonStyle}>
                          {agent.connected
                            ? "Connected"
                            : `Not connected, last seen ${formatRelativeTime(agent.lastSeenAt, now)}`}
                        </span>
                      </span>
                    </span>
                  )}
                  name={`${dialogId}-agent`}
                  onChange={() => {
                    setAgentId(agent.id);
                    attemptKeys.current = [];
                  }}
                  radio
                />
              ))}
            </fieldset>
            <Textarea
              disabled={pending}
              label="Note for the agent"
              onChange={(event) => setNote(event.currentTarget.value)}
              placeholder="Optional context for the whole bundle."
              value={note}
            />
            {noteTooLong ? (
              <Alert variant="danger">
                {`A note holds at most ${maximumDispatchNoteCharacters} characters. Remove ${
                  trimmedNote.length - maximumDispatchNoteCharacters
                }.`}
              </Alert>
            ) : null}
          </>
        )}
      </Modal>
      <DiscardDialog
        discardLabel="Discard note"
        keepLabel="Keep editing"
        message="The note you wrote for this send will be lost."
        onClose={() => setDiscardOpen(false)}
        onDiscard={() => {
          setDiscardOpen(false);
          changeNoteOpen(false);
        }}
        open={discardOpen}
        title="Discard this note?"
      />
    </div>
  );
}
