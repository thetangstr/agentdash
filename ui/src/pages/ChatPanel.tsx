// AgentDash: chat substrate page
import { useEffect, useRef, type ReactNode } from "react";
import { useMessages } from "../realtime/useMessages";
import { MessageList } from "../components/MessageList";
import { Composer } from "../components/Composer";
import { ChatHeader, type ChatHeaderProps } from "../components/ChatHeader";
import { conversationsApi } from "../api/conversations";
import type { CardContext } from "../components/cards";
import { cn } from "../lib/utils";

export default function ChatPanel({
  conversationId,
  companyId,
  agentDirectory = [],
  cardContext,
  headerProps,
  suggestions,
  emptyState,
  padComposerForSafeArea = false,
}: {
  conversationId: string;
  companyId: string;
  agentDirectory?: Array<{ id: string; name: string; role: string }>;
  cardContext?: CardContext;
  headerProps?: ChatHeaderProps;
  /** AgentDash (GH #786): suggested first messages, shown until the person has sent one. */
  suggestions?: string[];
  /** AgentDash: shown in place of the message list while the conversation has no messages. */
  emptyState?: ReactNode;
  /**
   * AgentDash: pad the composer by the bottom safe-area inset. Set when the panel
   * fills the viewport itself; inside the sidebar Layout, <main> already pads for
   * the bottom nav and the inset.
   */
  padComposerForSafeArea?: boolean;
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
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4 max-sm:px-3">
        {/* min-h-full + justify-end pins messages to the bottom of the scroll
            area so a short conversation sits next to the composer instead of
            floating at the top with a big empty gap. As messages accumulate
            they push older content up and out via overflow-y-auto. */}
        <div className="max-w-2xl mx-auto min-h-full flex flex-col justify-end">
          {messages.length === 0 && emptyState ? (
            <div data-testid="chat-empty-state">{emptyState}</div>
          ) : (
            <MessageList
              messages={messages}
              cardContext={resolvedCardContext}
            />
          )}
          <div ref={bottomRef} aria-hidden="true" />
        </div>
      </div>
      <div
        data-testid="chat-composer-dock"
        className={cn(
          "border-t border-border-soft bg-surface-raised px-4 py-2 max-sm:px-3",
          padComposerForSafeArea && "pb-[calc(0.5rem+env(safe-area-inset-bottom))]",
        )}
      >
        <div className="max-w-2xl mx-auto">
          {suggestions && suggestions.length > 0 && !messages.some((m) => m.authorKind === "user") ? (
            // AgentDash: on phones the starters are one sideways-scrolling row of
            // compact chips instead of a stack of tall pills.
            <div
              className="mb-2 flex flex-wrap gap-2 max-sm:-mx-3 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:px-3 max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden"
              data-testid="chat-suggestions"
            >
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="rounded-full border border-border-soft px-3 py-1 text-left text-xs text-text-secondary hover:bg-surface-sunken max-sm:min-h-11 max-sm:shrink-0 max-sm:whitespace-nowrap"
                  onClick={() => send(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
          <Composer onSend={send} agentDirectory={agentDirectory} />
        </div>
      </div>
    </div>
  );
}
