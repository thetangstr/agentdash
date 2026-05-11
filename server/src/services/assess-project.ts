/**
 * AgentDash: Project-mode assessment service.
 * Mirrors assess.ts (company mode) but scoped to a single project, with:
 *   - Single-shot clarify call returning JSON (rephrased + 6-10 questions)
 *   - Streaming markdown report following the locked 7-section structure
 *   - Persistence to companyContext under keys
 *       project-assessment:<slug>
 *       project-assessment-input:<slug>
 *   - Listing of all past project assessments for a company
 *
 * Reuses the existing MiniMax wiring (ASSESS_MINIMAX_API_KEY, etc.) — no new
 * env vars or LLM providers.
 */
import { and, eq, inArray, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companyContext } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  buildClarifySystemPrompt,
  buildClarifyUserPrompt,
  buildReportSystemPrompt,
  buildReportUserPrompt,
  type ProjectIntake,
  type ProjectClarifyAnswer,
  type CompanyContextForClarify,
} from "./assess-project-prompts.js";

const MINIMAX_BASE_URL = process.env.ASSESS_MINIMAX_BASE_URL ?? "https://api.minimaxi.com/anthropic";
const MINIMAX_MODEL = process.env.ASSESS_MINIMAX_MODEL ?? "MiniMax-M2.7-highspeed";

const PROJECT_KEY_PREFIX = "project-assessment:";
const PROJECT_INPUT_KEY_PREFIX = "project-assessment-input:";

function getApiKey(): string {
  const key = process.env.ASSESS_MINIMAX_API_KEY?.trim();
  if (!key) throw Object.assign(new Error("ASSESS_MINIMAX_API_KEY is not configured"), { statusCode: 503 });
  return key;
}

export function toSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "project";
}

async function getCompanyName(db: Db, companyId: string): Promise<string> {
  const rows = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
  return rows[0]?.name ?? "the company";
}

export interface ProjectClarifyResult {
  rephrased: string;
  questions: { id: string; question: string; hint: string; options: string[] }[];
}

interface ClarifyApiResponse {
  content?: Array<{ type: string; text?: string }>;
}

function extractJsonFromText(text: string): string {
  // Strip markdown code fences if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Otherwise pull out the first balanced JSON object.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }
  return text.trim();
}

