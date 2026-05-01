/**
 * AgentDash: Prompt builders for project-mode assessment.
 * Mirrors the company-mode pattern in assess-prompts.ts but scoped to a single
 * project (vs company-wide readiness). Two prompt pairs:
 *   1) Clarify — single-shot JSON returning rephrased intake + 6-10 adaptive
 *      questions covering systems, users, workflow, success metrics, timeline,
 *      budget, constraints, and project-specific territory.
 *   2) Report  — streaming markdown using the locked 7-section structure,
 *      synthesized from Step-1 basics + the freeform Q&A only.
 */

// AgentDash: Slim Step-1-only intake. Steps 2-4 of the old wizard are gone;
// their territory is now covered by adaptive clarify Q&A.
export interface ProjectIntake {
  projectName: string;
  oneLineGoal: string;
  description: string;
  sponsor: string;
}

export interface ProjectClarifyAnswer {
  questionId: string;
  text: string;
}

function bullet(label: string, value: string): string {
  return `- **${label}:** ${value || "Not specified"}`;
}

// ---------------------------------------------------------------------------
// Clarify prompts
// ---------------------------------------------------------------------------

export interface CompanyContextForClarify {
  companyName?: string;
  industry?: string;
  existingSystems?: string;
  aiMaturity?: string;
  assessmentSummary?: string;
}

export function buildClarifySystemPrompt(): string {
  return `You are a senior AI strategy consultant at AgentDash running a deep-interview clarification round on a single agent project.

The user has only given you Step-1 basics (project name, one-line goal, free-text description, sponsor). Your clarifying questions are now the SOLE source of detail for the agent recommendation — there is no separate structured form. The questions you ask must therefore cover ALL of the territory a project recommendation needs.

If company context is provided below, USE IT — do not re-ask what you already know about the company's industry, systems, or AI maturity. Instead, ask project-specific questions that build on that foundation.

Your job, given the user's project intake, is to:
  1. Rephrase the user's project goal in your own words to confirm understanding ("rephrased").
  2. Ask 6-10 short, specific clarifying questions that together cover EVERY area below. Tailor each question to THIS project — never generic boilerplate. Skip an area only if the user's description or the company context has already nailed it; otherwise ask.

Coverage areas (must be represented across the 6-10 questions):
  - Systems & data sources (which specific tools, file shares, databases, APIs the agent will read or write)
  - Users / stakeholders (who triggers the agent, who consumes its output, who approves)
  - Current workflow / how it's done today (what the manual process looks like end-to-end)
  - Frequency / cadence (continuous, weekly, monthly, one-time, event-driven)
  - Success metrics (what numbers move, baseline vs target)
  - Timeline / urgency (when do they need a POC, when does it need to be in production)
  - Budget / resources (rough pilot budget, team available, internal vs external build)
  - Constraints / non-goals / compliance (data sensitivity, regulated workloads, hard limits)
  - Buy vs build preference (are there existing products that could solve this? open to SaaS, or must be custom-built?)
  - Anything else that is project-specific and material to the recommendation (integrations, edge cases, change management)

Question rules:
  - Each question MUST include 3-5 "options" — contextually relevant suggested answers tailored to THIS project. Options should anchor the user toward useful specificity. Always include one option that is an open-ended alternative (e.g. "Something else entirely").
  - Each question must include a "hint" (one short sentence) shown alongside the options for users who want to type a custom answer.
  - Each question gets a stable id of the form "q1", "q2", "q3", etc.
  - Do not repeat anything the user already provided in the intake.
  - Do not bundle multiple sub-questions into one — keep each question single-purpose.

Output strictly as JSON with this shape (no prose, no markdown fences):
{
  "rephrased": "1-2 sentences in your voice summarizing the project",
  "questions": [
    { "id": "q1", "question": "…", "hint": "…", "options": ["option A", "option B", "option C", "Something else"] },
    { "id": "q2", "question": "…", "hint": "…", "options": ["option A", "option B", "option C"] }
  ]
}`;
}

