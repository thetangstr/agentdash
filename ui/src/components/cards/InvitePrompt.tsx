// AgentDash: chat substrate card — invite teammates prompt
import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";

export interface GeneratedInviteLink {
  id: string;
  email: string;
  inviteUrl: string;
  emailStatus?: "sent" | "skipped" | "failed";
}

export interface InviteSendResult {
  invites?: GeneratedInviteLink[];
  errors?: Array<{ email: string; reason: string }>;
}

export function InvitePrompt({
  companyId: _companyId,
  conversationId: _conversationId,
  onSendInvites,
  onSkip,
}: {
  companyId: string;
  conversationId: string;
  onSendInvites: (emails: string[]) => Promise<InviteSendResult | void>;
  onSkip: () => void;
}) {
  const [emails, setEmails] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<InviteSendResult | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

  async function send() {
    if (pending) return;
    setPending(true);
    try {
      const list = emails
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      if (list.length > 0) {
        const sendResult = await onSendInvites(list);
        if (sendResult && ((sendResult.invites?.length ?? 0) > 0 || (sendResult.errors?.length ?? 0) > 0)) {
          setResult(sendResult);
          return;
        }
      }
      onSkip();
    } finally {
      setPending(false);
    }
  }

  async function copyInvite(invite: GeneratedInviteLink) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(invite.inviteUrl);
        setCopiedInviteId(invite.id);
      }
    } catch {
      // Keep the URL visible so users can copy it manually.
    }
  }

  const invites = result?.invites ?? [];
  const errors = result?.errors ?? [];

  return (
    <div className="invite-prompt border border-border-soft rounded-lg p-6 bg-surface-raised shadow-sm">
      <div className="mb-3 text-text-primary font-medium">Want to bring anyone else in?</div>
      <input
        className="border border-border-soft px-3 py-2 w-full mb-3 rounded-md text-sm bg-surface-raised text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200"
        placeholder="bob@acme.com, carol@acme.com"
        value={emails}
        onChange={(e) => setEmails(e.target.value)}
      />
      {invites.length > 0 || errors.length > 0 ? (
        <div className="mb-3 space-y-3 rounded-lg border border-border-soft bg-surface-sunken p-3">
          {invites.length > 0 ? (
            <div className="space-y-2">
              <div className="text-sm font-medium text-text-primary">Generated invite links</div>
              <div className="space-y-2">
                {invites.map((invite) => (
                  <div key={invite.id} className="rounded-md border border-border-soft bg-surface-raised p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 text-sm font-medium text-text-primary">{invite.email}</div>
                      <span className="rounded-full border border-border-soft px-2 py-0.5 text-xs text-text-tertiary">
                        {formatEmailStatus(invite.emailStatus)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyInvite(invite)}
                      className="w-full rounded-md border border-border-soft bg-surface-sunken px-3 py-2 text-left text-xs text-text-secondary break-all transition-colors hover:bg-surface-raised"
                    >
                      {invite.inviteUrl}
                    </button>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-label={`Copy invite link for ${invite.email}`}
                        onClick={() => void copyInvite(invite)}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border-soft bg-surface-raised px-3 text-sm font-medium text-text-primary shadow-sm transition-colors hover:bg-surface-sunken"
                      >
                        {copiedInviteId === invite.id ? (
                          <>
                            <Check className="h-4 w-4" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-4 w-4" />
                            Copy link
                          </>
                        )}
                      </button>
                      <a
                        href={invite.inviteUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border-soft bg-surface-raised px-3 text-sm font-medium text-text-primary shadow-sm transition-colors hover:bg-surface-sunken"
                      >
                        <ExternalLink className="h-4 w-4" />
                        Open invite
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {errors.length > 0 ? (
            <div className="space-y-1 text-sm">
              <div className="font-medium text-text-primary">Invites that need attention</div>
              {errors.map((error) => (
                <div key={error.email} className="text-text-secondary">
                  {error.email}: {error.reason}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex gap-2">
        <button
          className="bg-accent-500 text-text-inverse px-4 py-2 rounded-md text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
          onClick={send}
          disabled={pending}
        >
          {pending ? "Sending..." : "Send invites"}
        </button>
        <button
          className="border border-border-soft px-4 py-2 rounded-md text-sm font-medium text-text-secondary hover:bg-surface-sunken transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
          onClick={onSkip}
        >
          {result ? "Done" : "Skip"}
        </button>
      </div>
    </div>
  );
}

function formatEmailStatus(status: GeneratedInviteLink["emailStatus"]) {
  if (status === "sent") return "Email sent";
  if (status === "failed") return "Email failed";
  return "Email not sent";
}
