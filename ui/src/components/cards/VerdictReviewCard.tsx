// AgentDash: goals-eval-hitl — stub card (full implementation ships in Phase F/H)
import type { VerdictReviewCardPayload } from "@paperclipai/shared";

export function VerdictReviewCard({
  payload,
}: {
  payload: VerdictReviewCardPayload | null | undefined;
}) {
  if (!payload) return null;
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-sm">
      <p className="font-semibold">Verdict: {payload.outcome}</p>
      {payload.justification && (
        <p className="mt-1 text-muted-foreground">{payload.justification}</p>
      )}
    </div>
  );
}
