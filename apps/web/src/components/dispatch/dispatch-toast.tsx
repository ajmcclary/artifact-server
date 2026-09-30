import {api, ApiError, type AgentDispatch, type AgentPresence} from "@/api/client";
import {errorMessage} from "@/lib/presentation";
import {useToasts} from "@/ui/toasts";

/** One send that just left, with everything the undo toast needs to name it. */
export interface SentDispatch {
  readonly agent: AgentPresence;
  readonly dispatches: readonly AgentDispatch[];
  /** Threads left unsent when a later server-bounded batch failed. */
  readonly incompleteCount?: number;
}

/** How a send control reports its outcome to the surface's toast. */
export interface DispatchFeedback {
  readonly sendFailed: (error: Error) => void;
  readonly sent: (sent: SentDispatch) => void;
}

/** The surface's undo toast reporting hooks; the application's ToastRegion draws it. */
export interface DispatchUndo {
  readonly feedback: DispatchFeedback;
}

/** How long the Undo offer stands before the toast quietly leaves. */
const sentToastMilliseconds = 8_000;
const noticeToastMilliseconds = 6_000;

function threadsWord(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

function sentMessage(sent: SentDispatch): string {
  const count = sent.dispatches.reduce((total, dispatch) => total + dispatch.threadIds.length, 0);
  if (sent.incompleteCount !== undefined) {
    return `Sent ${threadsWord(count)} to ${sent.agent.displayName}; ${threadsWord(sent.incompleteCount)} could not be sent.`;
  }
  return sent.agent.capabilities?.evidence === "mailbox"
    ? `Queued for ${sent.agent.displayName} — it picks this up when it next checks in.`
    : `Sent ${threadsWord(count)} to ${sent.agent.displayName}`;
}

/**
 * The undo toast behind one-click sends: confirmation is replaced by a short
 * window to call the send back. Undo cancels the dispatch (valid while it is
 * queued or claimed); a send the agent already carried past that point
 * reports the conflict honestly instead of pretending it was undone.
 */
export function useDispatchUndo(
  projectId: string,
  onUndone: () => Promise<void>,
): DispatchUndo {
  const toasts = useToasts();

  const undo = async (sent: SentDispatch): Promise<void> => {
    const results = await Promise.allSettled(
      sent.dispatches.map((dispatch) => api.cancelAgentDispatch(projectId, dispatch.id)),
    );
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 0) {
      toasts.push({
        durationMs: noticeToastMilliseconds,
        message: "Send canceled — the annotations are back.",
        variant: "success",
      });
    } else {
      const conflict = failures.some((failure) =>
        failure instanceof ApiError && failure.code === "DISPATCH_STATE_CONFLICT"
      );
      const firstFailure = failures[0];
      toasts.push({
        durationMs: noticeToastMilliseconds,
        message: conflict
          ? `Too late to undo — ${sent.agent.displayName} already carried this send past the point of cancelling.`
          : errorMessage(firstFailure instanceof Error ? firstFailure : new Error("Undo failed.")),
        variant: "warning",
      });
    }
    await onUndone();
  };

  const feedback: DispatchFeedback = {
    sendFailed: (error) => {
      toasts.push({durationMs: noticeToastMilliseconds, message: errorMessage(error), variant: "danger"});
    },
    sent: (sent) => {
      const id = crypto.randomUUID();
      toasts.push({
        actionLabel: "Undo",
        durationMs: sentToastMilliseconds,
        id,
        message: sentMessage(sent),
        onAction: () => {
          toasts.dismiss(id);
          void undo(sent);
        },
        variant: "success",
      });
    },
  };

  return {feedback};
}
