// AgentDash: chat substrate card — agent status update
import type { AgentStatusPayload } from "@paperclipai/shared";

export function AgentStatusCard({ payload }: { payload: AgentStatusPayload }) {
  const tone =
    payload.severity === "blocked"
      ? "border-red-500 bg-red-50"
      : payload.severity === "warn"
        ? "border-yellow-500 bg-yellow-50"
        : "border-gray-200 bg-gray-50";
  return (
    <div className={`agent-status-card border-l-4 px-3 py-2 ${tone}`}>
      <span className="font-medium">{payload.agentName}</span>: {payload.summary}
    </div>
  );
}
