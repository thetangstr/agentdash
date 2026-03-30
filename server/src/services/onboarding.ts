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
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// AgentDash: LLM helper — calls Anthropic Messages API via native fetch.
// Gracefully degrades when ANTHROPIC_API_KEY is not set.
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

async function callLlm(
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "Anthropic API call failed — falling back to placeholder behavior",
      );
      return null;
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    return data.content?.find((b) => b.type === "text")?.text ?? null;
  } catch (err) {
    logger.warn({ err }, "LLM call error — falling back to placeholder");
    return null;
  }
}

function parseJsonResponse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
    return JSON.parse(cleaned);
  } catch {
    logger.warn(
      { snippet: raw.slice(0, 200) },
      "Failed to parse LLM JSON response",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// AgentDash: LLM-powered context extraction
// ---------------------------------------------------------------------------

interface ExtractedItem {
  contextType: string;
  key: string;
  value: string;
  confidence: number;
}

async function llmExtractContext(
  rawContent: string,
  sourceLocator: string,
): Promise<ExtractedItem[] | null> {
  const systemPrompt = `You are an expert business analyst. Extract structured context about a company from the provided content. Return a JSON array of objects with:
- "contextType": one of "domain", "product", "team_structure", "tech_stack", "pain_point"
- "key": a short slug identifier (e.g. "primary-industry", "main-product")
- "value": concise description (1-3 sentences)
- "confidence": number 0.50-0.99

Extract as many distinct items as you can. Return ONLY valid JSON.`;

  const result = await callLlm(
    systemPrompt,
    `Source: ${sourceLocator}\n\nContent:\n${rawContent.slice(0, 8000)}`,
  );

  const parsed = parseJsonResponse<ExtractedItem[]>(result);
  if (!Array.isArray(parsed)) return null;

  return parsed
    .filter((item): item is Record<string, unknown> & ExtractedItem =>
      typeof item === "object" && item !== null,
    )
    .map((item) => ({
      contextType: String(item.contextType ?? "domain"),
      key: String(item.key ?? "unknown"),
      value: String(item.value ?? ""),
      confidence: Math.max(0.5, Math.min(0.99, Number(item.confidence) || 0.8)),
    }));
}

// ---------------------------------------------------------------------------
// AgentDash: LLM-powered template ranking
// ---------------------------------------------------------------------------

interface RankedTemplate {
  templateId: string;
  relevanceScore: number;
  reason: string;
}

async function llmRankTemplates(
  contextEntries: Array<{ contextType: string; key: string; value: string }>,
  templates: Array<{ id: string; name: string; description: string | null; role: string; skillKeys: string[] }>,
): Promise<RankedTemplate[] | null> {
  if (templates.length === 0) return [];

  const systemPrompt = `You are an expert at matching AI agent templates to company needs. Given company context and available templates, rank them by relevance. Return a JSON array with:
- "templateId": the template UUID
- "relevanceScore": 0.0-1.0
- "reason": 1-2 sentence explanation

Include ALL templates sorted most to least relevant. Return ONLY valid JSON.`;

  const contextSummary = contextEntries
    .map((c) => `[${c.contextType}] ${c.key}: ${c.value}`)
    .join("\n");

  const templateSummary = templates
    .map((t) => `- ID: ${t.id} | Name: ${t.name} | Role: ${t.role} | Desc: ${t.description ?? "(none)"} | Skills: ${t.skillKeys.join(", ") || "(none)"}`)
    .join("\n");

  const result = await callLlm(
    systemPrompt,
    `Company Context:\n${contextSummary}\n\nTemplates:\n${templateSummary}`,
  );

  const parsed = parseJsonResponse<RankedTemplate[]>(result);
  if (!Array.isArray(parsed)) return null;

  return parsed
    .filter((item): item is Record<string, unknown> & RankedTemplate =>
      typeof item === "object" && item !== null && typeof (item as any).templateId === "string",
    )
    .map((item) => ({
      templateId: String(item.templateId),
      relevanceScore: Math.max(0, Math.min(1, Number(item.relevanceScore) || 0)),
      reason: String(item.reason ?? ""),
    }));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

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
  // AgentDash: Context extraction — LLM-powered with placeholder fallback
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
      // Attempt LLM extraction
      const extracted = await llmExtractContext(
        source.rawContent ?? "",
        source.sourceLocator,
      );

      if (extracted && extracted.length > 0) {
        // LLM succeeded — store each extracted item
        for (const item of extracted) {
          const entry = await db
            .insert(companyContext)
            .values({
              companyId,
              contextType: item.contextType,
              key: item.key,
              value: item.value,
              confidence: item.confidence.toFixed(2),
              sourceId: source.id,
            })
            .returning()
            .then((rows) => rows[0]);

          createdEntries.push(entry);
        }

        await db
          .update(onboardingSources)
          .set({
            status: "completed",
            extractedSummary: extracted.map((i) => `${i.key}: ${i.value}`).join("; ").slice(0, 1000),
            extractedEntities: Object.fromEntries(extracted.map((i) => [i.key, i.contextType])),
          })
          .where(eq(onboardingSources.id, source.id));
      } else {
        // Fallback: truncate raw content (original placeholder behavior)
        if (!process.env.ANTHROPIC_API_KEY) {
          logger.info("ANTHROPIC_API_KEY not set — using placeholder context extraction");
        }

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
  // AgentDash: Team suggestions — LLM-ranked with unranked fallback
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

    // Gather company context for LLM ranking
    const context = await db
      .select()
      .from(companyContext)
      .where(eq(companyContext.companyId, companyId));

    if (context.length > 0 && templates.length > 0) {
      const ranked = await llmRankTemplates(
        context.map((c) => ({
          contextType: c.contextType,
          key: c.key,
          value: c.value,
        })),
        templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          role: t.role,
          skillKeys: t.skillKeys ?? [],
        })),
      );

      if (ranked && ranked.length > 0) {
        // Build a map for O(1) lookup
        const rankMap = new Map(ranked.map((r) => [r.templateId, r]));
        return templates
          .map((t) => {
            const rank = rankMap.get(t.id);
            return {
              ...t,
              relevanceScore: rank?.relevanceScore ?? 0.5,
              reason: rank?.reason ?? "Not ranked by LLM",
            };
          })
          .sort((a, b) => b.relevanceScore - a.relevanceScore);
      }
    }

    // Fallback: return all templates unranked
    if (!process.env.ANTHROPIC_API_KEY) {
      logger.info("ANTHROPIC_API_KEY not set — returning unranked template suggestions");
    }
    return templates.map((t) => ({
      ...t,
      relevanceScore: 0.5,
      reason: "Unranked — LLM ranking unavailable",
    }));
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
