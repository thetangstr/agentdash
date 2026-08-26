import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, onboardingSessions } from "@paperclipai/db";

export const MEMBER_ONBOARDING_STEPS = ["welcome", "workspace"] as const;
export type MemberOnboardingStep = (typeof MEMBER_ONBOARDING_STEPS)[number];

export function memberOnboardingService(db: Db) {
  return {
    startOrResume: async (companyId: string, userId: string) => {
      await db
        .insert(onboardingSessions)
        .values({ companyId, createdByUserId: userId, currentStep: "welcome" })
        .onConflictDoNothing({
          target: [onboardingSessions.companyId, onboardingSessions.createdByUserId],
        });

      return db
        .select()
        .from(onboardingSessions)
        .where(
          and(
            eq(onboardingSessions.companyId, companyId),
            eq(onboardingSessions.createdByUserId, userId),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },

    listForUser: async (userId: string, companyIds: string[]) => {
      if (companyIds.length === 0) return [];
      return db
        .select({
          id: onboardingSessions.id,
          companyId: onboardingSessions.companyId,
          companyName: companies.name,
          issuePrefix: companies.issuePrefix,
          status: onboardingSessions.status,
          currentStep: onboardingSessions.currentStep,
          completedAt: onboardingSessions.completedAt,
          updatedAt: onboardingSessions.updatedAt,
        })
        .from(onboardingSessions)
        .innerJoin(companies, eq(companies.id, onboardingSessions.companyId))
        .where(
          and(
            eq(onboardingSessions.createdByUserId, userId),
            inArray(onboardingSessions.companyId, companyIds),
          ),
        );
    },

    advance: async (companyId: string, userId: string, currentStep: MemberOnboardingStep) =>
      db
        .update(onboardingSessions)
        .set({ currentStep, updatedAt: new Date() })
        .where(
          and(
            eq(onboardingSessions.companyId, companyId),
            eq(onboardingSessions.createdByUserId, userId),
            eq(onboardingSessions.status, "in_progress"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null),

    complete: async (companyId: string, userId: string) => {
      const now = new Date();
      return db
        .update(onboardingSessions)
        .set({ status: "completed", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(onboardingSessions.companyId, companyId),
            eq(onboardingSessions.createdByUserId, userId),
            eq(onboardingSessions.status, "in_progress"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
