import {describe, expect, test} from "vitest";

import {createRequestLimiter} from "./request-limiter.ts";

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createRequestLimiter", () => {
  test("never runs more than the limit at once, even when new work arrives as a slot frees", async () => {
    const limit = createRequestLimiter(2);
    const gates = Array.from({length: 5}, () => Promise.withResolvers<void>());
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const run = (index: number): Promise<number> => limit(async () => {
      started.push(index);
      active += 1;
      peak = Math.max(peak, active);
      await gates[index]?.promise;
      active -= 1;
      return index;
    });

    const first = [run(0), run(1), run(2)];
    await flush();
    expect(started).toEqual([0, 1]);
    gates[0]?.resolve();
    // A caller arriving while the freed slot is being handed over must still wait.
    const late = [run(3), run(4)];
    await flush();
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) gate.resolve();
    expect(await Promise.all([...first, ...late])).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  test("a rejected task releases its slot to the next waiting task", async () => {
    const limit = createRequestLimiter(1);
    const gate = Promise.withResolvers<void>();
    const failing = limit(async () => {
      await gate.promise;
    });
    const waiting = limit(async () => "ran");
    gate.reject(new Error("catalog unavailable"));
    await expect(failing).rejects.toThrow("catalog unavailable");
    expect(await waiting).toBe("ran");
  });
});
