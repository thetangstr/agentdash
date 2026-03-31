import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  onboardingSessions,
  onboardingSources,
  companyContext,
  agentTemplates,
  agents,
  companies,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { budgetForecastService } from "./budget-forecasts.js";
import { policyEngineService } from "./policy-engine.js";
import { agentFactoryService } from "./agent-factory.js";
import { goalService } from "./goals.js";
import { projectService } from "./projects.js";
import { issueService } from "./issues.js";

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
// AgentDash: Plan types
// ---------------------------------------------------------------------------

interface OnboardingPlan {
  generatedAt: string;
  status: "draft" | "approved" | "applied" | "failed";
  companyProfile: {
    name: string;
    industry: string;
    size: string;
    summary: string;
  };
  departments: Array<{ name: string; description: string }>;
  securityPolicies: Array<{
    name: string;
    description: string;
    policyType: string;
    targetType: string;
    rules: Array<Record<string, unknown>>;
  }>;
  agentTemplates: Array<{
    slug: string;
    name: string;
    role: string;
    description: string;
    skillKeys: string[];
    budgetMonthlyCents: number;
    departmentName: string;
  }>;
  goals: Array<{
    title: string;
    description: string;
    level: string;
    priority: string;
    targetDate?: string;
  }>;
  projects: Array<{
    name: string;
    description: string;
    issues: Array<{ title: string; description: string }>;
  }>;
}

interface PlanApplyResult {
  status: "success" | "partial" | "failed";
  departments: Array<{ name: string; id: string }>;
  securityPolicies: Array<{ name: string; id: string }>;
  goals: Array<{ title: string; id: string }>;
  agentTemplates: Array<{ name: string; id: string }>;
  spawnRequests: Array<{ templateName: string; id: string; approvalId: string }>;
  projects: Array<{ name: string; id: string; issueIds: string[] }>;
  errors: Array<{ step: string; entity: string; error: string }>;
}

// ---------------------------------------------------------------------------
// AgentDash: LLM-powered plan generation
// ---------------------------------------------------------------------------

async function llmGeneratePlan(
  contextEntries: Array<{ contextType: string; key: string; value: string }>,
  companyName: string,
  rawSources: string[],
): Promise<OnboardingPlan | null> {
  const systemPrompt = `You are an expert AI operations architect designing an onboarding plan for an AI agent orchestration platform called AgentDash.

Given company context, generate a complete onboarding plan. Analyze the company's specific pain points, team structure, and operational needs to produce a tailored plan — not generic templates.

Return a JSON object with this EXACT structure:
{
  "companyProfile": { "name": string, "industry": string, "size": string, "summary": string },
  "departments": [{ "name": string, "description": string }],
  "securityPolicies": [{ "name": string, "description": string, "policyType": string, "targetType": string, "rules": [{ "action": string, ... }] }],
  "agentTemplates": [{ "slug": string, "name": string, "role": string, "description": string, "skillKeys": string[], "budgetMonthlyCents": number, "departmentName": string }],
  "goals": [{ "title": string, "description": string, "level": string, "priority": string, "targetDate": string }],
  "projects": [{ "name": string, "description": string, "issues": [{ "title": string, "description": string }] }]
}

Rules:
- policyType: "resource_access" | "action_limit" | "escalation_path" | "data_boundary" | "blast_radius"
- targetType: "agent" | "role" | "project" | "company"
- role: "ceo" | "cto" | "cmo" | "cfo" | "engineer" | "designer" | "pm" | "qa" | "devops" | "researcher" | "general"
- goal level: "company" | "team" | "agent" | "task"
- goal priority: "critical" | "high" | "medium" | "low"
- slug: lowercase kebab-case, unique
- budgetMonthlyCents: reasonable range (10000-200000 = $100-$2000/month)
- Generate 2-5 departments matching the company's org structure
- Generate 1-4 security policies reflecting their approval rules and risk boundaries
- Generate 3-8 agent templates matching their specific use cases and agent descriptions
- Generate 2-5 goals tied to their measurable business outcomes
- Generate 1-3 projects with 2-5 issues each aligned to their phased rollout
- departmentName must exactly match a department name you generate
- targetDate: ISO 8601 format, 30-90 days from now
- For security policies with dollar thresholds, encode them in the rules array

Return ONLY valid JSON. No markdown, no commentary.`;

  const contextSummary = contextEntries
    .map((c) => `[${c.contextType}] ${c.key}: ${c.value}`)
    .join("\n");

  // Include raw source content for richer plan generation
  const sourceSummary = rawSources.length > 0
    ? `\n\nRaw Source Materials:\n${rawSources.join("\n---\n").slice(0, 12000)}`
    : "";

  const result = await callLlm(
    systemPrompt,
    `Company: ${companyName}\n\nExtracted Context:\n${contextSummary || "(no context extracted)"}${sourceSummary}`,
  );

  const parsed = parseJsonResponse<Omit<OnboardingPlan, "generatedAt" | "status">>(result);
  if (!parsed || !parsed.departments || !parsed.agentTemplates) return null;

  return {
    ...parsed,
    generatedAt: new Date().toISOString(),
    status: "draft",
  };
}

