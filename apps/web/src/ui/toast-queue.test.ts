import {describe, expect, test} from "vitest";

import {
  defaultToastMilliseconds,
  markToastLeaving,
  maximumVisibleToasts,
  queueToast,
  removeToast,
  toastLifetime,
  toastsAwaitingRemoval,
  type QueuedToast,
} from "./toast-queue.ts";

function pushAll(messages: readonly string[]): readonly QueuedToast[] {
  return messages.reduce<readonly QueuedToast[]>(
    (queue, message, index) => queueToast(queue, `toast-${index}`, {message}),
    [],
  );
}

describe("toast queue", () => {
  test("toasts queue oldest first and leave before they are removed", () => {
    const queue = pushAll(["Saved", "Copied"]);
    expect(queue.map((entry) => entry.id)).toEqual(["toast-0", "toast-1"]);
    const leaving = markToastLeaving(queue, "toast-0");
    expect(leaving.map((entry) => entry.leaving)).toEqual([true, false]);
    expect(removeToast(leaving, "toast-0").map((entry) => entry.id)).toEqual(["toast-1"]);
  });

  test("the same text under the same id counts repeats instead of stacking", () => {
    const once = queueToast([], "send", {message: "Sent 2 threads to solo"});
    const twice = queueToast(once, "send", {message: "Sent 2 threads to solo"});
    expect(twice).toHaveLength(1);
    expect(twice[0]?.count).toBe(2);
    const replaced = queueToast(twice, "send", {message: "Send canceled"});
    expect(replaced[0]?.count).toBe(1);
    expect(replaced[0]?.toast.message).toBe("Send canceled");
  });

  test("beyond the visible limit the oldest toasts start leaving", () => {
    const queue = pushAll(["one", "two", "three", "four", "five"]);
    const visible = queue.filter((entry) => !entry.leaving).map((entry) => entry.toast.message);
    expect(visible).toEqual(["three", "four", "five"]);
    expect(visible).toHaveLength(maximumVisibleToasts);
  });

  test("a toast pushed out by newer ones is due for removal even with no lifetime of its own", () => {
    const kept = queueToast([], "sign-out-failed", {durationMs: null, message: "Sign-out failed"});
    const queue = ["two", "three", "four"].reduce<readonly QueuedToast[]>(
      (current, message) => queueToast(current, message, {message}),
      kept,
    );
    expect(queue.find((entry) => entry.id === "sign-out-failed")?.leaving).toBe(true);
    expect(toastsAwaitingRemoval(queue, new Set())).toEqual(["sign-out-failed"]);
    // Once its exit is scheduled it is not scheduled twice.
    expect(toastsAwaitingRemoval(queue, new Set(["sign-out-failed"]))).toEqual([]);
  });

  test("a toast without a duration uses the default and null stays until dismissed", () => {
    expect(toastLifetime({message: "Saved"})).toBe(defaultToastMilliseconds);
    expect(toastLifetime({durationMs: null, message: "Keep"})).toBeNull();
    expect(toastLifetime({durationMs: 8_000, message: "Undo"})).toBe(8_000);
  });
});
