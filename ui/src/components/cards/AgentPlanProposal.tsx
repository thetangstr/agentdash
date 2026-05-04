// AgentDash: chat substrate card — CoS plan proposal (Phase C).
// See docs/superpowers/specs/2026-05-04-cos-onboarding-conversation-design.md.
import type { AgentPlanProposalV1Payload } from "@paperclipai/shared";

export function AgentPlanProposal({
  payload,
  onConfirm,
  onRevise,
}: {
  payload: AgentPlanProposalV1Payload;
  onConfirm: () => void;
  onRevise: () => void;
}) {
  const agents = Array.isArray(payload?.agents) ? payload.agents : [];
  return (
    <div
      className="agent-plan-proposal border border-border-soft rounded-lg p-6 bg-surface-raised shadow-sm"
      data-testid="plan-proposal"
    >
      <div className="text-base text-text-primary">{payload.rationale}</div>

      <div className="mt-4 flex flex-col gap-3">
        {agents.map((agent, i) => (
          <div
            key={`${agent.role}-${i}`}
            className="flex items-start gap-3 border border-border-soft rounded-md p-3 bg-surface-base"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-text-primary">
                {agent.name} <span className="text-text-secondary font-normal">— {agent.role}</span>
              </div>
              {agent.responsibilities?.[0] && (
                <div className="mt-1 text-sm text-text-secondary">{agent.responsibilities[0]}</div>
              )}
            </div>
            <span className="shrink-0 rounded-full border border-border-soft bg-surface-raised px-2 py-0.5 text-xs text-text-secondary">
              {agent.adapterType}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 text-sm text-text-secondary">
        <div>
          <span className="font-medium text-text-primary">Short-term:</span> {payload.alignmentToShortTerm}
        </div>
        <div>
          <span className="font-medium text-text-primary">Long-term:</span> {payload.alignmentToLongTerm}
        </div>
      </div>

      <div className="mt-5 flex gap-2">
        <button
          className="bg-accent-500 text-text-inverse px-4 py-2 rounded-md text-sm font-medium hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
          onClick={onConfirm}
        >
          Set it up
        </button>
        <button
          className="border border-border-soft px-4 py-2 rounded-md text-sm font-medium text-text-primary hover:bg-surface-sunken transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
          onClick={onRevise}
        >
          Let me revise
        </button>
      </div>
    </div>
  );
}
