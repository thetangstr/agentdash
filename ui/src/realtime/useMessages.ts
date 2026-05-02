// AgentDash: chat substrate — messages hook with polling fallback (WS TODO)
import { useEffect, useState } from "react";
import { conversationsApi, type Message } from "../api/conversations";

export function useMessages(conversationId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;

    conversationsApi.paginate(conversationId, { limit: 50 }).then((rows) => {
      if (!cancelled) setMessages(rows.slice().reverse()); // server returns desc; UI shows asc
    });

    // TODO: subscribe to WS bus for this conversation; on message.created, append.
    // Upstream WS event bus lives in ui/src/context/ — wire when upstream hook pattern is confirmed.
    // const unsub = wsClient.subscribe(`conversation:${conversationId}`, (event: any) => {
    //   if (event.type === "message.created") setMessages((prev) => [...prev, event.message]);
    // });

    return () => {
      cancelled = true;
      // unsub?.();
    };
  }, [conversationId]);

  return messages;
}
