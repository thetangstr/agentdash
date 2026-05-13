// Cold-signup re-engagement adapters (#228).
// Satisfy the coldSignupReengagement Deps interface against the real DB and
// Resend email transport. Kept separate from the orchestrator so the service
// stays a pure function testable with mocks.

import { and, eq, gte, notExists, sql } from "drizzle-orm";
import {
  assistantConversations,
  assistantMessages,
  authUsers,
  companyMemberships,
  reengagementEmails,
  type Db,
} from "@paperclipai/db";
import { sendEmail } from "../auth/email.js";
import { logger } from "../middleware/logger.js";

export function reengagementUserAdapter(db: Db) {
  return {
    /**
     * Lists users who:
     * - Signed up at least 7 days ago
     * - Have a verified email
     * - Have at least one active company membership
     * - Have zero assistant_messages rows (never opened the chat)
     *
     * Note: "zero messages" means zero rows in assistant_messages where the
     * user authored a message. Since assistant_messages.role = "user" indicates
     * a human-authored message, we check that the user has no user-role
     * messages in any of their companies.
     */
    listEligible: async () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Subquery: users who have at least one assistant_messages row
      const activeUserSubselect = db
        .selectDistinct({ userId: assistantConversations.userId })
        .from(assistantConversations)
        .innerJoin(
          assistantMessages,
          eq(assistantMessages.conversationId, assistantConversations.id),
        )
        .innerJoin(
          companyMemberships,
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, assistantConversations.userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .where(eq(assistantMessages.role, "user"));

      const rows = await db
        .selectDistinct({
          id: authUsers.id,
          email: authUsers.email,
          createdAt: authUsers.createdAt,
        })
        .from(authUsers)
        .innerJoin(
          companyMemberships,
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, authUsers.id),
            eq(companyMemberships.status, "active"),
          ),
        )
        .where(
          and(
            eq(authUsers.emailVerified, true),
            gte(authUsers.createdAt, sevenDaysAgo),
            // Exclude users who have sent any messages
            notExists(
              db
                .select({ one: sql`1` })
                .from(assistantConversations)
                .innerJoin(
                  assistantMessages,
                  eq(assistantMessages.conversationId, assistantConversations.id),
                )
                .where(
                  and(
                    eq(assistantConversations.userId, authUsers.id),
                    eq(assistantMessages.role, "user"),
                  ),
                ),
            ),
          ),
        );

      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        createdAt: row.createdAt,
      }));
    },
  };
}

export function reengagementSentAdapter(db: Db) {
  return {
    hasReceived: async (userId: string): Promise<boolean> => {
      const row = await db.query.reengagementEmails.findFirst({
        where: eq(reengagementEmails.userId, userId),
      });
      return !!row;
    },

    markSent: async (userId: string): Promise<void> => {
      await db.insert(reengagementEmails).values({ userId });
      logger.info({ userId }, "[reengagement] marked email sent");
    },
  };
}

export function reengagementEmailAdapter() {
  return {
    send: async (msg: { to: string; subject: string; html: string }) => {
      const result = await sendEmail({ to: msg.to, subject: msg.subject, html: msg.html });
      if (result.status === "sent") {
        logger.info({ to: msg.to }, "[reengagement] email sent");
      } else {
        logger.warn({ to: msg.to, status: result.status, error: result.error },
          "[reengagement] email failed or skipped");
      }
    },
  };
}
