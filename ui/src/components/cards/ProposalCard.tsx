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
    <div className="proposal-card border rounded p-4 bg-white">
      <div className="text-lg font-medium">
        {payload.name} — {payload.role}
      </div>
      <div className="mt-2">{payload.oneLineOkr}</div>
      <div className="mt-2 text-sm text-gray-600">{payload.rationale}</div>
      <div className="mt-3 flex gap-2">
        <button className="bg-blue-600 text-white px-3 py-1 rounded" onClick={onConfirm}>
          Looks good →
        </button>
        <button className="border px-3 py-1 rounded" onClick={() => setRejecting(true)}>
          Try again
        </button>
      </div>
      {rejecting && (
        <div className="mt-2 flex gap-2">
          <input
            className="border px-2 py-1 flex-1"
            placeholder="What's off? (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            className="bg-blue-600 text-white px-3 py-1 rounded"
            onClick={() => onReject(reason)}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
