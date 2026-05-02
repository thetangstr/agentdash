// AgentDash: chat substrate card — agent hire proposal
import type { ProposalPayload } from "@paperclipai/shared";
import { useState } from "react";

export function ProposalCard({
  payload,
  onConfirm,
  onReject,
}: {
  payload: ProposalPayload;
  onConfirm: () => void;
  onReject: (reason?: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="proposal-card border border-border-soft rounded-lg p-6 bg-surface-raised shadow-sm">
      <div className="text-lg font-semibold text-text-primary">
        {payload.name} — {payload.role}
      </div>
      <div className="mt-2 text-text-primary">{payload.oneLineOkr}</div>
      <div className="mt-2 text-sm text-text-secondary">{payload.rationale}</div>
      <div className="mt-4 flex gap-2">
        <button
          className="bg-accent-500 text-text-inverse px-4 py-2 rounded-md text-sm font-medium hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
          onClick={onConfirm}
        >
          Looks good →
        </button>
        <button
          className="border border-border-soft px-4 py-2 rounded-md text-sm font-medium text-text-primary hover:bg-surface-sunken transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
          onClick={() => setRejecting(true)}
        >
          Try again
        </button>
      </div>
      {rejecting && (
        <div className="mt-3 flex gap-2">
          <input
            className="border border-border-soft px-3 py-2 flex-1 rounded-md text-sm bg-surface-raised text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200"
            placeholder="What's off? (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            className="bg-accent-500 text-text-inverse px-4 py-2 rounded-md text-sm font-medium hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
            onClick={() => onReject(reason)}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
