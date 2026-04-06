/**
 * AgentDash Integration: Agent Research Service
 *
 * Copy this file to: agentdash/server/src/services/agent-research.ts
 *
 * Then register the route in app.ts:
 *   import { agentResearchRoutes } from "./routes/agent-research.js";
 *   api.use(agentResearchRoutes(db));
 *
 * Required env vars:
 *   RESEARCH_APP_URL=https://your-research-app.vercel.app
 *   RESEARCH_APP_API_KEY=ark_...
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { companyContext } from "@agentdash/db";
import { logger } from "../middleware/logger.js";

const RESEARCH_APP_URL = process.env.RESEARCH_APP_URL ?? "";
const RESEARCH_APP_API_KEY = process.env.RESEARCH_APP_API_KEY ?? "";

interface AssessmentInput {
  companyName: string;
  industry: string;
  industrySlug?: string;
  description?: string;
  companyUrl?: string;
  employeeRange?: string;
  revenueRange?: string;
  currentSystems?: string;
  automationLevel?: string;
  challenges?: string;
  selectedFunctions?: string[];
  primaryGoal?: string;
  targets?: string;
  timeline?: string;
  budgetRange?: string;
}

interface AssessmentResult {
  id: string | null;
  companyName: string;
  industry: string;
  status: string;
  outputMarkdown: string;
  durationMs: number;
  createdAt: string;
}

function toSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function agentResearchService(db: Db) {
  return {
    async requestAssessment(
      companyId: string,
      input: AssessmentInput,
    ): Promise<AssessmentResult> {
      if (!RESEARCH_APP_URL || !RESEARCH_APP_API_KEY) {
        throw Object.assign(
          new Error("Agent Research app not configured. Set RESEARCH_APP_URL and RESEARCH_APP_API_KEY."),
          { statusCode: 503 },
        );
      }

      const res = await fetch(`${RESEARCH_APP_URL}/api/assess`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEARCH_APP_API_KEY}`,
        },
        body: JSON.stringify({
          ...input,
          industrySlug: input.industrySlug ?? toSlug(input.industry),
          externalRef: companyId,
          format: "json",
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "unknown error");
        logger.error({ status: res.status, body }, "Agent Research API error");
        throw Object.assign(
          new Error(`Research API returned ${res.status}: ${body}`),
          { statusCode: 502 },
        );
      }

      const result: AssessmentResult = await res.json();

      // Store in company_context
      await db
        .insert(companyContext)
        .values({
          companyId,
          contextType: "agent_research",
          key: "readiness-assessment",
          value: result.outputMarkdown,
          confidence: "0.95",
        })
        .onConflictDoUpdate({
          target: [companyContext.companyId, companyContext.contextType, companyContext.key],
          set: {
            value: result.outputMarkdown,
            confidence: "0.95",
            updatedAt: new Date(),
          },
        });

      if (result.id) {
        await db
          .insert(companyContext)
          .values({
            companyId,
            contextType: "agent_research",
            key: "assessment-id",
            value: result.id,
            confidence: "0.99",
          })
          .onConflictDoUpdate({
            target: [companyContext.companyId, companyContext.contextType, companyContext.key],
            set: { value: result.id, updatedAt: new Date() },
          });
      }

      return result;
    },

    async getAssessment(companyId: string): Promise<{ markdown: string; assessmentId: string | null } | null> {
      const rows = await db
        .select()
        .from(companyContext)
        .where(
          and(
            eq(companyContext.companyId, companyId),
            eq(companyContext.contextType, "agent_research"),
          ),
        );

      const markdownRow = rows.find((r) => r.key === "readiness-assessment");
      const idRow = rows.find((r) => r.key === "assessment-id");

      if (!markdownRow) return null;
      return { markdown: markdownRow.value, assessmentId: idRow?.value ?? null };
    },
  };
}
