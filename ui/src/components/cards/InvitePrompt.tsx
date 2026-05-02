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
    <div className="invite-prompt border border-border-soft rounded-lg p-6 bg-surface-raised shadow-sm">
      <div className="mb-3 text-text-primary font-medium">Want to bring anyone else in?</div>
      <input
        className="border border-border-soft px-3 py-2 w-full mb-3 rounded-md text-sm bg-surface-raised text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200"
        placeholder="bob@acme.com, carol@acme.com"
        value={emails}
        onChange={(e) => setEmails(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          className="bg-accent-500 text-text-inverse px-4 py-2 rounded-md text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
          onClick={send}
          disabled={pending}
        >
          Send invites
        </button>
        <button
          className="border border-border-soft px-4 py-2 rounded-md text-sm font-medium text-text-secondary hover:bg-surface-sunken transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
          onClick={onSkip}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
