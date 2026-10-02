// AgentDash (P0, v2026.1002.0): a CoS reply that failed to generate is shown
// in the chat with its reason and a Retry, instead of the chat sitting
// silently on the person's message.
import { useState } from "react";

export interface DispatchErrorPayload {
  reason?: string;
  retryMessageId?: string;
  hint?: string;
}

export function DispatchErrorCard({
  payload,
  onRetry,
}: {
  payload: DispatchErrorPayload | null | undefined;
  onRetry?: (messageId: string) => Promise<void> | void;
}) {
  const [state, setState] = useState<"idle" | "retrying" | "failed">("idle");
  const reason = (payload?.reason ?? "").trim().replace(/[.…\s]+$/, "") || "the reply could not be generated";
  const retryMessageId = payload?.retryMessageId;

  async function retry() {
    if (!retryMessageId || !onRetry) return;
    setState("retrying");
    try {
      await onRetry(retryMessageId);
    } catch {
      setState("failed");
      return;
    }
    setState("idle");
  }

  return (
    <div data-testid="cos-dispatch-error" role="alert" className="text-sm">
      <p className="text-text-primary">
        <span className="font-medium text-danger-500">CoS couldn't reply:</span> {reason}.
      </p>
      {payload?.hint ? <p data-testid="cos-dispatch-error-hint" className="mt-1 text-text-secondary">{payload.hint}</p> : null}
      {retryMessageId && onRetry ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-border-soft px-3 py-1 text-xs font-medium hover:bg-surface-sunken disabled:opacity-60"
            disabled={state === "retrying"}
            onClick={() => void retry()}
          >
            {state === "retrying" ? "Retrying…" : "Retry"}
          </button>
          {state === "failed" ? <span className="text-xs text-danger-500">Retry failed to start. Try again.</span> : null}
        </div>
      ) : null}
    </div>
  );
}
