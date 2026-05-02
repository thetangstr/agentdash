// AgentDash: chat substrate page
import { useEffect } from "react";
import { useMessages } from "../realtime/useMessages";
import { MessageList } from "../components/MessageList";
import { Composer } from "../components/Composer";
import { conversationsApi } from "../api/conversations";
import type { CardContext } from "../components/cards";

export default function ChatPanel({
  conversationId,
  companyId,
  agentDirectory = [],
  cardContext,
}: {
  conversationId: string;
  companyId: string;
  agentDirectory?: Array<{ id: string; name: string; role: string }>;
  cardContext?: CardContext;
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

  const resolvedCardContext: CardContext = cardContext ?? {
    onProposalConfirm: () => {},
    onProposalReject: () => {},
    onInviteSend: async () => {},
    onInviteSkip: () => {},
  };

  return (
    <div className="chat-panel flex flex-col h-full bg-surface-page">
      <div className="flex-1 overflow-y-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <MessageList
            messages={messages}
            cardContext={resolvedCardContext}
          />
        </div>
      </div>
      <div className="border-t border-border-soft bg-surface-raised px-4 py-4">
        <div className="max-w-2xl mx-auto">
          <Composer onSend={send} agentDirectory={agentDirectory} />
        </div>
      </div>
    </div>
  );
}
