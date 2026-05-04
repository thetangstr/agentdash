// AgentDash: chat substrate page
import { useEffect, useRef } from "react";
import { useMessages } from "../realtime/useMessages";
import { MessageList } from "../components/MessageList";
import { Composer } from "../components/Composer";
import { ChatHeader, type ChatHeaderProps } from "../components/ChatHeader";
import { conversationsApi } from "../api/conversations";
import type { CardContext } from "../components/cards";

export default function ChatPanel({
  conversationId,
  companyId,
  agentDirectory = [],
  cardContext,
  headerProps,
}: {
  conversationId: string;
  companyId: string;
  agentDirectory?: Array<{ id: string; name: string; role: string }>;
  cardContext?: CardContext;
  headerProps?: ChatHeaderProps;
}) {
  const messages = useMessages(conversationId);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastMessageId = messages[messages.length - 1]?.id;

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

  // Auto-scroll the messages area to the bottom whenever a new message arrives.
  // Keyed on length + last message id (not the array reference) to avoid running
  // on every re-render when the underlying messages haven't changed.
  useEffect(() => {
    const node = bottomRef.current;
    // jsdom doesn't implement scrollIntoView; feature-detect so unit tests pass.
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages.length, lastMessageId]);

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
      <ChatHeader {...(headerProps ?? {})} />
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4">
        {/* min-h-full + justify-end pins messages to the bottom of the scroll
            area so a short conversation sits next to the composer instead of
            floating at the top with a big empty gap. As messages accumulate
            they push older content up and out via overflow-y-auto. */}
        <div className="max-w-2xl mx-auto min-h-full flex flex-col justify-end">
          <MessageList
            messages={messages}
            cardContext={resolvedCardContext}
          />
          <div ref={bottomRef} aria-hidden="true" />
        </div>
      </div>
      <div className="border-t border-border-soft bg-surface-raised px-4 py-2">
        <div className="max-w-2xl mx-auto">
          <Composer onSend={send} agentDirectory={agentDirectory} />
        </div>
      </div>
    </div>
  );
}
