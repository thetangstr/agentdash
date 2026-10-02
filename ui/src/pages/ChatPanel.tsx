// AgentDash: chat substrate page
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMessages } from "../realtime/useMessages";
import { MessageList } from "../components/MessageList";
import { Composer } from "../components/Composer";
import { ChatHeader, type ChatHeaderProps } from "../components/ChatHeader";
import { conversationsApi } from "../api/conversations";
import type { CardContext } from "../components/cards";
import { cn } from "../lib/utils";
import type { Message } from "../api/conversations";

/**
 * AgentDash: how long the chat shows "CoS is thinking…" after the person's
 * message before it offers a Retry. The server kills a local adapter after
 * 120s (AGENTDASH_ADAPTER_TIMEOUT_MS) and then posts an error card, so a reply
 * that has not arrived well after that is not coming.
 */
export const REPLY_PENDING_TIMEOUT_MS = 150_000;

function authorOf(m: Message): string | undefined {
  return m.role ?? m.authorKind;
}

/** The person's message still waiting for a reply, if the conversation ends on one. */
export function pendingUserMessage(messages: Message[]): Message | null {
  const last = messages[messages.length - 1];
  return last && authorOf(last) === "user" ? last : null;
}

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

  // AgentDash (P0, v2026.1002.0): the chat is never silent while a reply is
  // owed. A conversation that ends on the person's message shows "CoS is
  // thinking…"; the reply, or the server's "CoS couldn't reply" card, ends it
  // (both arrive live as message.created). A Retry is waiting on a newer
  // message than the ones on screen when it was pressed.
  const [retryFromCount, setRetryFromCount] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pending = pendingUserMessage(messages);
  const retrying = retryFromCount !== null && messages.length <= retryFromCount;
  const pendingSince = pending ? new Date(pending.createdAt).getTime() : NaN;
  const pendingAge = Number.isFinite(pendingSince) ? now - pendingSince : 0;
  const stalled = Boolean(pending) && !retrying && pendingAge >= REPLY_PENDING_TIMEOUT_MS;
  const thinking = retrying || (Boolean(pending) && !stalled);

  useEffect(() => {
    if (retryFromCount !== null && messages.length > retryFromCount) setRetryFromCount(null);
  }, [messages.length, retryFromCount]);

  // Re-render once the pending message crosses the timeout so the indicator
  // turns into a Retry without waiting for some other update.
  useEffect(() => {
    if (!pending || stalled || retrying) return;
    const wait = Math.max(0, REPLY_PENDING_TIMEOUT_MS - pendingAge) + 50;
    const t = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(t);
  }, [pending, stalled, retrying, pendingAge]);

  function send(body: string) {
    setSendError(null);
    conversationsApi.post(conversationId, body, companyId).catch(() => {
      setSendError("Your message was not sent. Check your connection and try again.");
    });
  }

  async function retryReply(messageId: string) {
    setSendError(null);
    setRetryFromCount(messages.length);
    try {
      await conversationsApi.retry(conversationId, messageId);
    } catch (err) {
      setRetryFromCount(null);
      throw err;
    }
  }

  const baseCardContext: CardContext = cardContext ?? {
    onProposalConfirm: () => {},
    onProposalReject: () => {},
    onInviteSend: async () => {},
    onInviteSkip: () => {},
  };
  const resolvedCardContext: CardContext = {
    ...baseCardContext,
    onDispatchRetry: baseCardContext.onDispatchRetry ?? retryReply,
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
          {thinking ? (
            <div data-testid="cos-thinking" role="status" aria-live="polite" className="mt-5 flex items-center gap-2 text-sm text-text-secondary">
              <span className="inline-flex gap-1" aria-hidden="true">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-tertiary" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-tertiary [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-tertiary [animation-delay:300ms]" />
              </span>
              CoS is thinking…
            </div>
          ) : null}
          {stalled && pending ? (
            <div data-testid="cos-reply-stalled" role="alert" className="mt-5 flex flex-wrap items-center gap-2 text-sm text-text-secondary">
              <span>CoS hasn't replied.</span>
              <button
                type="button"
                className="rounded-md border border-border-soft px-3 py-1 text-xs font-medium text-text-primary hover:bg-surface-sunken"
                onClick={() => void retryReply(pending.id).catch(() => setSendError("Retry failed to start. Try again."))}
              >
                Retry
              </button>
            </div>
          ) : null}
          {sendError ? (
            <p data-testid="chat-send-error" role="alert" className="mt-3 text-xs text-danger-500">{sendError}</p>
          ) : null}
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
