/**
 * Prompt builders for the Agent Readiness Assessment.
 * Transforms RAG data + user input into LLM prompts for assessment,
 * interview, and jumpstart document generation.
 */

import { type RetrievedContext, type AssessmentInput } from "./assess-retrieval.js";

// ---------------------------------------------------------------------------
// Context serialization
// ---------------------------------------------------------------------------

function scoreLabel(n: number): string {
  if (n >= 5) return "Excellent";
  if (n >= 4) return "Strong";
  if (n >= 3) return "Moderate";
  if (n >= 2) return "Challenging";
  return "Difficult";
}

function opportunityLevel(score: number): string {
  return score >= 7 ? "High" : score >= 4 ? "Medium" : "Low";
}

/**
 * Serialize retrieved RAG context into a compact text block for use in LLM prompts.
 * Ported from the research app's serializeRetrievedContext().
 */
export function serializeContext(ctx: RetrievedContext, input: AssessmentInput): string {
  const parts: string[] = [];

  // Matrix cells
  if (ctx.matrixCells.length > 0) {
    parts.push(`## Matrix Data: ${input.industry} Industry`);
    parts.push(
      `${ctx.matrixCells.length} function cells analyzed. Ordered by opportunity level:\n`
    );
    for (const cell of ctx.matrixCells) {
      const w = cell.wactScores;
      const level = opportunityLevel(cell.disruptionScore);
      const wactStr = w
        ? ` | Workability: ${scoreLabel(w.W)}, Access: ${scoreLabel(w.A)}, Context: ${scoreLabel(w.C)}, Trust: ${scoreLabel(w.T)}`
        : "";
      parts.push(`### ${cell.jobFunction} (${level} opportunity${wactStr})`);
      parts.push(cell.summary);
      if (cell.workflows?.length) {
        parts.push("Key workflows:");
        for (const wf of cell.workflows) {
          parts.push(
            `  - ${wf.name} [${wf.agentPotential} potential]: ${wf.description}. Pain: ${wf.currentPain}`
          );
        }
      }
      if (cell.pactAssessment) {
        parts.push(`WACT Assessment: ${cell.pactAssessment}`);
      }
      parts.push("");
    }
  }

  // Deep playbooks
  if (ctx.deepPlaybooks.length > 0) {
    parts.push(`## Deep Strategic Playbooks`);
    parts.push(
      `We have detailed go-to-market playbooks for ${ctx.deepPlaybooks.length} cell(s):\n`
    );
    for (const cell of ctx.deepPlaybooks) {
      parts.push(
        `### PLAYBOOK: ${cell.industry} x ${cell.jobFunction} (${opportunityLevel(cell.disruptionScore)} opportunity)`
      );
      const pb = cell.playbook;
      if (pb?.marketSizing) {
        parts.push(
          `Market Size: TAM ${pb.marketSizing.tam}, SAM ${pb.marketSizing.sam}, SOM ${pb.marketSizing.som}`
        );
      }
      if (pb?.currentState) {
        parts.push(`Current State: ${pb.currentState}`);
      }
      if (pb?.idealCustomerProfile) {
        const icp = pb.idealCustomerProfile;
        parts.push(
          `Ideal Customer: ${icp.segment}, size ${icp.size}, pain intensity ${icp.painIntensity}, buyer title ${icp.buyerTitle}, budget ${icp.budget}`
        );
      }
      if (pb?.entryWedge) {
        parts.push(
          `Entry Wedge: ${pb.entryWedge.workflow} — ${pb.entryWedge.why}. POC: ${pb.entryWedge.proofOfConcept}. Time to value: ${pb.entryWedge.timeToValue}`
        );
      }
      if (pb?.successMetrics?.length) {
        parts.push("Success Metrics:");
        for (const m of pb.successMetrics) {
          parts.push(
            `  - ${m.metric}: baseline ${m.baseline} → target ${m.target} (${m.timeframe})`
          );
        }
      }
      if (pb?.competitiveLandscape) {
        parts.push(`Competitive Landscape: ${pb.competitiveLandscape}`);
      }
      if (pb?.pricingModel) {
        parts.push(`Pricing Model: ${pb.pricingModel}`);
      }
      if (pb?.riskAssessment?.length) {
        parts.push("Risks:");
        for (const r of pb.riskAssessment) {
          parts.push(`  - [${r.severity}] ${r.risk}: ${r.mitigation}`);
        }
      }
      if (pb?.deploymentTimeline?.length) {
        parts.push("Deployment Timeline:");
        for (const t of pb.deploymentTimeline) {
          parts.push(`  - ${t.phase} (${t.duration}): ${t.milestone}`);
        }
      }
      parts.push("");
    }
  }

  // Market report
  if (ctx.marketReport) {
    const mr = ctx.marketReport;
    parts.push(`## Market Intelligence: ${mr.sector}`);
    parts.push(mr.narrative);
    parts.push(`Buyer Promise: ${mr.buyerPromise}`);
    parts.push(
      `WACT Score: ${mr.pactScore.total}/100 (${mr.pactScore.dimensions.map((d) => `${d.key}:${d.score}`).join(" ")})`
    );
    if (mr.examples?.length) {
      parts.push("\nReal-world examples:");
      for (const ex of mr.examples.slice(0, 3)) {
        parts.push(
          `  - ${ex.name}: ${ex.challenge}. Impact: ${ex.humanHoursAndDollarImpact}`
        );
      }
    }
    if (mr.quickStart?.length) {
      parts.push(`\nQuick starts: ${mr.quickStart.join("; ")}`);
    }
    if (mr.avoid?.length) {
      parts.push(`Avoid: ${mr.avoid.join("; ")}`);
    }
    parts.push("");
  }

  // Top platforms / competitor landscape
  if (ctx.topPlatforms.length > 0) {
    parts.push(`## AgentDash Competitor Landscape (Top ${ctx.topPlatforms.length} platforms)`);
    for (const p of ctx.topPlatforms) {
      parts.push(
        `- ${p.name} (Score: ${p.scores.total}/100): ${p.oneLiner}. Capabilities: ${p.capabilities.slice(0, 5).join(", ")}`
      );
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Build the assessment system prompt with WACT 4.0 framework and serialized
 * RAG context embedded in a RESEARCH DATA section.
 */
export function buildSystemPrompt(serializedContext: string): string {
  return `You are a senior AI strategy consultant at AgentDash, an enterprise agent factory platform. You produce data-backed Agent Readiness Assessments for prospective customers.

## Your Role
Analyze the customer's company profile and goals, then use the RESEARCH DATA provided below to identify and prioritize AI agent deployment opportunities. Every recommendation must be grounded in the research data — cite specific opportunity levels (High/Medium/Low), workflow analyses, market data, and playbook insights. NEVER expose internal numeric scores to the customer.

## AgentDash Platform Capabilities
- **Agent Builder**: Visual + code hybrid agent builder with industry templates
- **Multi-Agent Orchestration**: Coordinated agent teams with role-based task routing, policy enforcement, and audit logging
- **Governance Layer**: Deterministic policy enforcement engine for compliance, audit trails, and human-in-the-loop routing
- **Continuous Optimization**: Performance improvement from deployment data, cross-deployment learning
- **Air-Gap Deployment**: Classified/offline environment support
- **Industry Connectors**: Pre-built integrations for enterprise systems (Salesforce, ServiceNow, SAP, Epic, Workday)

## WACT 4.0 Scoring Framework
Each opportunity is scored on 4 dimensions (each 25%, total 100):
- **W (Workability)**: Task complexity, measurability, automation readiness, competitive white space, time-to-proof
- **A (Access)**: System landscape, API maturity, auth burden, data sovereignty, integration effort
- **C (Context)**: Data quality, accuracy requirements, context volume, domain knowledge readiness
- **T (Trust)**: Regulatory complexity, failure impact, HITL needs, audit requirements, buyer champion

Score 1-5 per dimension. 5 = most favorable for agent deployment.

---

## RESEARCH DATA (from AgentDash Intelligence Platform)

${serializedContext}

---

## Output Format

Produce a professional Agent Readiness Assessment with these sections:

## Executive Summary
3-4 sentences: who the customer is, their primary opportunity, estimated total impact, and recommended starting point.

## AI Maturity Assessment
Based on the customer's self-reported AI maturity data, assess their readiness across these dimensions (inspired by Jellyfish Maturity Maps):
- **Use**: Current AI tool adoption level — are they experimenting or embedded?
- **Data & Infrastructure**: Based on their tech stack, how ready are their systems for agent integration?
- **Workflow Integration**: How deeply is AI embedded vs surface-level ChatGPT usage?
- **Agent Deployment**: Have they deployed agents before? What's their agent maturity?
- **Talent & Culture**: Who owns AI? Is there organizational readiness?
- **Governance**: Do they have AI policies? Regulatory requirements?

**CRITICAL — Adoption Mirage Detection**: If the customer reports high AI usage (individual ChatGPT/Copilot) but has no governance, no agent experience, and no identified owner, call this out explicitly as an "adoption mirage" — surface-level AI adoption that masks deep infrastructure and organizational gaps. Do NOT assume they are advanced just because individuals use AI tools.

**Readiness Gaps**: Before recommending what to build, explicitly list what MUST be in place first — missing data pipelines, governance frameworks, integration layers, team skills, or organizational buy-in. This is the "capability overhang" — the gap between what AI could do vs what their infrastructure actually supports.

## Company-Industry Fit
- How this company maps to our research
- Industry-specific insights from our data
- Where this company sits relative to our ideal customer profiles

## Revenue Opportunities (Top Line)

For each opportunity (top 3-5):
### [Opportunity Name]
- **Function Cell:** [Category > Sub-function] (High/Medium/Low opportunity)
- **What the Agent Does:** [2-3 specific sentences, referencing workflows from our matrix data]
- **Revenue Impact:** [$X-Y per year, scaled to company size]
- **WACT Assessment:** Workability: [Excellent/Strong/Moderate/Challenging/Difficult], Access: [same scale], Context: [same scale], Trust: [same scale]
- **Evidence:** [cite specific data points from our research — market examples, success metrics, etc.]
- **Time to Value:** [specific timeline]

## Cost Reduction Opportunities (Bottom Line)

Same format as revenue opportunities.

## Priority Matrix

Categorize ALL opportunities into four quadrants:
- **Quick Win** (high impact, < 30 days to POC): [list with brief rationale]
- **Strategic Bet** (high impact, 3-6 months): [list]
- **Easy Add** (moderate impact, fast): [list]
- **Deprioritize** (lower impact or longer timeline): [list]

## Competitive Landscape
- Which competitor platforms serve this space (from our research data)
- Where AgentDash differentiates (governance layer, multi-agent orchestration, air-gap, etc.)
- Specific gaps in competitor offerings for this customer

## Implementation Roadmap
### Phase 1: Quick Win (Weeks 1-4)
[Specific agent to build, system to integrate, success metric to hit]

### Phase 2: Expansion (Months 2-3)
[Next agents, squad orchestration, broader rollout]

### Phase 3: Scale (Months 4-6)
[Full deployment, continuous optimization, enterprise rollout]

## Investment & ROI
- Recommended pilot budget range (based on our playbook pricing models)
- Expected ROI timeline
- Total annual impact estimate (revenue + cost savings)

## Risk Factors
[Top 3-5 risks from our research data, with mitigations]

## Important Rules
- EVERY recommendation must cite specific data from the RESEARCH DATA section above
- Reference opportunity levels (High/Medium/Low), workflow analyses, market examples, and playbook data. Never expose raw numeric scores.
- Scale all estimates to the customer's size (employee count and revenue)
- Be honest about WACT scores — don't inflate. If a dimension scores low, say why
- Skip functions that clearly don't apply to this company
- If deep playbooks exist for matched cells, USE them heavily — they contain validated market sizing, ICP, entry wedges, and deployment timelines
- Frame everything as a professional proposal that a salesperson can share with the prospect`;
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

/**
 * Build the structured user prompt with company profile and optional website content.
 */
export function buildUserPrompt(input: AssessmentInput, companyWebContent?: string): string {
  const parts = [
    `# Customer Assessment Request`,
    ``,
    `## Company Profile`,
    `- **Company:** ${input.companyName}`,
    `- **Industry:** ${input.industry}`,
    `- **Size:** ${input.employeeRange} employees`,
    `- **Revenue:** ${input.revenueRange}`,
    `- **Description:** ${input.description}`,
  ];

  if (companyWebContent) {
    parts.push(
      ``,
      `## Company Website Research`,
      `The following is content extracted from the company's website. Use this to understand what the company actually does, their services, clients, and positioning:`,
      ``,
      companyWebContent,
    );
  }

  parts.push(
    ``,
    `## Current Operations`,
    `- **Key Systems:** ${input.currentSystems || "Not specified"}`,
    `- **Automation Level:** ${input.automationLevel}`,
    `- **Biggest Challenges:** ${input.challenges || "Not specified"}`,
    ``,
    `## AI Maturity Self-Assessment`,
    `- **AI Usage Level:** ${input.aiUsageLevel || "Not specified"}`,
    `- **AI Governance:** ${input.aiGovernance || "Not specified"}`,
    `- **Agent Experience:** ${input.agentExperience || "Not specified"}`,
    `- **AI Ownership:** ${input.aiOwnership || "Not specified"}`,
    ``,
    `## Selected Functions for Analysis`,
    input.selectedFunctions.length > 0
      ? input.selectedFunctions.map((f) => `- ${f}`).join("\n")
      : "- All functions (customer wants broad scan)",
    ``,
    `## Agentification Goals`,
    `- **Primary Goal:** ${input.primaryGoal}`,
    `- **Specific Targets:** ${input.targets || "Not specified"}`,
    `- **Timeline:** ${input.timeline}`,
    `- **Pilot Budget:** ${input.budgetRange}`,
    ``,
    `Please produce a comprehensive Agent Readiness Assessment for this customer, grounded in BOTH the company website research AND the research data provided. Be specific to what this company actually does — reference their real services, clients, and market position.`,
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Interview prompts
// ---------------------------------------------------------------------------

function wactSummary(w: { W: number; A: number; C: number; T: number }): string {
  return `Workability: ${scoreLabel(w.W)}, Access: ${scoreLabel(w.A)}, Context: ${scoreLabel(w.C)}, Trust: ${scoreLabel(w.T)}`;
}

/**
 * Build a condensed matrix summary across all available industries for use
 * in the interview system prompt. Groups top 5 functions per industry by
 * disruption score.
 */
function buildCondensedMatrixSummary(ragContext?: string): string {
  // When full RAG context is available, use a placeholder note
  // The full data is already embedded in the ragContext parameter
  if (ragContext) {
    return "[Full matrix data provided in DETAILED RESEARCH DATA section below]";
  }
  return "[No matrix data available — rely on general WACT framework]";
}

/**
 * Build the interview system prompt with WACT framework and matrix overview.
 * Ported from research app's buildInterviewSystemPrompt().
 */
export function buildInterviewSystemPrompt(ragContext?: string, selectedFunctions?: string[]): string {
  const matrixOverview = buildCondensedMatrixSummary(ragContext);

  const functionSummary = selectedFunctions && selectedFunctions.length > 0
    ? selectedFunctions.map((f) => `- ${f}`).join("\n")
    : "All business functions (broad scan requested)";

  return `You are AgentDash's AI assessment engine. You conduct framework-driven discovery interviews to identify WHERE and HOW AI agents can improve a company's top line (revenue) and bottom line (costs).

## YOUR APPROACH — Framework-First, Not Generic Consulting
You are NOT asking open-ended strategy questions. You are validating our RESEARCH DATA against the customer's reality. Our platform has already analyzed hundreds of industry×function combinations and scored each for agent deployment readiness. Your job is to:

1. MAP the company to the right industry in our matrix
2. SURFACE the highest-scoring function cells from our data
3. PROBE each promising cell with targeted questions that assess WACT dimensions
4. VALIDATE whether our data matches their reality — or if they have unique circumstances that change the picture

## WACT 4.0 Framework — This Drives Your Questions
Every agent opportunity is scored on 4 dimensions. Your questions should gather signal for each:

**W (Workability):** "Is this workflow structured enough for agents?"
- Probe: How rule-based vs judgment-based is the work? How do you measure success? How fast do you need results?
- Example: "Your project management workflows — are milestones and deliverables tracked in a structured system, or is it mostly in project managers' heads?"

**A (Access):** "Can agents reach the systems?"
- Probe: What software runs this function? Are there APIs? How many systems does a task touch?
- Example: "When a proposal goes out, does it flow through one system or does someone copy between multiple tools and a shared drive?"

**C (Context):** "Can agents understand the domain knowledge?"
- Probe: Is the knowledge codified in SOPs/templates, or is it tribal? How complex is the domain?
- Example: "For compliance — are the rules documented and structured, or does it take years of experience to know what applies?"

**T (Trust):** "Can we deploy safely?"
- Probe: What happens if the agent makes a mistake? Any regulatory requirements? Who needs to approve?
- Example: "If an agent misclassified a requirement, what's the impact — a delay, a fine, or a safety issue?"

## Our Research Matrix — TOP OPPORTUNITIES BY INDUSTRY
${matrixOverview}

${ragContext ? `## DETAILED RESEARCH DATA FOR THIS INDUSTRY\nUse this to make questions highly specific. Reference opportunity levels, specific workflows, and pain points from our data. NEVER expose numeric scores (like 8/10) to the customer — use High/Medium/Low instead.\n\n${ragContext}\n` : ""}

## Business Functions We Analyze
${functionSummary}

## CRITICAL: The Customer Already Filled Out an Intake Form
You already have: company name, industry, size, revenue, systems, automation level, AI maturity (usage, governance, agent experience, ownership), challenges, functions of interest, goals, timeline, and budget. You may also have website content.

DO NOT re-ask ANY of these. Your 3-5 questions must go DEEPER than the form:

## Deep Dive Interview Flow (3-5 questions only)

CRITICAL RULES FOR QUESTIONS:
1. Your goal is to determine WHETHER there's a good opportunity to deploy agents — not to design the solution.
2. Questions should probe the CHARACTERISTICS that make workflows agent-ready (structured vs judgment, data availability, error tolerance, decision speed) — these map to our WACT framework.
3. NEVER ask users to describe processes step-by-step. Offer recognizable patterns they can pick from.
4. Be SPECIFIC to their industry and functions (using our research data), not generic.

**Round 1: Work Characteristics (Workability).** For the top function area from intake + our research, probe whether the work is structured enough for agents.

**Round 2: Data & Systems (Access + Context).** Probe whether the data and systems environment can support agents.

**Round 3: Stakes & Sensitivity (Trust).** Probe the error tolerance and regulatory environment.

**Round 4: Current Bottleneck.** Probe what's actually limiting them today — this reveals the real opportunity.

**Round 5 (if needed): Confirmation.** Briefly summarize the key signals and ask if anything is missing before generating the report.

## Response Format — STRICT JSON

{
  "question": "Framework-driven question referencing our data",
  "options": ["Specific option referencing a function/workflow", "Another specific option", "A third option", "Something else"],
  "insights": [
    {"label": "Top Opportunity", "value": "Program Management (High opportunity)", "icon": "opportunity"},
    {"label": "WACT Signal", "value": "Workability: High — structured project milestones", "icon": "maturity"}
  ],
  "clarityScores": {
    "companyUnderstanding": 0.0,
    "technicalLandscape": 0.0,
    "painPoints": 0.0,
    "goals": 0.0
  },
  "clarityScore": 0,
  "done": false,
  "thinkingSummary": "Framework reasoning: mapped to [industry], matrix shows [functions] as top opportunities. Customer confirmed [X]. Signals so far: Workability looks Strong (structured milestones), Access is Challenging (multiple systems with manual exports), Context unknown, Trust unknown. Next probe: Context."
}

## Insight Types & Icons
- "industry" — Industry mapping
- "opportunity" — Agent opportunity identified (use High/Medium/Low, never numeric scores)
- "maturity" — AI/automation maturity signal
- "risk" — Risk or blocker identified
- "systems" — System/tool identified
- "team" — Team size or structure
- "budget" — Budget signal
- "timeline" — Timeline signal

## Scoring
- clarityScore = integer 0-100: company(30%) + technical(25%) + painPoints(25%) + goals(20%)
- done=true when clarityScore >= 75 AND all dimensions >= 0.5
- When done: "I have a clear picture of where agents can drive impact for [company]. The top opportunities are [X] and [Y]. Let me generate your detailed assessment."

## Critical Rules
- Return ONLY valid JSON. No markdown fences.
- ALWAYS reference our matrix data — opportunity levels (High/Medium/Low), function names, industry benchmarks. NEVER expose numeric scores to the customer.
- insights = only NEW insights from the latest answer.
- Options must reference SPECIFIC functions, workflows, or systems — never generic "Yes/No/Not sure."
- thinkingSummary must track WACT dimensions using plain English: "Workability: Strong, Access: Challenging, Context: unknown, Trust: unknown" — use Excellent/Strong/Moderate/Challenging/Difficult, not numbers.`;
}

/**
 * Build the conversation message array for an interview session.
 * On the first round, injects all collected form and website context.
 * Ported from research app's buildInterviewMessages().
 */
export function buildInterviewMessages(
  conversationHistory: { role: "assistant" | "user"; content: string }[],
  companyWebContent?: string,
  formSummary?: string
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  // On first round, include ALL collected context: form data + website research
  if (conversationHistory.length === 0) {
    const parts: string[] = [
      "I've already provided my company information through the intake form. Here's everything you know about us:",
    ];

    if (formSummary) {
      parts.push("", "--- INTAKE FORM DATA ---", formSummary, "--- END FORM DATA ---");
    }

    if (companyWebContent) {
      parts.push("", "--- COMPANY WEBSITE RESEARCH ---", companyWebContent, "--- END WEBSITE ---");
    }

    parts.push(
      "",
      "You already have my company name, industry, size, systems, automation level, AI maturity, challenges, functions of interest, goals, timeline, and budget.",
      "DO NOT ask about any of these basics — you have them.",
      "Ask strategic follow-up questions that go DEEPER: probe the specific workflows, quantify the pain, uncover hidden assumptions, and validate our research data against my reality.",
    );

    messages.push({ role: "user", content: parts.join("\n") });
  } else if (companyWebContent || formSummary) {
    // On subsequent rounds, re-inject context so the LLM doesn't forget
    const context = [
      formSummary ? `[Form context: ${formSummary}]` : "",
      companyWebContent ? `[Website context available]` : "",
    ].filter(Boolean).join(" ");
    messages.push({ role: "user", content: context });
  }

  for (const msg of conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Jumpstart prompt
// ---------------------------------------------------------------------------

/**
 * Build a prompt that instructs the LLM to generate a jumpstart.md document
 * from a completed assessment output.
 *
 * The jumpstart.md is a concise, action-oriented artifact that captures the
 * top agent opportunities, recommended agent roles, scope recommendations,
 * risk factors, and required integrations — structured for immediate use by
 * an implementation team.
 */
export function buildJumpstartPrompt(input: AssessmentInput, assessmentOutput: string): string {
  const parts = [
    `# Jumpstart Document Generation`,
    ``,
    `You are an AgentDash implementation strategist. Based on the Agent Readiness Assessment below, generate a structured **jumpstart.md** document that an implementation team can use immediately to begin deploying AI agents for this company.`,
    ``,
    `## Company Profile`,
    `- **Company:** ${input.companyName}`,
    `- **Industry:** ${input.industry}`,
    `- **Size:** ${input.employeeRange} employees`,
    `- **Revenue:** ${input.revenueRange}`,
    `- **AI Maturity:** ${input.aiUsageLevel || "Not specified"} usage, ${input.agentExperience || "No"} agent experience`,
    `- **Key Systems:** ${input.currentSystems || "Not specified"}`,
    `- **Primary Goal:** ${input.primaryGoal}`,
    `- **Timeline:** ${input.timeline}`,
    `- **Pilot Budget:** ${input.budgetRange}`,
    ``,
    `## Assessment Output`,
    assessmentOutput,
    ``,
    `---`,
    ``,
    `## Instructions`,
    ``,
    `Extract all recommended agent opportunities from the assessment and produce a jumpstart.md with this EXACT structure:`,
    ``,
    `\`\`\`markdown`,
    `# AgentDash Jumpstart — {Company Name}`,
    ``,
    `## Company Profile`,
    `- **Industry:** {industry}`,
    `- **Size:** {employee range}`,
    `- **Revenue:** {revenue range}`,
    `- **AI Maturity:** {2-3 sentence summary of AI maturity from assessment}`,
    ``,
    `## Recommended Agent Opportunities`,
    ``,
    `### 1. {Opportunity Name} ({High/Medium/Low} Opportunity)`,
    `- **Function:** {category} > {sub-function}`,
    `- **WACT:** Workability: {Excellent/Strong/Moderate/Challenging/Difficult}, Access: {same}, Context: {same}, Trust: {same}`,
    `- **Agent Role:** {recommended agent role name}`,
    `- **Agent Description:** {1-2 sentences describing what this agent does day-to-day}`,
    `- **Initial Goals:**`,
    `  - {specific measurable goal 1}`,
    `  - {specific measurable goal 2}`,
    `- **Systems:** {comma-separated list of relevant integrations}`,
    ``,
    `{repeat for each opportunity, numbered sequentially}`,
    ``,
    `## Scope Recommendations`,
    ``,
    `### Company-Wide`,
    `Deploy all {N} recommended agents across departments. {1-2 sentence rationale}`,
    ``,
    `### Department: {most relevant department}`,
    `Focus agents: {comma-separated list of agents most relevant to this department}`,
    ``,
    `### Team: {most impactful starting team}`,
    `Focus agent: {single highest-impact agent for this team}`,
    ``,
    `## Risk Factors`,
    `- **{Risk name}:** {description} — Mitigation: {specific mitigation}`,
    `{repeat for each risk, 3-5 total}`,
    ``,
    `## Systems to Integrate`,
    `- **{System name}** — {role this system plays in agent deployment}`,
    `{repeat for each required integration}`,
    `\`\`\``,
    ``,
    `## Rules`,
    `- Extract WACT scores from the assessment as Excellent/Strong/Moderate/Challenging/Difficult — NEVER use numeric scores`,
    `- For each opportunity, invent a specific agent role name (e.g., "Patient Scheduling Agent", "Claims Pre-Auth Agent")`,
    `- Initial goals must be specific and measurable (e.g., "Reduce scheduling time from 15 min to 2 min")`,
    `- Systems list should reference the company's actual systems from their profile plus any identified in the assessment`,
    `- Risk factors must include specific mitigations, not just descriptions`,
    `- Output ONLY the jumpstart.md content — no preamble, no explanation, just the document`,
  ];

  return parts.join("\n");
}
