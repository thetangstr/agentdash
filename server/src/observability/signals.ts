/**
 * The one seam between "something noticed trouble" and "someone gets told".
 *
 * Emitters never know about sinks: the error handler, the run watchdog, the
 * budget check and the backup job all call `emitSignal` and stop caring.
 * Subscribers are registered once at boot — the local error sink always, the
 * alerter when configured, later channels (Slack, UI badges) without touching
 * a single emitter.
 *
 * This exists because the previous design was measured to be a decoy: every
 * error was caught, enriched with method/url/body, and then dropped by a
 * `if (!target) return` in the Sentry transport that nothing ever configured.
 * Instrumentation without a sink reads as coverage and provides none. The
 * fixed vocabulary below is deliberate — a signal kind is a contract with
 * whoever gets woken up by it, not a free-form log line.
 */

export const SIGNAL_KINDS = [
  "server_error",
  "run_failed",
  "run_timed_out",
  "run_stuck",
  "backup_failed",
  "backup_stale",
  "disk_low",
  "budget_warn",
  "budget_stop",
  "mandate_expired",
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface Signal {
  kind: SignalKind;
  /** One human sentence. This is what lands in an alert email subject. */
  summary: string;
  companyId?: string | null;
  /** Small and structured. Never a request body, never client content. */
  detail?: Record<string, unknown>;
  occurredAt: Date;
}

export type SignalSubscriber = (signal: Signal) => void | Promise<void>;

const subscribers: SignalSubscriber[] = [];

export function subscribeToSignals(subscriber: SignalSubscriber): void {
  subscribers.push(subscriber);
}

/** Test seam: a fresh process has no subscribers; tests may need the same. */
export function resetSignalSubscribersForTest(): void {
  subscribers.length = 0;
}

/**
 * Fire-and-forget by design. A subscriber that throws must never take down
 * the code path that noticed the problem — an alerting failure on top of a
 * real failure should degrade to "only the original problem", not compound.
 * The one place a subscriber error goes is stderr, because if the signals
 * system itself reported through signals, a broken subscriber would recurse.
 */
export function emitSignal(input: Omit<Signal, "occurredAt"> & { occurredAt?: Date }): void {
  const signal: Signal = { ...input, occurredAt: input.occurredAt ?? new Date() };
  for (const subscriber of subscribers) {
    try {
      const result = subscriber(signal);
      if (result && typeof result.catch === "function") {
        result.catch((err: unknown) => {
          console.error(`[signals] subscriber failed for ${signal.kind}:`, err);
        });
      }
    } catch (err) {
      console.error(`[signals] subscriber failed for ${signal.kind}:`, err);
    }
  }
}
