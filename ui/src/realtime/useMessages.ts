// AgentDash: chat substrate — messages hook with live append via the
// conversation event bus. LiveUpdatesProvider runs the company WebSocket and
// republishes `message.created` payloads to subscribeToConversationMessages.
//
// The socket is a fast path, not the only one: while it is down the hook
// refetches on reconnect, and every PENDING_REPLY_POLL_MS while a reply is
// still owed, so a conversation never goes silent behind a dead socket.
import { useCallback, useEffect, useRef, useState } from "react";
import { conversationsApi, type Message } from "../api/conversations";
import { subscribeToConversationMessages } from "./conversationEventBus";
import { useLiveSocketState } from "./liveSocketState";

export const PENDING_REPLY_POLL_MS = 5_000;
// Mirrors the server-side stalled-reply marker (STALLED_REPLY_RETRY_AFTER_MS):
// once a pending reply is this old it is declared timed out, so the fallback
// poll stops too — a dead dispatch should not be polled forever.
export const REPLY_PENDING_TIMEOUT_MS = 150_000;

function isAuthoredByUser(message: Message): boolean {
  return (message.role ?? message.authorKind) === "user";
}

/** The fetched page is authoritative for the ids it covers; keep the rest
 * (live arrivals, e.g. the message this client just POSTed) and order the
 * union by createdAt so an arrival older than the page's tail doesn't jump
 * below newer replies. */
function mergePage(prev: Message[], page: Message[]): Message[] {
  if (prev.length === 0) return page;
  const ids = new Set(page.map((m) => m.id));
  const extras = prev.filter((m) => !ids.has(m.id));
  return [...page, ...extras].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

export function useMessages(conversationId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const socketState = useLiveSocketState();
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  const refresh = useCallback(async (id: string) => {
    try {
      const rows = await conversationsApi.paginate(id, { limit: 50 });
      if (conversationIdRef.current !== id) return;
      const page = rows.slice().reverse(); // server returns desc; UI shows asc
      setMessages((prev) => mergePage(prev, page));
    } catch {
      // A failed poll or reconnect refetch keeps what is on screen; the next
      // one tries again.
    }
  }, []);

  useEffect(() => {
    if (!conversationId) return;

    // The list belongs to this conversation only — switching threads clears
    // it, otherwise mergePage would carry the old thread's tail into the new
    // one until its first page landed.
    setMessages([]);
    void refresh(conversationId);

    const unsubscribe = subscribeToConversationMessages(conversationId, (incoming, kind) => {
      setMessages((prev) => {
        // AgentDash (scan 4, lane N): a card changed state; merge the update
        // into the message on screen (an update for an unseen one is ignored;
        // the initial page carries its latest state).
        if (kind === "updated") {
          if (!prev.some((m) => m.id === incoming.id)) return prev;
          return prev.map((m) => (m.id === incoming.id ? { ...m, ...incoming } : m));
        }
        if (prev.some((m) => m.id === incoming.id)) return prev;
        return [...prev, incoming];
      });
    });

    return () => {
      unsubscribe();
    };
  }, [conversationId, refresh]);

  // A reconnect can have missed every event while the socket was down; pull
  // the latest page once it opens again.
  const previousSocketStateRef = useRef(socketState);
  useEffect(() => {
    const previous = previousSocketStateRef.current;
    previousSocketStateRef.current = socketState;
    if (!conversationId || socketState === previous) return;
    if (socketState === "open") void refresh(conversationId);
  }, [socketState, conversationId, refresh]);

  // With the socket down, a pending reply only arrives by polling — but only
  // until the reply is stale enough that the UI already calls it timed out.
  useEffect(() => {
    if (!conversationId || socketState === "open") return;
    const timer = window.setInterval(() => {
      const list = messagesRef.current;
      const last = list[list.length - 1];
      if (!last || !isAuthoredByUser(last)) return;
      const sentAt = new Date(last.createdAt).getTime();
      if (Number.isFinite(sentAt) && Date.now() - sentAt >= REPLY_PENDING_TIMEOUT_MS) return;
      void refresh(conversationId);
    }, PENDING_REPLY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [conversationId, socketState, refresh]);

  return messages;
}
