import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assistantConversations,
  assistantConversationParticipants,
  assistantMessages,
} from "@paperclipai/db";
import { emitMessageCreated, emitMessageRead } from "../realtime/conversation-events.js";

export function conversationService(db: Db) {
  return {
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
      const rows = await db
        .insert(assistantMessages)
        .values({
          conversationId: input.conversationId,
          role: input.authorKind,
          content: input.body,
          cardKind: input.cardKind ?? null,
          cardPayload: input.cardPayload ?? null,
        })
        .returning();
      const row = rows[0]!;
      if (input.companyId) {
        emitMessageCreated({ ...row, companyId: input.companyId });
      }
      return row;
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
          .where(eq(assistantMessages.id, opts.before))
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
        .limit(limit);
    },
  };
}
