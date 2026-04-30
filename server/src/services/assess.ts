/**
 * Agent Readiness Assessment service.
 * Uses MiniMax (Anthropic-compatible API) — runs before customer keys are configured.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { companyContext } from "@agentdash/db";
import { logger } from "../middleware/logger.js";
import { retrieveContext, type AssessmentInput } from "./assess-retrieval.js";
import {
  serializeContext,
  buildSystemPrompt,
  buildUserPrompt,
  buildJumpstartPrompt,
} from "./assess-prompts.js";

const MINIMAX_BASE_URL = process.env.ASSESS_MINIMAX_BASE_URL ?? "https://api.minimaxi.com/anthropic";
const MINIMAX_MODEL = process.env.ASSESS_MINIMAX_MODEL ?? "MiniMax-M2.7-highspeed";

function getApiKey(): string {
  const key = process.env.ASSESS_MINIMAX_API_KEY?.trim();
  if (!key) throw Object.assign(new Error("ASSESS_MINIMAX_API_KEY is not configured"), { statusCode: 503 });
  return key;
}

const INDUSTRIES = [
  "Public Sector", "E-Commerce", "Insurance", "Healthcare", "Logistics",
  "Financial Services", "Manufacturing", "Real Estate", "Legal", "Education",
  "Tech/SaaS", "Retail", "Energy/Utilities", "Telecom",
  "Media/Entertainment", "Construction", "Hospitality", "Agriculture",
];

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  Healthcare: ["health", "medical", "hospital", "clinical", "patient", "pharma", "biotech"],
  "Financial Services": ["bank", "financial", "investment", "wealth", "capital", "fintech"],
  Insurance: ["insurance", "underwriting", "claims", "policyholder"],
  "E-Commerce": ["shop", "store", "cart", "ecommerce", "e-commerce", "marketplace"],
  Retail: ["retail", "apparel", "footwear", "fashion", "clothing"],
  "Tech/SaaS": ["software", "saas", "platform", "cloud", "api", "developer"],
  Logistics: ["logistics", "shipping", "freight", "supply chain", "warehouse"],
  Manufacturing: ["manufacturing", "factory", "production", "assembly"],
  Construction: ["construction", "building", "architecture"],
  "Real Estate": ["real estate", "property", "realty"],
  Legal: ["law firm", "legal", "attorney", "counsel"],
  Education: ["education", "university", "school", "learning"],
  "Public Sector": ["government", "federal", "public sector", "municipal"],
  "Energy/Utilities": ["energy", "utility", "oil", "gas", "renewable", "solar"],
  Telecom: ["telecom", "wireless", "mobile", "network"],
  "Media/Entertainment": ["media", "entertainment", "streaming", "content"],
  Hospitality: ["hotel", "hospitality", "restaurant", "travel"],
  Agriculture: ["agriculture", "farming", "crop", "livestock"],
};

function detectIndustry(text: string): string {
  const lower = text.toLowerCase();
  const scores: { industry: string; count: number }[] = [];
  for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    const count = keywords.filter((kw) => lower.includes(kw)).length;
    if (count > 0) scores.push({ industry, count });
  }
  scores.sort((a, b) => b.count - a.count);
  return scores[0]?.industry ?? "";
}

function extractSummary(text: string): string {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 30);
  return sentences.slice(0, 3).join(". ").trim().slice(0, 300) + (sentences.length > 3 ? "..." : ".");
}

async function fetchWebsite(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "AgentDash-Assess/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

export function assessService(db: Db) {
  return {
    async research(companyUrl: string, companyName: string) {
      let normalizedUrl = companyUrl;
      if (normalizedUrl && !normalizedUrl.startsWith("http")) normalizedUrl = "https://" + normalizedUrl;

      const websiteText = normalizedUrl ? await fetchWebsite(normalizedUrl) : "";
      return {
        companyName,
        suggestedIndustry: detectIndustry(websiteText),
        summary: extractSummary(websiteText),
        webContent: websiteText.slice(0, 3000),
        allIndustries: INDUSTRIES,
      };
    },

    async runAssessment(companyId: string, input: AssessmentInput, companyWebContent?: string) {
      const apiKey = getApiKey();

      const ctx = retrieveContext(input);
      const serialized = serializeContext(ctx, input);
      const systemPrompt = buildSystemPrompt(serialized);
      const userPrompt = buildUserPrompt(input, companyWebContent);

      // Streaming call to MiniMax
      const upstreamRes = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          max_tokens: 16000,
          temperature: 1.0,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
          stream: true,
          thinking: { type: "enabled", budget_tokens: 10000 },
        }),
      });

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => "unknown");
        throw Object.assign(new Error(`MiniMax error ${upstreamRes.status}: ${text}`), { statusCode: 502 });
      }

      return {
        stream: upstreamRes.body!,
        onComplete: async (fullOutput: string) => {
          // Store assessment report
          await db.insert(companyContext).values({
            companyId,
            contextType: "agent_research",
            key: "readiness-assessment",
            value: fullOutput,
            confidence: "0.95",
          }).onConflictDoUpdate({
            target: [companyContext.companyId, companyContext.contextType, companyContext.key],
            set: { value: fullOutput, confidence: "0.95", updatedAt: new Date() },
          });

          // Store input
          await db.insert(companyContext).values({
            companyId,
            contextType: "agent_research",
            key: "assessment-input",
            value: JSON.stringify(input),
            confidence: "0.99",
          }).onConflictDoUpdate({
            target: [companyContext.companyId, companyContext.contextType, companyContext.key],
            set: { value: JSON.stringify(input), updatedAt: new Date() },
          });

          // Generate jumpstart via second MiniMax call
          try {
            const jumpstartPrompt = buildJumpstartPrompt(input, fullOutput);
            const jumpstartRes = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: MINIMAX_MODEL,
                max_tokens: 8000,
                temperature: 0.7,
                system: "You produce structured jumpstart documents for AgentDash.",
                messages: [{ role: "user", content: jumpstartPrompt }],
              }),
            });

            if (jumpstartRes.ok) {
              const jumpstartData = await jumpstartRes.json() as { content: Array<{ type: string; text?: string }> };
              const jumpstartMd = jumpstartData.content
                ?.filter((b) => b.type === "text")
                ?.map((b) => b.text)
                ?.join("") ?? "";

              if (jumpstartMd) {
                await db.insert(companyContext).values({
                  companyId,
                  contextType: "agent_research",
                  key: "jumpstart",
                  value: jumpstartMd,
                  confidence: "0.90",
                }).onConflictDoUpdate({
                  target: [companyContext.companyId, companyContext.contextType, companyContext.key],
                  set: { value: jumpstartMd, updatedAt: new Date() },
                });
              }
            }
          } catch (err) {
            logger.warn({ err }, "Failed to generate jumpstart — assessment still saved");
          }
        },
      };
    },

    async getAssessment(companyId: string) {
      const rows = await db.select().from(companyContext).where(
        and(eq(companyContext.companyId, companyId), eq(companyContext.contextType, "agent_research")),
      );
      const markdownRow = rows.find((r: any) => r.key === "readiness-assessment");
      const jumpstartRow = rows.find((r: any) => r.key === "jumpstart");
      const inputRow = rows.find((r: any) => r.key === "assessment-input");
      if (!markdownRow) return null;
      return {
        markdown: markdownRow.value,
        jumpstart: jumpstartRow?.value ?? null,
        assessmentInput: inputRow?.value ? JSON.parse(inputRow.value) : null,
      };
    },
  };
}
