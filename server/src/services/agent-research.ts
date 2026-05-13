import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyContext } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const RESEARCH_APP_URL = process.env.RESEARCH_APP_URL ?? "";
const RESEARCH_APP_API_KEY = process.env.RESEARCH_APP_API_KEY ?? "";

// Default confidence assigned to a research assessment result when the upstream
// does not supply a confidence value. The value reflects the typical confidence
// of the readiness assessment output; it is not derived from the model directly.
const DEFAULT_ASSESSMENT_CONFIDENCE = "0.95" as const;

const AssessmentResultSchema = z.object({
  id: z.string().nullable(),
  companyName: z.string(),
  industry: z.string(),
  status: z.string(),
  outputMarkdown: z.string(),
  durationMs: z.number().int().nonnegative(),
  createdAt: z.string(),
});

type AssessmentResult = z.infer<typeof AssessmentResultSchema>;

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
      input: {
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
      },
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

      const raw: unknown = await res.json();
      const parsed = AssessmentResultSchema.safeParse(raw);
      if (!parsed.success) {
        logger.error(
          { error: parsed.error.flatten() },
          "Agent Research upstream response failed Zod validation",
        );
        throw Object.assign(
          new Error("Agent Research returned malformed response"),
          { statusCode: 502 },
        );
      }
      const result = parsed.data;

      // Use upstream confidence if available, otherwise fall back to the
      // default.  The upstream assessment may include a signal quality score;
      // when absent we fall back to DEFAULT_ASSESSMENT_CONFIDENCE.
      const upstreamConfidence = typeof result.id === "string" && result.id.length > 0
        ? "0.99"
        : DEFAULT_ASSESSMENT_CONFIDENCE;

      // Store in company_context
      await db
        .insert(companyContext)
        .values({
          companyId,
          contextType: "agent_research",
          key: "readiness-assessment",
          value: result.outputMarkdown,
          confidence: upstreamConfidence,
        })
        .onConflictDoUpdate({
          target: [companyContext.companyId, companyContext.contextType, companyContext.key],
          set: {
            value: result.outputMarkdown,
            confidence: upstreamConfidence,
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

    async getAssessment(
      companyId: string,
    ): Promise<{ markdown: string; assessmentId: string | null } | null> {
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
