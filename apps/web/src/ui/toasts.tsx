import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode} from "react";

import {ToastRegion} from "@/arkcase";

import {
  markToastLeaving,
  queueToast,
  removeToast,
  toastExitMilliseconds,
  toastLifetime,
  type AppToast,
  type QueuedToast,
} from "./toast-queue.ts";

export type {AppToast} from "./toast-queue.ts";

export interface Toasts {
  push(toast: AppToast): string;
  dismiss(id: string): void;
}

const ToastContext = createContext<Toasts>({dismiss: () => undefined, push: () => ""});

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The application's toast queue, drawn by the DS `ToastRegion` at the
 * bottom-end corner. The region owns placement, motion and speech; this
 * provider owns the queue, the auto-dismiss timers (held while the pointer or
 * focus is on a toast) and each toast's leaving flag.
 */
export function ToastProvider(props: {readonly children: ReactNode}): JSX.Element {
  const [queue, setQueue] = useState<readonly QueuedToast[]>([]);
  const queueRef = useRef(queue);
  const lifetimes = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const exits = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const paused = useRef(false);
  const sequence = useRef(0);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const stopLifetime = useCallback((id: string) => {
    const timer = lifetimes.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    lifetimes.current.delete(id);
  }, []);

  const dismiss = useCallback((id: string) => {
    stopLifetime(id);
    setQueue((current) => markToastLeaving(current, id));
    const pending = exits.current.get(id);
    if (pending !== undefined) clearTimeout(pending);
    exits.current.set(id, setTimeout(() => {
      exits.current.delete(id);
      setQueue((current) => removeToast(current, id));
    }, prefersReducedMotion() ? 0 : toastExitMilliseconds));
  }, [stopLifetime]);

  const startLifetime = useCallback((id: string, toast: AppToast) => {
    stopLifetime(id);
    const lifetime = toastLifetime(toast);
    if (lifetime === null || paused.current) return;
    lifetimes.current.set(id, setTimeout(() => dismiss(id), lifetime));
  }, [dismiss, stopLifetime]);

  const push = useCallback((toast: AppToast) => {
    sequence.current += 1;
    const id = toast.id ?? `toast-${sequence.current}`;
    const pending = exits.current.get(id);
    if (pending !== undefined) clearTimeout(pending);
    exits.current.delete(id);
    setQueue((current) => queueToast(current, id, toast));
    startLifetime(id, toast);
    return id;
  }, [startLifetime]);

  const pause = useCallback(() => {
    paused.current = true;
    for (const id of lifetimes.current.keys()) stopLifetime(id);
  }, [stopLifetime]);

  const resume = useCallback(() => {
    paused.current = false;
    for (const entry of queueRef.current) {
      if (!entry.leaving) startLifetime(entry.id, entry.toast);
    }
  }, [startLifetime]);

  useEffect(() => () => {
    for (const timer of [...lifetimes.current.values(), ...exits.current.values()]) clearTimeout(timer);
  }, []);

  const toasts = useMemo(() => ({dismiss, push}), [dismiss, push]);
  const items = queue.map((entry) => ({
    // An empty label draws no action (the DS Toast requires both a label and a handler).
    actionLabel: entry.toast.actionLabel ?? "",
    count: entry.count,
    id: entry.id,
    leaving: entry.leaving,
    message: entry.toast.message,
    onAction: () => {
      entry.toast.onAction?.();
      dismiss(entry.id);
    },
    title: entry.toast.title,
    variant: entry.toast.variant ?? "info",
  }));
  return (
    <ToastContext value={toasts}>
      {props.children}
      <ToastRegion
        onDismiss={(id) => dismiss(String(id))}
        onPause={pause}
        onResume={resume}
        placement="bottom-end"
        toasts={items}
      />
    </ToastContext>
  );
}

export function useToasts(): Toasts {
  return useContext(ToastContext);
}