export function assessProjectService(db: Db) {
  return {
    /**
     * Single non-streaming MiniMax call. Returns rephrased + 6-10 questions
     * spanning systems, users, workflow, frequency, success metrics, timeline,
     * budget, and constraints (this Q&A is the SOLE source of those details
     * now — there's no separate structured form).
     */
    async generateClarifyQuestions(
      companyId: string,
      intake: ProjectIntake,
    ): Promise<ProjectClarifyResult> {
      const apiKey = getApiKey();

      // Look up existing company context to enrich the clarify prompt
      let companyCtx: CompanyContextForClarify | undefined;
      try {
        const ctxRows = await db
          .select()
          .from(companyContext)
          .where(and(eq(companyContext.companyId, companyId), eq(companyContext.contextType, "agent_research")));
        const inputRow = ctxRows.find((r: { key: string }) => r.key === "assessment-input");
        const reportRow = ctxRows.find((r: { key: string }) => r.key === "readiness-assessment");
        if (inputRow?.value) {
          const parsed = JSON.parse(inputRow.value) as Record<string, unknown>;
          const companyName = await getCompanyName(db, companyId);
          companyCtx = {
            companyName,
            industry: (parsed.industry as string) || undefined,
            existingSystems: Array.isArray(parsed.softwareSuites) ? (parsed.softwareSuites as string[]).join(", ") : undefined,
            aiMaturity: (parsed.automationLevel as string) || undefined,
            assessmentSummary: reportRow?.value ? reportRow.value.slice(0, 500) : undefined,
          };
        }
      } catch (err) {
        logger.warn({ err }, "Failed to load company context for project clarify; proceeding without it");
      }

      const systemPrompt = buildClarifySystemPrompt();
      const userPrompt = buildClarifyUserPrompt(intake, companyCtx);

      const res = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "Authorization": `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          max_tokens: 3000,
          temperature: 0.7,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "unknown");
        throw Object.assign(new Error(`MiniMax error ${res.status}: ${text}`), { statusCode: 502 });
      }

      const data = (await res.json()) as ClarifyApiResponse;
      const raw = data.content
        ?.filter((b) => b.type === "text")
        ?.map((b) => b.text ?? "")
        ?.join("") ?? "";

      let parsed: ProjectClarifyResult;
      try {
        parsed = JSON.parse(extractJsonFromText(raw));
      } catch (err) {
        logger.warn({ err, raw }, "Failed to parse clarify JSON; returning fallback");
        parsed = {
          rephrased: intake.oneLineGoal || intake.description.slice(0, 160),
          questions: [
            { id: "q1", question: "Which 2-3 specific systems will the agent read from or write to?", hint: "Mention specific tools, file shares, or systems by name.", options: ["SharePoint / OneDrive", "Salesforce", "Internal database / data warehouse", "Google Workspace", "Something else"] },
            { id: "q2", question: "Who are the primary users — who triggers the agent and who consumes its output?", hint: "Name the roles, not generic 'the team'.", options: ["Individual contributors", "Team leads / managers", "Executive leadership", "External customers"] },
            { id: "q3", question: "How is this work done today, end to end?", hint: "Walk through the manual workflow as it happens now.", options: ["Fully manual process", "Partially automated with scripts", "Using existing software but manual steps remain", "Not done at all yet"] },
            { id: "q4", question: "How often does this need to run?", hint: "Continuous, weekly, monthly, on-demand, event-driven?", options: ["Continuous / real-time", "Daily", "Weekly", "Monthly / quarterly", "On-demand when triggered"] },
            { id: "q5", question: "What does success look like, with a baseline and a target number?", hint: "Give a baseline number and a target number if you can.", options: ["Save X hours per week", "Reduce error rate by X%", "Process X more items per day", "Reduce cost by $X"] },
            { id: "q6", question: "What's the timeline — when do you need a POC vs. production?", hint: "Concrete weeks or months, not 'soon'.", options: ["POC in 2-4 weeks", "POC in 1-2 months", "Production in 3-6 months", "No hard deadline", "Urgent — needed ASAP"] },
            { id: "q7", question: "Roughly what pilot budget and which team would build this?", hint: "Internal headcount, external partner, or both — and a rough $ band.", options: ["< $10K", "$10K–$50K", "$50K–$200K", "$200K+", "Not sure yet"] },
            { id: "q8", question: "Would you prefer to buy an existing product or build a custom solution?", hint: "Consider whether off-the-shelf covers enough of the problem.", options: ["Prefer to buy if something fits", "Prefer to build for full control", "Open to either", "Already evaluated, none fit"] },
          ],
        };
      }

      // Defensive: clamp to 6-10 questions, ensure ids and options
      const questions = (parsed.questions ?? []).slice(0, 10).map((q, i) => ({
        id: q.id?.trim() || `q${i + 1}`,
        question: (q.question ?? "").trim(),
        hint: (q.hint ?? "").trim(),
        options: Array.isArray(q.options) ? q.options.map((o: unknown) => String(o).trim()).filter((o: string) => o.length > 0) : [],
      })).filter((q) => q.question.length > 0);

      // Pad with conservative fallbacks if the LLM under-delivered (need at least 6).
      if (questions.length < 6) {
        const fillers: { id: string; question: string; hint: string; options: string[] }[] = [
          { id: "f1", question: "Which 2-3 specific systems will the agent read from or write to?", hint: "Mention specific tools, file shares, or systems by name.", options: ["SharePoint / OneDrive", "Salesforce", "Internal database / data warehouse", "Google Workspace", "Something else"] },
          { id: "f2", question: "Who are the primary users — who triggers the agent and who consumes its output?", hint: "Name the roles, not generic 'the team'.", options: ["Individual contributors", "Team leads / managers", "Executive leadership", "External customers", "Automated trigger (no human)"] },
          { id: "f3", question: "How is this work done today, end to end?", hint: "Walk through the manual workflow as it happens now.", options: ["Fully manual process", "Partially automated with scripts", "Using existing software but manual steps remain", "Not done at all yet"] },
          { id: "f4", question: "How often does this need to run?", hint: "Continuous, weekly, monthly, on-demand, event-driven?", options: ["Continuous / real-time", "Daily", "Weekly", "Monthly / quarterly", "On-demand when triggered"] },
          { id: "f5", question: "What does success look like, with a baseline and a target number?", hint: "Give a baseline number and a target number if you can.", options: ["Save X hours per week", "Reduce error rate by X%", "Process X more items per day", "Reduce cost by $X", "Other measurable outcome"] },
          { id: "f6", question: "What's the timeline — when do you need a POC vs. production?", hint: "Concrete weeks or months, not 'soon'.", options: ["POC in 2-4 weeks", "POC in 1-2 months", "Production in 3-6 months", "No hard deadline — exploring", "Urgent — needed ASAP"] },
          { id: "f7", question: "Roughly what pilot budget and which team would build this?", hint: "Internal headcount, external partner, or both — and a rough $ band.", options: ["< $10K — internal team only", "$10K–$50K — small team + partner", "$50K–$200K — dedicated project", "$200K+ — strategic investment", "Not sure yet"] },
          { id: "f8", question: "Would you prefer to buy an existing product or build a custom solution?", hint: "Consider whether off-the-shelf covers enough of the problem.", options: ["Prefer to buy if something fits", "Prefer to build for full control", "Open to either — depends on fit", "Already evaluated products, none fit", "Hybrid — buy a platform, customize on top"] },
        ];
        let fillerIdx = 0;
        while (questions.length < 6 && fillerIdx < fillers.length) {
          const f = fillers[fillerIdx++];
          if (!questions.find((q) => q.id === f.id)) questions.push({ ...f, id: `q${questions.length + 1}` });
        }
      }

      return {
        rephrased: parsed.rephrased ?? "",
        questions,
      };
    },

    /**
     * Streaming MiniMax call. Returns the upstream stream + an onComplete that
     * writes the final markdown + intake to companyContext.
     */
    async runProjectAssessment(
      companyId: string,
      input: {
        intake: ProjectIntake;
        answers: ProjectClarifyAnswer[];
        rephrased: string;
      },
    ): Promise<{
      stream: ReadableStream<Uint8Array>;
      onComplete: (fullOutput: string) => Promise<void>;
      slug: string;
    }> {
      const apiKey = getApiKey();
      const companyName = await getCompanyName(db, companyId);
      const slug = toSlug(input.intake.projectName);

      const systemPrompt = buildReportSystemPrompt(companyName);
      const userPrompt = buildReportUserPrompt(input.intake, input.rephrased, input.answers, companyName);

      const upstreamRes = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "Authorization": `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          max_tokens: 12000,
          temperature: 0.8,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
          stream: true,
          thinking: { type: "enabled", budget_tokens: 6000 },
        }),
      });

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => "unknown");
        throw Object.assign(new Error(`MiniMax error ${upstreamRes.status}: ${text}`), { statusCode: 502 });
      }

      return {
        stream: upstreamRes.body!,
        slug,
        onComplete: async (fullOutput: string) => {
          if (!fullOutput.trim()) {
            logger.warn({ companyId, slug }, "Project assessment produced empty output; skipping persistence");
            return;
          }

          // Store markdown report
          await db.insert(companyContext).values({
            companyId,
            contextType: "agent_research",
            key: PROJECT_KEY_PREFIX + slug,
            value: fullOutput,
            confidence: "0.95",
          }).onConflictDoUpdate({
            target: [companyContext.companyId, companyContext.contextType, companyContext.key],
            set: { value: fullOutput, confidence: "0.95", updatedAt: new Date() },
          });

          // AgentDash: Slimmed input shape — just intake + Q&A + rephrased.
          // No legacy structured fields; the Q&A carries that information now.
          const inputJson = JSON.stringify({
            intake: input.intake,
            answers: input.answers,
            rephrased: input.rephrased,
            projectName: input.intake.projectName,
          });
          await db.insert(companyContext).values({
            companyId,
            contextType: "agent_research",
            key: PROJECT_INPUT_KEY_PREFIX + slug,
            value: inputJson,
            confidence: "0.99",
          }).onConflictDoUpdate({
            target: [companyContext.companyId, companyContext.contextType, companyContext.key],
            set: { value: inputJson, updatedAt: new Date() },
          });
        },
      };
    },

    /**
     * Get a single stored project assessment.
     */
    async getProjectAssessment(companyId: string, slug: string): Promise<{ markdown: string; input: unknown } | null> {
      const rows = await db
        .select()
        .from(companyContext)
        .where(
          and(eq(companyContext.companyId, companyId), eq(companyContext.contextType, "agent_research")),
        );

      const markdownRow = rows.find((r: { key: string }) => r.key === PROJECT_KEY_PREFIX + slug);
      if (!markdownRow) return null;
      const inputRow = rows.find((r: { key: string }) => r.key === PROJECT_INPUT_KEY_PREFIX + slug);

      let parsedInput: unknown = null;
      if (inputRow?.value) {
        try { parsedInput = JSON.parse(inputRow.value); } catch { parsedInput = null; }
      }

      return {
        markdown: markdownRow.value,
        input: parsedInput,
      };
    },

    /**
     * List all project-assessment slugs for a company along with project name and createdAt.
     */
    async listProjectAssessments(companyId: string): Promise<{ slug: string; projectName: string; createdAt: string }[]> {
      const rows = await db
        .select()
        .from(companyContext)
        .where(
          and(
            eq(companyContext.companyId, companyId),
            eq(companyContext.contextType, "agent_research"),
            like(companyContext.key, `${PROJECT_KEY_PREFIX}%`),
          ),
        );

      // AgentDash: batch-fetch all input rows in one query (fixes N+1 — was 1 query per assessment)
      const slugs = rows.map((r) => r.key.slice(PROJECT_KEY_PREFIX.length)).filter(Boolean);
      const inputKeys = slugs.map((s) => PROJECT_INPUT_KEY_PREFIX + s);
      const inputRows = inputKeys.length > 0
        ? await db
            .select()
            .from(companyContext)
            .where(
              and(
                eq(companyContext.companyId, companyId),
                eq(companyContext.contextType, "agent_research"),
                inArray(companyContext.key, inputKeys),
              ),
            )
        : [];

      const inputByKey = new Map<string, string>();
      for (const ir of inputRows) {
        if (ir.value) inputByKey.set(ir.key, ir.value);
      }

      const out: { slug: string; projectName: string; createdAt: string }[] = [];
      for (const row of rows) {
        const slug = row.key.slice(PROJECT_KEY_PREFIX.length);
        if (!slug) continue;
        let projectName = slug;
        const rawInput = inputByKey.get(PROJECT_INPUT_KEY_PREFIX + slug);
        if (rawInput) {
          try {
            const parsed = JSON.parse(rawInput) as { projectName?: string; intake?: { projectName?: string } };
            projectName = parsed.projectName ?? parsed.intake?.projectName ?? slug;
          } catch {
            // ignore
          }
        }
        const ts = row.updatedAt ?? row.createdAt ?? new Date();
        const createdAt = ts instanceof Date ? ts.toISOString() : new Date(ts as string).toISOString();
        out.push({ slug, projectName, createdAt });
      }
      // Newest first
      out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return out;
    },

    /**
     * Two-phase adaptive follow-up: receives the initial Q&A and generates
     * 2-4 targeted follow-up questions for the weakest coverage areas.
     */
    async generateFollowUp(
      intake: ProjectIntake,
      initialQA: ProjectClarifyAnswer[],
      rephrased: string,
    ): Promise<ProjectClarifyResult> {
      const apiKey = getApiKey();

      const qaBlock = initialQA
        .filter((a) => a.text.trim())
        .map((a) => `- **${a.questionId}:** ${a.text.trim()}`)
        .join("\n");

      const systemPrompt = `You are a senior AI strategy consultant at AgentDash doing a FOLLOW-UP clarification round. You already asked an initial set of questions and received answers. Now analyze the gaps — which coverage areas are weakest? — and ask 2-4 targeted follow-up questions to fill them.

Coverage areas to check for gaps:
  - Systems & data sources, Users / stakeholders, Current workflow, Frequency / cadence
  - Success metrics, Timeline / urgency, Budget / resources
  - Constraints / non-goals / compliance, Buy vs build preference

Rules:
  - Only ask about areas where the initial answers were vague, missing, or insufficient.
  - Each follow-up must include 3-5 contextual "options" tailored to THIS project.
  - Each follow-up must include a "hint" for free-text answers.
  - If coverage is already strong across all areas, return an empty questions array.

Output strictly as JSON:
{
  "rephrased": "1 sentence summarizing what you still need to clarify",
  "questions": [
    { "id": "f1", "question": "…", "hint": "…", "options": ["A", "B", "C"] }
  ]
}`;

      const userPrompt = `# Project: ${intake.projectName}
${intake.description}

# Rephrased understanding
${rephrased}

# Initial Q&A (already answered)
${qaBlock}

Analyze the gaps in the answers above and generate 2-4 targeted follow-up questions. If all areas are well-covered, return empty questions array. JSON only.`;

      const res = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "Authorization": `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          max_tokens: 2000,
          temperature: 0.5,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "unknown");
        throw Object.assign(new Error(`MiniMax error ${res.status}: ${text}`), { statusCode: 502 });
      }

      const data = (await res.json()) as ClarifyApiResponse;
      const raw = data.content
        ?.filter((b) => b.type === "text")
        ?.map((b) => b.text ?? "")
        ?.join("") ?? "";

      let parsed: ProjectClarifyResult;
      try {
        parsed = JSON.parse(extractJsonFromText(raw));
      } catch (err) {
        // Closes #162: fail loud instead of silently returning empty questions.
        // Unlike the clarify path (~line 144) we have no usable fallback set
        // for follow-ups — they're contextual to the user's prior answers, so
        // a static template would be misleading. Bubble a 502 so the UI can
        // tell the user generation failed and offer a retry.
        logger.error({ err, raw }, "Failed to parse follow-up JSON");
        throw Object.assign(
          new Error("Could not generate follow-up questions; the model returned an unparseable response."),
          { statusCode: 502 },
        );
      }

      return {
        rephrased: parsed.rephrased ?? "",
        questions: (parsed.questions ?? []).slice(0, 4).map((q, i) => ({
          id: q.id?.trim() || `f${i + 1}`,
          question: (q.question ?? "").trim(),
          hint: (q.hint ?? "").trim(),
          options: Array.isArray(q.options) ? q.options.map((o: unknown) => String(o).trim()).filter((o: string) => o.length > 0) : [],
        })).filter((q) => q.question.length > 0),
      };
    },
  };
}
