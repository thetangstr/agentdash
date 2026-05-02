// AgentDash: chat substrate card — invite teammates prompt
import { useState } from "react";

export function InvitePrompt({
  companyId: _companyId,
  conversationId: _conversationId,
  onSendInvites,
  onSkip,
}: {
  companyId: string;
  conversationId: string;
  onSendInvites: (emails: string[]) => Promise<void>;
  onSkip: () => void;
}) {
  const [emails, setEmails] = useState("");
  const [pending, setPending] = useState(false);

  async function send() {
    if (pending) return;
    setPending(true);
    try {
      const list = emails
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      if (list.length > 0) await onSendInvites(list);
      onSkip();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="invite-prompt border rounded p-4 bg-white">
      <div className="mb-2">Want to bring anyone else in?</div>
      <input
        className="border px-2 py-1 w-full mb-2"
        placeholder="bob@acme.com, carol@acme.com"
        value={emails}
        onChange={(e) => setEmails(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          className="bg-blue-600 text-white px-3 py-1 rounded"
          onClick={send}
          disabled={pending}
        >
          Send invites
        </button>
        <button className="border px-3 py-1 rounded" onClick={onSkip}>
          Skip
        </button>
      </div>
    </div>
  );
}
