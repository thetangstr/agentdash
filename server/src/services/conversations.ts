import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assistantConversations,
  assistantConversationParticipants,
  assistantMessages,
} from "@paperclipai/db";
import { emitMessageCreated, emitMessageRead } from "../realtime/conversation-events.js";
import { redactRunLogText, redactRunLogValue } from "./run-log-redaction.js";

export function conversationService(db: Db) {
  // AgentDash (GH #992): agent-authored messages are model output and can
  // echo credentials, so they persist redacted (postMessage). The serve pass
  // also covers human-authored content and rows written before the persist
  // pass shipped — applied everywhere a message row leaves this service.
  function redactMessage<T extends { content?: string | null; cardPayload?: unknown }>(message: T): T {
    const out = { ...message };
    if (typeof out.content === "string" && out.content.length > 0) {
      out.content = redactRunLogText(out.content);
    }
    if (out.cardPayload != null) {
      out.cardPayload = redactRunLogValue(out.cardPayload);
    }
    return out;
  }

  return {
    getById: async (id: string) => {
      const rows = await db
        .select()
        .from(assistantConversations)
        .where(eq(assistantConversations.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    findByCompany: async (companyId: string, opts: { title?: string } = {}) => {
      const conditions = [eq(assistantConversations.companyId, companyId)];
      if (opts.title) {
        conditions.push(eq(assistantConversations.title, opts.title));
      }
      const rows = await db
        .select()
        .from(assistantConversations)
        .where(and(...conditions))
        .limit(1);
      return rows[0] ?? null;
    },

    create: async (input: { companyId: string; userId?: string; title?: string }) => {
      const rows = await db
        .insert(assistantConversations)
        .values({
          companyId: input.companyId,
          userId: input.userId ?? "",
          title: input.title ?? null,
        })
        .returning();
      return rows[0]!;
    },

    addParticipant: async (
      conversationId: string,
      userId: string,
      role: "owner" | "member" = "member",
    ) => {
      await db
        .insert(assistantConversationParticipants)
        .values({ conversationId, userId, role })
        .onConflictDoNothing();
    },

    listParticipants: async (conversationId: string) => {
      return db
        .select()
        .from(assistantConversationParticipants)
        .where(eq(assistantConversationParticipants.conversationId, conversationId));
    },

    setReadPointer: async (
      conversationId: string,
      userId: string,
      lastReadMessageId: string,
      companyId?: string,
    ) => {
      // AgentDash (security): the read pointer must name a message in this
      // conversation; a message id from another conversation is refused.
      const owned = await db
        .select({ id: assistantMessages.id })
        .from(assistantMessages)
        .where(
          and(
            eq(assistantMessages.id, lastReadMessageId),
            eq(assistantMessages.conversationId, conversationId),
          ),
        )
        .limit(1);
      if (owned.length === 0) return false;
      await db
        .update(assistantConversationParticipants)
        .set({ lastReadMessageId })
        .where(
          and(
            eq(assistantConversationParticipants.conversationId, conversationId),
            eq(assistantConversationParticipants.userId, userId),
          ),
        );
      if (companyId) {
        emitMessageRead({ conversationId, userId, lastReadMessageId, companyId });
      }
      return true;
    },

    // AgentDash: one message, only when it belongs to this conversation.
    getMessage: async (conversationId: string, messageId: string) => {
      const rows = await db
        .select()
        .from(assistantMessages)
        .where(and(eq(assistantMessages.id, messageId), eq(assistantMessages.conversationId, conversationId)))
        .limit(1);
      return rows[0] ? redactMessage(rows[0]) : null;
    },

    // AgentDash: the newest message of one role, or null.
    latestByRole: async (conversationId: string, role: "user" | "agent") => {
      const rows = await db
        .select()
        .from(assistantMessages)
        .where(and(eq(assistantMessages.conversationId, conversationId), eq(assistantMessages.role, role)))
        .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
        .limit(1);
      return rows[0] ? redactMessage(rows[0]) : null;
    },

    // AgentDash: whether any message of this card kind exists in the conversation.
    hasCard: async (conversationId: string, cardKind: string) => {
      const rows = await db
        .select({ id: assistantMessages.id })
        .from(assistantMessages)
        .where(and(eq(assistantMessages.conversationId, conversationId), eq(assistantMessages.cardKind, cardKind)))
        .limit(1);
      return rows.length > 0;
    },

    postMessage: async (input: {
      conversationId: string;
      authorKind: "user" | "agent";
      authorId: string;
      body: string;
      cardKind?: string | null;
      cardPayload?: Record<string, unknown> | null;
      companyId?: string;
    }) => {
      // AgentDash: the conversation decides the company, always. A caller that
      // names one must name the conversation's; a caller that omits it (the
      // CoS replier, summoner, onboarding routes) gets it from the conversation
      // so message.created always reaches open chats.
      let companyId = input.companyId ?? null;
      try {
        const conv = await db
          .select({ companyId: assistantConversations.companyId })
          .from(assistantConversations)
          .where(eq(assistantConversations.id, input.conversationId))
          .limit(1);
        const owner = conv[0]?.companyId ?? null;
        if (owner && input.companyId && input.companyId !== owner) {
          throw new Error("postMessage: companyId does not match the conversation's company");
        }
        companyId = owner ?? companyId;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("postMessage:")) throw err;
        // Lookup failed: fall back to the caller's company; a reload still shows the message.
      }
      const rows = await db
        .insert(assistantMessages)
        .values({
          conversationId: input.conversationId,
          role: input.authorKind,
          // AgentDash: remember who wrote a person's message (Retry is theirs only).
          authorUserId: input.authorKind === "user" ? input.authorId : null,
          // AgentDash: remember which agent wrote an agent message — the shared
          // company inbox has no per-agent conversation link, so this is what
          // the agent page's chat tally counts.
          authorAgentId: input.authorKind === "agent" ? input.authorId : null,
          // AgentDash (GH #992): agent-authored text persists redacted.
          content: input.authorKind === "agent" ? redactRunLogText(input.body) : input.body,
          cardKind: input.cardKind ?? null,
          cardPayload:
            input.authorKind === "agent" && input.cardPayload != null
              ? (redactRunLogValue(input.cardPayload) as Record<string, unknown>)
              : (input.cardPayload ?? null),
        })
        .returning();
      const row = rows[0]!;
      const served = redactMessage(row);
      if (companyId) {
        emitMessageCreated({ ...served, companyId });
      }
      return served;
    },

    paginate: async (
      conversationId: string,
      opts: { before?: string; limit?: number },
    ) => {
      const limit = opts.limit ?? 50;
      const conditions = [eq(assistantMessages.conversationId, conversationId)];

      if (opts.before) {
        const cursor = await db
          .select({ createdAt: assistantMessages.createdAt })
          .from(assistantMessages)
          // AgentDash (security): resolve the cursor inside this conversation
          // only, so another conversation's message id cannot steer paging.
          .where(
            and(
              eq(assistantMessages.id, opts.before),
              eq(assistantMessages.conversationId, conversationId),
            ),
          )
          .limit(1);
        if (cursor[0]) {
          conditions.push(lt(assistantMessages.createdAt, cursor[0].createdAt));
        }
      }

      return db
        .select()
        .from(assistantMessages)
        .where(and(...conditions))
        .orderBy(desc(assistantMessages.createdAt))
        .limit(limit)
        .then((rows) => rows.map(redactMessage));
    },
  };
}