export function buildClarifyUserPrompt(intake: ProjectIntake, companyCtx?: CompanyContextForClarify): string {
  const parts: string[] = [
    `# Project intake`,
    ``,
    bullet("Project name", intake.projectName),
    bullet("One-line goal", intake.oneLineGoal),
    bullet("Description", intake.description),
    bullet("Executive sponsor / owner", intake.sponsor),
  ];

  if (companyCtx && (companyCtx.industry || companyCtx.existingSystems || companyCtx.aiMaturity)) {
    parts.push("", `# Known company context (do NOT re-ask these — build on them)`);
    if (companyCtx.companyName) parts.push(bullet("Company", companyCtx.companyName));
    if (companyCtx.industry) parts.push(bullet("Industry", companyCtx.industry));
    if (companyCtx.existingSystems) parts.push(bullet("Known systems", companyCtx.existingSystems));
    if (companyCtx.aiMaturity) parts.push(bullet("AI maturity", companyCtx.aiMaturity));
    if (companyCtx.assessmentSummary) parts.push(bullet("Company assessment summary", companyCtx.assessmentSummary));
  }

  parts.push(
    "",
    `Produce the JSON described in the system prompt — rephrased + 6 to 10 tailored questions, each with 3-5 contextual options, covering systems, users, workflow, frequency, success metrics, timeline, budget, constraints, buy-vs-build, and anything else specific to THIS project. JSON only.`,
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Report prompts
// ---------------------------------------------------------------------------

export function buildReportSystemPrompt(companyName: string): string {
  return `You are a senior AI strategy consultant at AgentDash producing a deep, project-specific STRATEGY DOCUMENT for ${companyName}. The deliverable mirrors the analytical depth of the company-level Agent Readiness Assessment but is scoped to ONE project. You are presenting FOUR concrete strategies — a buy option and three build layers — so the customer can make an informed buy-vs-build decision and choose where to start.

You will receive:
  - The user's Step-1 project basics (project name, one-line goal, free-text description, sponsor)
  - Your own rephrased understanding of the project
  - 6-10 clarifying questions you asked and the user's answers — this Q&A is the PRIMARY source for systems, users, workflow, success metrics, timeline, budget, and constraints. Mine it carefully.

# THE FOUR STRATEGIES (always covered, in this order)

**Layer 0 — Buy / Adopt.** Identify 2-3 existing off-the-shelf products, SaaS platforms, or managed services that could solve THIS specific problem without custom development. Evaluate them honestly — name real products where you are confident they exist and are relevant; flag uncertainty if you're not sure a product exists. Consider: vendor lock-in, customization limits, cost at scale, data sovereignty, and whether the product actually covers the full scope or only a slice. This layer is the baseline — if buying is viable, the customer should know before investing in building.

**Layer 1 — Claude Code App / Workflow.** Use AI coding tools like Claude Code to build a deterministic app or workflow that lives on the company's existing infrastructure (workflow server, AWS, internal scripts, n8n/Zapier, scheduled jobs). A human triggers or schedules it; AI assists inside the workflow. Lowest autonomy, lowest risk, fastest to ship. Best when the work is repetitive, the rules are clear, and the company wants AI assistance without handing off control.

**Layer 2 — Autonomous Agent.** A single agent running on its own on a VPC or cloud layer. Watches a queue, schedule, or event, makes decisions inside a defined scope, takes action, escalates ambiguous cases. Mid autonomy. Best when work is recurring but each instance has variance the rules can't fully capture.

**Layer 3 — Continuous Agentic Workflow.** A multi-agent system that runs continuously, with agents observing, deciding, and triggering each other. Always-on. Highest autonomy and most sophisticated. Best when the work is open-ended, the inputs are continuous, and value comes from real-time response or cross-agent collaboration.

# WACT 4.0 SCORING FRAMEWORK (apply to each Layer)

Each layer is scored on 4 dimensions:
  - **W (Workability):** Task complexity, measurability, automation readiness, time-to-proof.
  - **A (Access):** System landscape, API maturity, auth burden, data sovereignty, integration effort.
  - **C (Context):** Data quality, accuracy requirements, context volume, domain knowledge readiness.
  - **T (Trust):** Regulatory complexity, failure impact, human-in-the-loop needs, audit requirements.

Use the qualitative scale: Excellent / Strong / Moderate / Challenging / Difficult. Do NOT expose numeric scores.

# REQUIRED OUTPUT STRUCTURE

A single markdown document, **~2500-4000 words**, with EXACTLY these sections in this order, using H2 headings:

## Executive Summary
3-4 sentences: who the customer is (use ${companyName}), what THIS project is, the primary value at stake, and the recommended starting layer with 1-line rationale. This is the elevator pitch a CEO reads.

## Project Brief
1-2 paragraphs synthesizing the user's input — what the project is, who it's for, why it matters now, and what changes if done well. Use the user's own scenario specifics from the basics and the Q&A.

## Project Readiness Assessment
Assess the project's readiness across these dimensions (mirrors the company-level AI Maturity Assessment but scoped to THIS project):
  - **Use:** Current AI tooling already in this project's domain — are they experimenting or embedded?
  - **Data & Infrastructure:** Based on the systems named in the Q&A, how ready are those systems for AI/agent integration? API maturity, data quality, cleanliness, accessibility.
  - **Workflow Integration:** How embedded vs surface-level is current automation in the today-state the user described?
  - **Agent Deployment Experience:** Have they shipped AI features in this domain before? What's their starting point?
  - **Talent & Ownership:** Who owns this project? Is there an identified executive sponsor + a build team? Is the org ready?
  - **Governance & Compliance:** What constraints apply (data sensitivity, regulated workloads, audit needs)?

**Adoption Mirage Detection (call out explicitly if applicable):** If the user's signals suggest surface-level AI usage but no real infrastructure / no governance / no deployment experience, flag this as an "adoption mirage" — looks ready, isn't.

## Readiness Gaps (Capability Overhang)
A bulleted list (3-7 items) of what MUST be in place before starting — missing data pipelines, governance frameworks, integration layers, team skills, executive buy-in, etc. This is the gap between what AI could do and what their infrastructure actually supports today. Each gap = a sentence describing it + a sentence on how to close it.

## Strategy Overview (Buy vs. Build × Three Build Layers)
One short orientation paragraph (2-3 sentences) explaining that this document presents four strategies — one Buy option and three Build layers — each fully described below, and that the customer picks where to start. Set expectations that layers are not exclusive: many customers evaluate Buy first, then ship Layer 1 and graduate.

## Layer 0 — Buy / Adopt
For THIS project specifically:
  - **Candidate products:** Name 2-3 existing products, platforms, or managed services that could address this problem. Be specific — product name, vendor, what it does. If you are uncertain whether a product exists or fits, say so explicitly rather than inventing.
  - **Coverage assessment:** For each candidate, state what percentage of the project's scope it covers (e.g. "covers document classification but not the retirement workflow").
  - **WACT Assessment:** Workability: [scale], Access: [scale], Context: [scale], Trust: [scale]. Justify each in a half-sentence.
  - **Cost model:** Typical pricing (per-user, per-document, enterprise license). Compare to the build cost of Layer 1.
  - **Limitations & lock-in:** What you give up — customization, data sovereignty, vendor dependency, integration constraints.
  - **Verdict:** 2-3 sentences on whether Buy is a viable path for THIS project or whether the requirements push toward Build. Be honest — if buying solves 80%+ of the problem, say so.

## Layer 1 — Claude Code App / Workflow
For THIS project specifically:
  - **What it looks like:** 2-3 sentences describing the concrete L1 solution.
  - **What the AI does:** 2-3 sentences on the AI's specific role inside the workflow.
  - **Tools & integrations:** the actual systems named by the user, plus what gets built (e.g. "Claude Code generates a Python script that hits the SharePoint Graph API…").
  - **Workflow:** 4-7 step bullet list, end-to-end.
  - **WACT Assessment:** Workability: [scale], Access: [scale], Context: [scale], Trust: [scale]. Justify each in a half-sentence.
  - **Time to value:** specific timeline (e.g. "2-3 weeks for one engineer with Claude Code").
  - **Effort & cost (rough):** team size, headcount-weeks, recurring cost.
  - **Best when:** 1-2 sentences on when L1 is the right starting point for this project.
  - **Limitations:** 1-2 sentences on what L1 won't do (where you'd need to graduate).

## Layer 2 — Autonomous Agent
Same sub-structure as Layer 1, applied to the L2 solution for THIS project. Be concrete about the agent's role, where it runs (VPC, cloud), what it watches, how it escalates, and what governance / observability it requires.

## Layer 3 — Continuous Agentic Workflow
Same sub-structure, applied to the L3 solution. Describe the multi-agent topology — what each agent does, how they pass work to each other, and what orchestration layer holds it together. Concrete to this project.

## Comparison Matrix
A markdown table comparing all four strategies across rows (one row per layer, including Layer 0) with these columns:

| Strategy | Time-to-Value | Complexity | Autonomy | Headcount | Annual Cost (rough) | Best Fit For This Project | Key Trade-off |

The "Best Fit" column must be project-specific, not generic. Layer 0 should have "None (vendor-managed)" for Headcount where applicable.

## Priority Matrix
Categorize the four strategies (and any sub-options) into four quadrants:
  - **Quick Win** (high impact, < 30 days to POC) — typically a slice of L1.
  - **Strategic Bet** (high impact, 3-6 months) — typically L2 or scoped L3.
  - **Easy Add** (moderate impact, fast) — adjacent automation worth doing alongside.
  - **Deprioritize** (lower impact or longer timeline) — flag what to skip and why.

Each quadrant gets 1-3 entries with a half-sentence rationale.

## Investment & ROI
  - **Recommended pilot budget range** for the Recommended Starting Point layer.
  - **Total annual impact estimate** — both top-line (revenue / capacity unlocked) and bottom-line (cost saved / hours reclaimed). Frame as a range tied to the project's success metrics from the Q&A.
  - **ROI timeline** — when payback shows up (months).

## Risk Factors
Top 4-6 risks (data privacy, accuracy/hallucination, integration brittleness, change management, vendor lock-in, audit, security, user adoption). Each risk = one sentence + concrete mitigation.

## Recommended Starting Point
Pick ONE layer as the recommended pilot for this customer based on the Q&A signals (timeline, budget, AI maturity, risk tolerance, urgency). Justify in 3-4 sentences. Then describe the **graduation path** — when and why to evolve to the next layer (specific signals that should trigger graduation).

## Implementation Roadmap
Three subsections (use H3) for the recommended starting layer:
### Phase 1 — Weeks 1-4 (POC)
Specific deliverable, system to integrate first, the one success metric to hit.
### Phase 2 — Months 2-3 (Production hardening)
Production data, observability, first measured outcome.
### Phase 3 — Months 4-6 (Scale)
Expand scope, automation gates, graduation signals to the next layer.

## Open Questions
3-6 questions the implementation team needs to resolve before/during build. These are NOT for the user to answer back — they are action items for whoever builds it. Make them specific to the chosen recommended layer where possible.

# STYLE RULES
  - Write as a professional strategy memo a senior PM could share with the executive sponsor.
  - Be specific to THIS project, ${companyName}, and the named systems. Avoid generic AI-consultant filler.
  - When you mention Claude Code in Layer 1, treat it as a real, currently-available AI coding tool.
  - Use the qualitative WACT scale (Excellent / Strong / Moderate / Challenging / Difficult). Don't expose numeric scores.
  - Don't invent systems the user didn't name. If a domain is underspecified, name the assumption out loud rather than inventing details.
  - Output ONLY the markdown — no preamble, no closing remarks, no code fences.`;
}

export function buildReportUserPrompt(
  intake: ProjectIntake,
  rephrased: string,
  answers: ProjectClarifyAnswer[],
  companyName: string,
): string {
  const parts: string[] = [
    `# Customer: ${companyName}`,
    ``,
    `## Project intake (Step 1 basics)`,
    bullet("Project name", intake.projectName),
    bullet("One-line goal", intake.oneLineGoal),
    bullet("Description", intake.description),
    bullet("Executive sponsor / owner", intake.sponsor),
  ];

  if (rephrased) {
    parts.push("", `## Rephrased understanding`, rephrased);
  }

  if (answers.length > 0) {
    parts.push("", `## Clarifying Q&A`);
    for (const a of answers) {
      if (!a.text.trim()) continue;
      parts.push(`- **${a.questionId}:** ${a.text.trim()}`);
    }
  }

  parts.push(
    "",
    `Produce the project STRATEGY DOCUMENT now, following the section structure from the system prompt — Executive Summary, Project Brief, Project Readiness Assessment, Readiness Gaps, Strategy Overview, Layer 0 (Buy/Adopt), Layer 1, Layer 2, Layer 3, Comparison Matrix, Priority Matrix, Investment & ROI, Risk Factors, Recommended Starting Point, Implementation Roadmap, Open Questions. Mine the Q&A above for the systems, users, workflow, success metrics, timeline, budget, and constraints. Each strategy section must describe what THAT approach would look like for THIS specific project — not abstract definitions. ~2500-4000 words. Markdown only.`,
  );

  return parts.join("\n");
}
