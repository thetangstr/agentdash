// AgentDash: chat substrate page
import { useEffect } from "react";
import { useMessages } from "../realtime/useMessages";
import { MessageList } from "../components/MessageList";
import { Composer } from "../components/Composer";
import { conversationsApi } from "../api/conversations";

export default function ChatPanel({
  conversationId,
  companyId,
  agentDirectory = [],
}: {
  conversationId: string;
  companyId: string;
  agentDirectory?: Array<{ id: string; name: string; role: string }>;
}) {
  const messages = useMessages(conversationId);

  // Read pointer: PATCH /read throttled 1s after latest message changes
  useEffect(() => {
    if (messages.length === 0) return;
    const latest = messages[messages.length - 1];
    const t = setTimeout(() => {
      conversationsApi.read(conversationId, latest.id).catch(() => {
        // non-fatal
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [messages, conversationId]);

  function send(body: string) {
    conversationsApi.post(conversationId, body, companyId).catch(() => {
      // non-fatal
    });
  }

  return (
    <div className="chat-panel flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-2xl mx-auto">
          <MessageList
            messages={messages}
            cardContext={{
              onProposalConfirm: () => {
                // wired by onboarding plan
              },
              onProposalReject: (_r) => {
                // wired by onboarding plan
              },
              onInviteSend: async (_emails) => {
                // wired by onboarding plan
              },
              onInviteSkip: () => {
                // wired by onboarding plan
              },
            }}
          />
        </div>
      </div>
      <div className="border-t bg-white p-4">
        <div className="max-w-2xl mx-auto">
          <Composer onSend={send} agentDirectory={agentDirectory} />
        </div>
      </div>
    </div>
  );
}
