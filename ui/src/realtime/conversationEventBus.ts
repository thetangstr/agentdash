// AgentDash: per-conversation pub-sub. LiveUpdatesProvider receives the
// company-scoped WebSocket and forwards `message.created` payloads here so
// hooks like useMessages can subscribe by conversationId without opening
// their own socket.
import type { Message } from "../api/conversations";

type Handler = (message: Message) => void;

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

export function publishConversationMessage(message: Message): void {
  const set = subscribers.get(message.conversationId);
  if (!set || set.size === 0) return;
  for (const handler of set) {
    try {
      handler(message);
    } catch {
      // Subscribers must not break sibling handlers.
    }
  }
}
