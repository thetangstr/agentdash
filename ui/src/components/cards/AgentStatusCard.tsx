// AgentDash: chat substrate card — agent status update
import type { AgentStatusPayload } from "@paperclipai/shared";

export function AgentStatusCard({ payload }: { payload: AgentStatusPayload }) {
  const tone =
    payload.severity === "blocked"
      ? "border-danger-500 bg-danger-500/5 text-danger-500"
      : payload.severity === "warn"
        ? "border-warn-500 bg-warn-500/5 text-warn-500"
        : "border-border-soft bg-surface-sunken text-text-secondary";
  return (
    <div className={`agent-status-card border-l-4 px-4 py-2 rounded-r-md ${tone}`}>
      <span className="font-medium text-text-primary">{payload.agentName}</span>
      <span className="text-text-secondary">: {payload.summary}</span>
    </div>
  );
}
