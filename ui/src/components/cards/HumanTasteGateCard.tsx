// AgentDash: goals-eval-hitl — stub card (full implementation ships in Phase F/H)
import type { HumanTasteGateCardPayload } from "@paperclipai/shared";

export function HumanTasteGateCard({
  payload,
}: {
  payload: HumanTasteGateCardPayload | null | undefined;
}) {
  if (!payload) return null;
  return (
    <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm dark:border-yellow-700 dark:bg-yellow-950">
      <p className="font-semibold">Human review requested</p>
      <p className="mt-1">{payload.summary}</p>
      <p className="mt-1 text-muted-foreground">{payload.rationale}</p>
      {payload.reviewUrl && (
        <a
          href={payload.reviewUrl}
          className="mt-2 inline-block text-blue-600 underline dark:text-blue-400"
        >
          Review →
        </a>
      )}
    </div>
  );
}
