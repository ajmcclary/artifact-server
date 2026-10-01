import {Context, Effect, Layer} from "effect";

import {principalActivityResolutionMilliseconds} from "../core/principal-activity.js";
import type {PrincipalActivityRecorder} from "../core/ports.js";

/** One credential whose use is recorded for administrators. */
export interface PrincipalActivitySubject {
  readonly id: string;
  readonly kind: "api_key" | "member";
}

export interface PrincipalActivityDependencies {
  readonly clock: {readonly now: () => Date};
  /** Distinct subjects remembered by the in-process throttle. */
  readonly maxSubjects?: number;
  readonly recorder: PrincipalActivityRecorder;
}

export interface PrincipalActivityOperations {
  /** Persist every due subject. Failures are logged, never raised. */
  readonly flush: () => Effect.Effect<void>;
  /** Remember one authenticated use. Performs no I/O. */
  readonly note: (subject: PrincipalActivitySubject) => Effect.Effect<void>;
}

/** Throttled last-active and last-used recording shared by every protocol adapter. */
export class PrincipalActivityService extends Context.Service<
  PrincipalActivityService,
  PrincipalActivityOperations
>()("artifact-server/application/PrincipalActivityService") {
  static readonly layer = (
    operations: PrincipalActivityOperations,
  ): Layer.Layer<PrincipalActivityService> =>
    Layer.succeed(PrincipalActivityService, operations);
}

const keyOf = (subject: PrincipalActivitySubject): string => `${subject.kind}:${subject.id}`;

interface PendingTouch {
  readonly at: string;
  readonly subject: PrincipalActivitySubject;
}

export function makePrincipalActivity(
  dependencies: PrincipalActivityDependencies,
): PrincipalActivityOperations {
  const maxSubjects = dependencies.maxSubjects ?? 10_000;
  // Insertion order doubles as recency, so the oldest entry is dropped first.
  const lastNoted = new Map<string, number>();
  const pending = new Map<string, PendingTouch>();

  const note = (subject: PrincipalActivitySubject) => Effect.sync(() => {
    const now = dependencies.clock.now();
    const key = keyOf(subject);
    const previous = lastNoted.get(key);
    if (
      previous !== undefined &&
      now.getTime() - previous < principalActivityResolutionMilliseconds
    ) {
      return;
    }
    lastNoted.delete(key);
    lastNoted.set(key, now.getTime());
    if (lastNoted.size > maxSubjects) {
      const oldest = lastNoted.keys().next();
      if (!oldest.done) lastNoted.delete(oldest.value);
    }
    pending.set(key, {at: now.toISOString(), subject});
  });

  const write = (key: string, touch: PendingTouch) => Effect.tryPromise({
    catch: (cause) => cause,
    try: () => touch.subject.kind === "member"
      ? dependencies.recorder.touch(touch.subject.id, touch.at)
      : dependencies.recorder.touchApiKey(touch.subject.id, touch.at),
  }).pipe(
    Effect.catch((cause) => {
      // Forget the throttle entry so the next use retries the write.
      lastNoted.delete(key);
      return Effect.logWarning("principal.activity.touch_failed").pipe(
        Effect.annotateLogs({
          reason: cause instanceof Error ? cause.message : "unknown",
          subject_kind: touch.subject.kind,
        }),
      );
    }),
  );

  const flush = () => Effect.suspend(() => {
    const due = [...pending.entries()];
    pending.clear();
    return Effect.forEach(due, ([key, touch]) => write(key, touch), {
      concurrency: 1,
      discard: true,
    });
  });

  return {flush, note};
}
