/** Runs a task once a slot is free; resolves or rejects with the task. */
export type RequestLimiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A counting semaphore for fan-out requests: at most `limit` tasks run at
 * once and the rest start in call order. A finishing task hands its slot
 * straight to the next waiter, so a caller arriving mid-handover still waits.
 */
export function createRequestLimiter(limit: number): RequestLimiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < limit) {
      active += 1;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}
