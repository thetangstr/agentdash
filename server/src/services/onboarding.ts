import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  onboardingSessions,
  onboardingSources,
  companyContext,
  agentTemplates,
  agents,
} from "@paperclipai/db";
import { notFound } from "../errors.js";

export function onboardingService(db: Db) {
  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async function createSession(companyId: string, createdByUserId: string) {
    return db
      .insert(onboardingSessions)
      .values({
        companyId,
        createdByUserId,
        status: "in_progress",
        currentStep: "discovery",
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function getSession(id: string) {
    const row = await db
      .select()
      .from(onboardingSessions)
      .where(eq(onboardingSessions.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Onboarding session not found");
    return row;
  }

  async function updateSession(
    id: string,
    data: Partial<
      Pick<
        typeof onboardingSessions.$inferInsert,
        "currentStep" | "context" | "status" | "completedAt"
      >
    >,
  ) {
    const row = await db
      .update(onboardingSessions)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(onboardingSessions.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Onboarding session not found");
    return row;
  }

  // ---------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------

  async function ingestSource(
    companyId: string,
    sessionId: string,
    data: { sourceType: string; sourceLocator: string; rawContent?: string },
  ) {
    return db
      .insert(onboardingSources)
      .values({
        companyId,
        sessionId,
        sourceType: data.sourceType,
        sourceLocator: data.sourceLocator,
        rawContent: data.rawContent,
        status: "pending",
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function listSources(companyId: string, sessionId: string) {
    return db
      .select()
      .from(onboardingSources)
      .where(
        and(
          eq(onboardingSources.companyId, companyId),
          eq(onboardingSources.sessionId, sessionId),
        ),
      );
  }

  async function updateSource(
    id: string,
    data: Partial<
      Pick<
        typeof onboardingSources.$inferInsert,
        "status" | "extractedSummary" | "extractedEntities" | "errorMessage"
      >
    >,
  ) {
    const row = await db
      .update(onboardingSources)
      .set(data)
      .where(eq(onboardingSources.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Onboarding source not found");
    return row;
  }

  // ---------------------------------------------------------------------------
  // Context extraction (placeholder — production would call LLM)
  // ---------------------------------------------------------------------------

  async function extractContext(companyId: string, sessionId: string) {
    const pendingSources = await db
      .select()
      .from(onboardingSources)
      .where(
        and(
          eq(onboardingSources.companyId, companyId),
          eq(onboardingSources.sessionId, sessionId),
          eq(onboardingSources.status, "pending"),
        ),
      );

    const createdEntries: Array<typeof companyContext.$inferSelect> = [];

    for (const source of pendingSources) {
      await db
        .update(onboardingSources)
        .set({ status: "completed" })
        .where(eq(onboardingSources.id, source.id));

      const entry = await db
        .insert(companyContext)
        .values({
          companyId,
          contextType: "domain",
          key: source.sourceLocator,
          value: (source.rawContent ?? "").slice(0, 500),
          confidence: "0.80",
          sourceId: source.id,
        })
        .returning()
        .then((rows) => rows[0]);

      createdEntries.push(entry);
    }

    return createdEntries;
  }

  // ---------------------------------------------------------------------------
  // Company Context
  // ---------------------------------------------------------------------------

  async function listContext(companyId: string) {
    return db
      .select()
      .from(companyContext)
      .where(eq(companyContext.companyId, companyId));
  }

  async function updateContext(
    id: string,
    data: Partial<
      Pick<
        typeof companyContext.$inferInsert,
        "value" | "verifiedByUserId" | "confidence"
      >
    >,
  ) {
    const row = await db
      .update(companyContext)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(companyContext.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company context entry not found");
    return row;
  }

  // ---------------------------------------------------------------------------
  // Team suggestions (placeholder — production would use LLM ranking)
  // ---------------------------------------------------------------------------

  async function suggestTeam(companyId: string, _sessionId: string) {
    const templates = await db
      .select()
      .from(agentTemplates)
      .where(
        and(
          eq(agentTemplates.companyId, companyId),
          isNull(agentTemplates.archivedAt),
        ),
      );

    return templates;
  }

  async function applyTeam(
    companyId: string,
    suggestions: Array<{
      templateId: string;
      name?: string;
      overrides?: Record<string, unknown>;
    }>,
  ) {
    const createdAgents: Array<typeof agents.$inferSelect> = [];

    for (const suggestion of suggestions) {
      const template = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.id, suggestion.templateId))
        .then((rows) => rows[0] ?? null);

      if (!template) continue;

      const agent = await db
        .insert(agents)
        .values({
          companyId,
          name: suggestion.name ?? template.name,
          role: template.role,
          icon: template.icon,
          adapterType: template.adapterType,
          adapterConfig: { ...template.adapterConfig, ...(suggestion.overrides ?? {}) },
          runtimeConfig: template.runtimeConfig,
          budgetMonthlyCents: template.budgetMonthlyCents,
          permissions: template.permissions,
          metadata: { templateId: template.id },
        })
        .returning()
        .then((rows) => rows[0]);

      createdAgents.push(agent);
    }

    return createdAgents;
  }

  // ---------------------------------------------------------------------------
  // Complete session
  // ---------------------------------------------------------------------------

  async function completeSession(id: string) {
    const row = await db
      .update(onboardingSessions)
      .set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(onboardingSessions.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Onboarding session not found");
    return row;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    createSession,
    getSession,
    updateSession,
    ingestSource,
    listSources,
    updateSource,
    extractContext,
    listContext,
    updateContext,
    suggestTeam,
    applyTeam,
    completeSession,
  };
}
