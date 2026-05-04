// AgentDash: chat substrate — messages hook with live append via the
// conversation event bus. LiveUpdatesProvider runs the company WebSocket and
// republishes `message.created` payloads to subscribeToConversationMessages.
import { useEffect, useState } from "react";
import { conversationsApi, type Message } from "../api/conversations";
import { subscribeToConversationMessages } from "./conversationEventBus";

export function useMessages(conversationId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;

    conversationsApi.paginate(conversationId, { limit: 50 }).then((rows) => {
      if (cancelled) return;
      const initial = rows.slice().reverse(); // server returns desc; UI shows asc
      setMessages((prev) => {
        if (prev.length === 0) return initial;
        // A live message may have arrived before the initial fetch resolved.
        // Drop anything from prev that the initial page already covers, then
        // append the rest so we don't lose realtime arrivals.
        const initialIds = new Set(initial.map((m) => m.id));
        const extras = prev.filter((m) => !initialIds.has(m.id));
        return [...initial, ...extras];
      });
    });

    const unsubscribe = subscribeToConversationMessages(conversationId, (incoming) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === incoming.id)) return prev;
        return [...prev, incoming];
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [conversationId]);

  return messages;
}
