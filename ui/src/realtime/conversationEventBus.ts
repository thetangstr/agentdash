// AgentDash: per-conversation pub-sub. LiveUpdatesProvider receives the
// company-scoped WebSocket and forwards `message.created` payloads here so
// hooks like useMessages can subscribe by conversationId without opening
// their own socket.
import type { Message } from "../api/conversations";

/**
 * "created": a new message (append it). "updated": a message changed in place,
 * e.g. a card's state (AgentDash scan 4, lane N); merge it into the one shown.
 */
export type ConversationMessageEventKind = "created" | "updated";

type Handler = (message: Message, kind: ConversationMessageEventKind) => void;

const subscribers = new Map<string, Set<Handler>>();

export function subscribeToConversationMessages(
  conversationId: string,
  handler: Handler,
): () => void {
  let set = subscribers.get(conversationId);
  if (!set) {
    set = new Set();
    subscribers.set(conversationId, set);
  }
  set.add(handler);
  return () => {
    const current = subscribers.get(conversationId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) subscribers.delete(conversationId);
  };
}

export function publishConversationMessage(message: Message, kind: ConversationMessageEventKind = "created"): void {
  const set = subscribers.get(message.conversationId);
  if (!set || set.size === 0) return;
  for (const handler of set) {
    try {
      handler(message, kind);
    } catch {
      // Subscribers must not break sibling handlers.
    }
  }
}