function generateFallbackPlan(
  companyName: string,
  contextEntries: Array<{ contextType: string; key: string; value: string }>,
): OnboardingPlan {
  const industryEntry = contextEntries.find(
    (c) => c.contextType === "domain" || c.key.includes("industry"),
  );
  const industry = industryEntry?.value?.slice(0, 100) ?? "Technology";

  const sizeEntry = contextEntries.find(
    (c) => c.key.includes("size") || c.key.includes("employee"),
  );
  const size = sizeEntry?.value?.slice(0, 50) ?? "Small-Medium";

  const now = new Date();
  const d60 = new Date(now.getTime() + 60 * 86400000).toISOString();
  const d90 = new Date(now.getTime() + 90 * 86400000).toISOString();

  return {
    generatedAt: now.toISOString(),
    status: "draft",
    companyProfile: {
      name: companyName,
      industry,
      size,
      summary: `${companyName} — onboarding plan generated without LLM.`,
    },
    departments: [
      { name: "Engineering", description: "Product development and infrastructure" },
      { name: "Operations", description: "Business operations and support" },
    ],
    securityPolicies: [
      {
        name: "Default Action Limit",
        description: "Rate-limit all agent actions company-wide",
        policyType: "action_limit",
        targetType: "company",
        rules: [{ action: "deploy", maxPerHour: 10 }],
      },
    ],
    agentTemplates: [
      {
        slug: "tech-lead",
        name: "Tech Lead",
        role: "cto",
        description: "Senior technical leadership and architecture decisions",
        skillKeys: ["code-review", "architecture"],
        budgetMonthlyCents: 50000,
        departmentName: "Engineering",
      },
      {
        slug: "software-engineer",
        name: "Software Engineer",
        role: "engineer",
        description: "Core development and feature implementation",
        skillKeys: ["frontend", "backend"],
        budgetMonthlyCents: 30000,
        departmentName: "Engineering",
      },
      {
        slug: "qa-engineer",
        name: "QA Engineer",
        role: "qa",
        description: "Quality assurance and testing",
        skillKeys: ["testing", "automation"],
        budgetMonthlyCents: 20000,
        departmentName: "Engineering",
      },
    ],
    goals: [
      {
        title: `${companyName} Launch Goal`,
        description: "Complete initial platform setup and agent deployment",
        level: "company",
        priority: "high",
        targetDate: d60,
      },
      {
        title: "Establish Agent Workflow",
        description: "Define and optimize agent task pipelines",
        level: "team",
        priority: "medium",
        targetDate: d90,
      },
    ],
    projects: [
      {
        name: "Initial Setup",
        description: "Bootstrap project for first sprint",
        issues: [
          { title: "Define team structure", description: "Map roles and responsibilities" },
          { title: "Configure CI/CD pipeline", description: "Set up automated build and deploy" },
          { title: "Write onboarding docs", description: "Document agent usage guidelines" },
        ],
      },
    ],
  };
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
  // AgentDash: Plan generation — LLM-powered with fallback
  // ---------------------------------------------------------------------------

  async function generatePlan(companyId: string, sessionId: string) {
    await getSession(sessionId);

    // Gather company context
    const context = await db
      .select()
      .from(companyContext)
      .where(eq(companyContext.companyId, companyId));

    // Get company name
    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    const companyName = company?.name ?? "Unknown Company";

    const contextEntries = context.map((c) => ({
      contextType: c.contextType,
      key: c.key,
      value: c.value,
    }));

    // Also gather raw source content for richer plan generation
    const sources = await db
      .select()
      .from(onboardingSources)
      .where(eq(onboardingSources.companyId, companyId));
    const rawSources = sources
      .map((s) => s.rawContent)
      .filter((c): c is string => !!c);

    // Attempt LLM plan generation
    let plan = await llmGeneratePlan(contextEntries, companyName, rawSources);

    if (!plan) {
      if (!process.env.ANTHROPIC_API_KEY) {
        logger.info("ANTHROPIC_API_KEY not set — generating fallback onboarding plan");
      }
      plan = generateFallbackPlan(companyName, contextEntries);
    }

    // Store plan in session context
    const session = await getSession(sessionId);
    const existingContext = (session.context ?? {}) as Record<string, unknown>;
    const updatedSession = await updateSession(sessionId, {
      context: { ...existingContext, plan },
      currentStep: "plan_review",
    });

    return { plan, session: updatedSession };
  }

  // ---------------------------------------------------------------------------
  // AgentDash: Plan update (user edits before applying)
  // ---------------------------------------------------------------------------

  async function updatePlan(
    companyId: string,
    sessionId: string,
    planEdits: Partial<OnboardingPlan>,
  ) {
    const session = await getSession(sessionId);
    const existingContext = (session.context ?? {}) as Record<string, unknown>;
    const existingPlan = existingContext.plan as OnboardingPlan | undefined;

    if (!existingPlan) {
      throw unprocessable("No plan exists for this session. Generate a plan first.");
    }

    const updatedPlan: OnboardingPlan = {
      ...existingPlan,
      ...planEdits,
      generatedAt: existingPlan.generatedAt,
    };

    const updatedSession = await updateSession(sessionId, {
      context: { ...existingContext, plan: updatedPlan },
    });

    return { plan: updatedPlan, session: updatedSession };
  }

  // ---------------------------------------------------------------------------
  // AgentDash: Plan execution — calls existing services in order
  // ---------------------------------------------------------------------------

  async function applyPlan(companyId: string, sessionId: string) {
    const session = await getSession(sessionId);
    const existingContext = (session.context ?? {}) as Record<string, unknown>;
    const plan = existingContext.plan as OnboardingPlan | undefined;

    if (!plan) {
      throw unprocessable("No plan exists for this session. Generate a plan first.");
    }

    if (plan.status === "applied") {
      throw unprocessable("This plan has already been applied.");
    }

    const forecast = budgetForecastService(db);
    const policy = policyEngineService(db);
    const factory = agentFactoryService(db);
    const goalSvc = goalService(db);
    const projectSvc = projectService(db);
    const issueSvc = issueService(db);

    const result: PlanApplyResult = {
      status: "success",
      departments: [],
      securityPolicies: [],
      goals: [],
      agentTemplates: [],
      spawnRequests: [],
      projects: [],
      errors: [],
    };

    const departmentIdMap = new Map<string, string>();

    // --- Step 1: Create departments ---
    for (const dept of plan.departments) {
      try {
        const created = await forecast.createDepartment(companyId, {
          name: dept.name,
          description: dept.description,
        });
        departmentIdMap.set(dept.name, created.id);
        result.departments.push({ name: dept.name, id: created.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ step: "departments", entity: dept.name, error: msg });
      }
    }

    // --- Step 2: Create security policies ---
    for (const pol of plan.securityPolicies) {
      try {
        const created = await policy.createPolicy(companyId, {
          name: pol.name,
          description: pol.description,
          policyType: pol.policyType,
          targetType: pol.targetType,
          targetId: pol.targetType === "company" ? companyId : undefined,
          rules: pol.rules,
        });
        result.securityPolicies.push({ name: pol.name, id: created.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ step: "securityPolicies", entity: pol.name, error: msg });
      }
    }

    // --- Step 3: Create goals ---
    for (const goal of plan.goals) {
      try {
        const created = await goalSvc.create(companyId, {
          title: goal.title,
          description: goal.description,
          level: goal.level as any,
          priority: goal.priority as any,
          status: "planned",
          targetDate: goal.targetDate ? new Date(goal.targetDate) : null,
        });
        result.goals.push({ title: goal.title, id: created.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ step: "goals", entity: goal.title, error: msg });
      }
    }

    // --- Step 4: Create agent templates (with department ID lookup) ---
    for (const tmpl of plan.agentTemplates) {
      try {
        const departmentId = departmentIdMap.get(tmpl.departmentName) ?? null;
        const created = await factory.createTemplate(companyId, {
          slug: tmpl.slug,
          name: tmpl.name,
          role: tmpl.role,
          description: tmpl.description,
          skillKeys: tmpl.skillKeys,
          budgetMonthlyCents: tmpl.budgetMonthlyCents,
          departmentId,
        });
        result.agentTemplates.push({ name: tmpl.name, id: created.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ step: "agentTemplates", entity: tmpl.name, error: msg });
      }
    }

    // --- Step 5: Create spawn requests for each template ---
    for (const createdTemplate of result.agentTemplates) {
      try {
        const spawnResult = await factory.requestSpawn(companyId, {
          templateId: createdTemplate.id,
          quantity: 1,
          reason: "Auto-spawned by onboarding plan",
        });
        result.spawnRequests.push({
          templateName: createdTemplate.name,
          id: spawnResult.spawnRequest.id,
          approvalId: spawnResult.approval.id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ step: "spawnRequests", entity: createdTemplate.name, error: msg });
      }
    }

    // --- Step 6: Create projects and issues ---
    for (const proj of plan.projects) {
      try {
        const createdProject = await projectSvc.create(companyId, {
          name: proj.name,
          description: proj.description,
        });
        const issueIds: string[] = [];

        for (const issue of proj.issues) {
          try {
            const createdIssue = await issueSvc.create(companyId, {
              title: issue.title,
              description: issue.description,
              projectId: createdProject.id,
            });
            issueIds.push(createdIssue.id);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push({ step: "issues", entity: `${proj.name}/${issue.title}`, error: msg });
          }
        }

        result.projects.push({ name: proj.name, id: createdProject.id, issueIds });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ step: "projects", entity: proj.name, error: msg });
      }
    }

    // --- Update plan status ---
    const totalCreated =
      result.departments.length +
      result.securityPolicies.length +
      result.goals.length +
      result.agentTemplates.length +
      result.projects.length;

    if (totalCreated === 0 && result.errors.length > 0) {
      result.status = "failed";
    } else if (result.errors.length > 0) {
      result.status = "partial";
    }

    const planStatus: OnboardingPlan["status"] =
      totalCreated === 0 ? "failed" : result.errors.length > 0 ? "applied" : "applied";

    const updatedPlan: OnboardingPlan = { ...plan, status: planStatus };
    await updateSession(sessionId, {
      context: { ...existingContext, plan: updatedPlan, applyResult: result },
      currentStep: totalCreated > 0 ? "bootstrap" : session.currentStep,
    });

    return result;
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
    generatePlan,
    updatePlan,
    applyPlan,
    completeSession,
  };
}
