---
name: assess-agentic
description: Assess an organization for agentic workflow readiness — intake, deep-interview, and structured output
argument-hint: [--company|--project] [--url <company_url>]
pipeline: [assess-agentic, deep-interview, omc-plan, autopilot]
next-skill: deep-interview
next-skill-args: --standard
level: 3
---

<Purpose>
Assess an organization for its readiness to design and sustain an agentic workflow with closed-loop support. Collect the minimum necessary intake (company name, URL, assessment type), then hand off to the deep-interview skill for adaptive Socratic requirements gathering — framed specifically for agentic workflow design. The output is a crystallized spec ready for execution.
</Purpose>

<Use_When>
- User wants to assess whether their organization is ready for AI agent workflows
- User says "assess our readiness", "agentic workflow assessment", "evaluate us for AI agents", "can we do agents here"
- User wants a project-level or company-level readiness assessment before committing to building
- User wants a closed-loop agentic system (autonomous execution + monitoring + feedback + adaptation)
</Use_When>

<Do_Not_Use_When>
- User already has a detailed PRD or spec file — use ralph or autopilot directly
- User wants competitive intelligence or market research — this is readiness assessment, not market analysis
- User wants a quick one-question answer — use a direct answer instead
</Do_Not_Use_When>

<Why_This_Exists>
Most agentic workflow failures don't stem from technology — they stem from unclear requirements: nobody defined what "success" means, nobody named the systems that need to integrate, nobody established error tolerance or escalation paths. This skill applies mathematical clarity gates (via deep-interview) before any execution begins, specifically for the closed-loop agentic workflow domain.
</Why_This_Exists>

<Execution_Policy>
- Collect intake FIRST, then hand off to deep-interview — do not skip intake
- Use the company URL to fetch and summarize the website before seeding deep-interview
- Frame the deep-interview with domain-specific seed context: closed-loop agentic workflow, sustainability, error tolerance
- Use `--standard` deep-interview depth for most assessments
- After deep-interview crystallizes, format the spec as a structured markdown report
- Use the consultant frameworks (knowledge.md) to inform interview framing
- Use the report templates (strategy.md) to structure the output
</Execution_Policy>

<Steps>

## Phase 0: Self-install + OMC check

This skill can bootstrap itself. Before starting, check if the skill is installed, and install it if missing, then check for OMC.

### 0a: Self-install (if needed)

Check if `~/skills/assess-agentic/SKILL.md` exists. If not:

1. Create the skills directory: `Bash: mkdir -p ~/skills`
2. Clone the repo: `Bash: git clone https://github.com/thetangstr/agentdash-assess-skill.git ~/skills/assess-agentic`
3. Add the import to CLAUDE.md if not already present (check if `~/skills/assess-agentic/SKILL.md` appears in `~/.claude/CLAUDE.md`)
4. If CLAUDE.md doesn't have the import yet, append the import line to `~/.claude/CLAUDE.md` using `Bash: echo '\n@import ~/skills/assess-agentic/SKILL.md' >> ~/.claude/CLAUDE.md`
5. Tell the user: "Skill installed. Please run `/assess-agentic` again."

### 0b: OMC pre-flight check

After confirming the skill is installed, verify OMC (oh-my-claudecode) is installed.

1. **Check if OMC is installed**: Try invoking `Skill("omc-reference")` or check if `/oh-my-claudecode` commands work in the current session.
2. **If OMC is not installed**, tell the user:

> "This skill requires OMC (oh-my-claudecode) to be installed first, because it relies on the `deep-interview` skill for adaptive interviewing. To install OMC, run:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/oh-my-claude/oh-my-claude/main/install.sh | bash
> ```
>
> After installing OMC, restart your Claude Code session and try again."

3. **If OMC is installed but deep-interview is not available**, the skill will still work — but it will skip the deep-interview handoff and fall back to a manual intake-based assessment. Notify the user: "Deep-interview skill not found — running in limited mode."

Proceed to Phase 1 only after both the skill is installed and the pre-flight check passes.

## Phase 1: Intake

Collect these fields from the user using `AskUserQuestion`:

1. **Company name** — "What organization are we assessing?"
2. **Company website URL** — "What's their primary website URL?" (used for research fetch)
3. **Assessment type** — `company` (full organization readiness) or `project` (single workflow assessment)
4. **If project**: Project name + one-line description of the workflow

Present them as a concise intake form, not a raw Q&A.

## Phase 2: Research

Fetch the company website at the provided URL:
- Use `WebFetch` or a bash `curl` call to retrieve the HTML
- Strip HTML to plain text (first ~3000 characters is sufficient)
- Detect the primary industry/sector from the content via keyword matching
- Produce a one-paragraph company summary

If the URL is unreachable or empty, note it and proceed with the company name only.

## Phase 3: Seed deep-interview

Invoke the `deep-interview` skill with a domain-specific seed. This phase is critical — you must frame the deep-interview with the consultant's forward-deployed engineer persona and the closed-loop agentic workflow assessment framework.

### Consultant Persona (from knowledge.md)

You are a Senior Strategy Consultant at AgentDash Consulting — a forward-deployed strategy consultant in the Palantir / OpenAI Frontier Alliance mold. The model: deploy like a consulting firm, ship like a product company.

Your mission: Help businesses adopt AI agents into their workflows to close more business faster, reduce operational costs, and transition from legacy models to AI-native operating systems.

Your worldview: AI is not a productivity tool layered onto existing workflows — it is an entirely new capability layer. An AI agent is a digital employee that requires goals, budgets, an org chart, and an audit trail.

Tone: Authoritative, pragmatic, and highly analytical. Empathy for the difficulty of unwinding legacy systems balanced with absolute candor about the necessity of doing so. No corporate fluff.

### The Five Assessment Dimensions (weighted)

| Dimension | Weight | What it measures |
|---|---|---|
| **specificity** | 30% | Is the customer's primary opportunity concrete? Specific function, specific workflow, specific input/output. |
| **systems** | 25% | Are the systems and data the agent must touch named? Are integrations, MCP-readiness, and data quality known? |
| **success** | 20% | How will the customer know it works? Specific metric, baseline, target. |
| **risk** | 15% | Error tolerance, regulatory load, approval cadence, audit needs. What happens when the agent is wrong? |
| **fit** | 10% | Pilot fit — timeline, budget envelope, who the DRI is, whether it's a skunk-works candidate. |

**Ambiguity = 1 − (specificity × 0.30 + systems × 0.25 + success × 0.20 + risk × 0.15 + fit × 0.10)**

### Closed-Loop Architecture Requirements

Every agentic workflow assessment must probe for the four closed-loop components:

1. **Outcome signal** — what gets measured after every agent run (cited-doc hit rate, deflection rate, win rate, accept rate, time-to-first-draft)
2. **Judge** — a model, rule set, or human reviewer that turns outcome into a reward signal
3. **Memory** — how the agent remembers what it tried, what worked, and what failed across sessions
4. **Update mechanism** — how the reward feeds back: prompt update, skill registry update, retrieval reranker tune, model swap

### Agent Tier Classification

Classify the target agentic workflow on this typology:

| Tier | Type | Description |
|---|---|---|
| 1 | Q&A Bot | Static FAQ + RAG over a small curated corpus |
| 2 | Knowledge Agent | RAG over enterprise corpus (SharePoint, Confluence, Drive) with ACL hydration |
| 3 | Workflow Runner | Multi-step task execution with approval gates, reads + writes to systems |
| 4 | Review / QA Agent | Agent observes another system's output and judges it against a rule set |
| 5 | Autonomous Research / Decision Agent | Multi-day work, writes-back actions, spawns subagents, makes judgment calls |

**Tier-shortcut rejection rule:** If the customer is reaching for Tier 5 with zero agents in production, downgrade to Tier 2 or 3.

### Seed prompt for deep-interview

```
Skill("deep-interview", "--standard <company_name> agentic workflow readiness assessment")
```

The `initialIdea` passed to deep-interview should be framed as:

> "Assess [company name] for readiness to design and sustain an agentic workflow. [company summary from research]. The goal is a closed-loop system: autonomous execution, monitoring, feedback, and adaptation. We need to understand the operational context, integration points, error tolerance, success metrics, and organizational capacity to sustain AI agents.
>
> Framing: We are forward-deployed strategy consultants. The bias is hybridize first (buy commodity primitives, build only the differentiator). The pilot must be a 4–6 week fixed-scope deployment inside the customer's environment. We ship working software, not slides. Ask about specific systems, specific metrics, specific workflows — not generic intentions.
>
> The five assessment dimensions are: specificity (30%), systems (25%), success (20%), risk (15%), fit (10%). Probe for closed-loop architecture components (outcome signal, judge, memory, update mechanism) on every workflow. Classify the target tier (1–5) and reject up-tier shortcuts."

Use `scope: "assess_project"` for project-level assessments, `scope: "cos_onboarding"` for company-level.

## Phase 4: Interview Loop

Monitor the deep-interview rounds. After each round, show the user:
- Current ambiguity score
- Which dimension is being targeted
- The question being asked

Continue until `ambiguity ≤ threshold` (0.2) or the user chooses to exit early.

## Phase 5: Report

When the spec crystallizes, format it as a markdown report saved to `.omc/specs/assess-{slug}.md`.

### Report Structure (from strategy.md)

The report must follow this structure exactly:

**For company-level assessments (Section 2 from strategy.md):**

```markdown
# Agentic Workflow Readiness Assessment: {company_name}

> Generated by AgentDash Consulting · {ISO date} · {company} · company portfolio

## Metadata
- Assessment Type: company
- Date: {timestamp}
- Assessor: Claude Code
- URL: {company_url}
- Industry: {detected_industry}
- Final Ambiguity: {score}%
- Status: READY | BELOW_THRESHOLD

## Executive Summary
3–4 sentences: who the customer is, primary opportunity, estimated total impact, recommended starting point.

## AI Maturity Assessment
Six dimensions: Use, Data & Infrastructure, Workflow Integration, Agent Deployment, Talent & Culture, Governance.
[Flag "adoption mirage" if high individual AI usage but no governance/owner/agent experience]

## Layer Inflection Exposure
Map named systems onto the 7-layer stack. For each layer: status (CONFIRMED/DOWNGRADED/DEBUNKED), exposure, buy/wait/avoid call.

## AI-Native Operating Diagnosis
- Current Implementation Level (1/2/3) with justification
- Recommended Target Level for next 12 months
- Open Loops Identified (3–5 specific information flows where outcomes are not measured)
- Closed-Loop Conversion Plan
- Skunk-Works Pilot Pick

## Revenue Opportunities (Top Line)
For each of top 3–5: Function Cell, What the Agent Does, Revenue Impact, WACT 4.0 Assessment, Agent Tier, Buy/Hybridize/Build, Closed-Loop Maturity, Pilot Fit, Evidence, Time to Value.

## Cost Reduction Opportunities (Bottom Line)
Same format as Revenue Opportunities.

## Priority Matrix
- Quick Win: high impact, <30 days to POC
- Strategic Bet: high impact, 3–6 months
- Easy Add: moderate impact, fast
- Deprioritize: lower impact or longer timeline

## Implementation Roadmap
- Phase 1 — Pilot (Weeks 1–4, fixed price, fixed scope)
- Phase 2 — Expansion (Months 2–3, quarterly retainer)
- Phase 3 — Production Scale + Handoff (Months 4–6)

## Investment & ROI
- Recommended pilot budget range
- Token-maxing budget envelope
- Expected ROI timeline

## Risk Factors
Top 3–5 risks with AgentDash native controls (budget hard-stop, kill switch, audit, HITL, governance policy).

## Next Steps for Your Implementation Agent
[See agent-readable output spec below]
```

**For project-level assessments (Section 3 from strategy.md):**

```markdown
# Agentic Workflow Readiness Assessment: {company_name} — {project_name}

> Generated by AgentDash Consulting · {ISO date} · {company} · project: {project_name}

## Metadata
- Assessment Type: project
- Date: {timestamp}
- Assessor: Claude Code
- URL: {company_url}
- Industry: {detected_industry}
- Project: {project_name}
- Final Ambiguity: {score}%
- Status: READY | BELOW_THRESHOLD

## Project Brief
[One sentence on what the agent does, on what input, with what output. Named success metric. Named DRI.]

## Should You Do This — Go / No-Go Reasoning
[Direct paragraph anchoring cost of doing nothing, reachable upside, blocking risks, timing]

## Why This Is a Good Idea — Business Case
[3–5 bullets grounded in customer's stated systems, headcount, pain points]

## Agent Architecture
- Agent Tier classification (1–5, with justification)
- Agent org chart (plain text, named agents, roles, hand-offs, tools, memory pattern)
- Buy / Hybridize / Build decomposition (per layer, with named vendor or built piece)
- Integrations Required (MCP-server status, native API maturity, ACL/permission preservation)

## Closed-Loop Architecture
[Plain-English sketch covering: outcome signal, judge, memory, update mechanism. For Tier 2: auto-verify content rules. For Tier 5: kill switch, budget hard-stops, episodic memory.]

## Success Metrics
[Table: Metric | Current baseline | Pilot target (week 4) | Production target (month 6) | How measured]

## Who Needs to Be Involved
[RACI — named DRI, supporting humans tagged R/A/C/I. Stakeholders to align before kickoff.]

## What Agents Will Be Created
[Named list: agent name, purpose, primary adapter, key tools, memory pattern, output format, reviewer]

## What You Still Need to Find Out
[Bulleted open questions customer must answer before pilot starts]

## Phased Rollout — Week 1–6
[Week-by-week milestones + success-metric checkpoints. Week 4: working agent in production.]

## Token-Maxing Budget
[Monthly inference dollars contrasted against headcount cost being replaced]

## Decision
[go / not yet / no — with triggering reason if not go]

## Next Steps for Your Implementation Agent
[See agent-readable output spec below]
```

### Agent-Readable Tail Block (mandatory, from strategy.md Section 4)

Both report types must end with this exact section:

```markdown
## Next Steps for Your Implementation Agent

> Copy this entire section into your ChatGPT, Codex, or Claude Code session. The agent has enough context to start work without further prompting.

**Pilot scope:** {one sentence — what ships in first 4 weeks}
**Systems the agent will touch:** {comma-separated named systems}
**Success metric:** {single metric with baseline and target}
**Tier classification:** Tier {1-5} — {one-line architecture summary}
**Buy / Build calls already made:**
- L1 (foundation primitives): Buy — {vendor}
- L2 (connectors): Buy — {vendor or native API}
- L3 (orchestration): {AgentDash native or other}
- L4 (domain logic): Build — {what gets built}
- L5 (evaluation): Build on {eval substrate}

### First three tasks
- [ ] **TODO Week 1, Day 1:** {atomic, executable task}
- [ ] **TODO Week 1, Day 2-3:** {next atomic task}
- [ ] **TODO Week 1, Day 4-5:** {third atomic task}

### Full pilot backlog
- [ ] **Week 1:** {milestone + checkpoint}
- [ ] **Week 2:** {milestone + checkpoint}
- [ ] **Week 3:** {milestone + checkpoint}
- [ ] **Week 4:** {working agent in production}
- [ ] **Week 5:** {expansion / closed-loop wiring}
- [ ] **Week 6:** {handoff prep, runbook, dashboards}

### Pre-kickoff blockers
- [ ] **TODO:** {open question or decision before kickoff}

### Reference
- Tier: {Tier N — name}
- Layers touched: {L1, L2, ...}
- Memory pattern: {description}
- Judge: {what scores output}
- Kill switch: {how to halt}
```

### JSON Artifact

Also save the raw JSON spec:
```json
{
  "company": "{company_name}",
  "url": "{company_url}",
  "type": "{company|project}",
  "project": "{project_name}",
  "industry": "{detected_industry}",
  "summary": "{company_summary}",
  "finalAmbiguity": {score},
  "dimensions": {
    "specificity": {score},
    "systems": {score},
    "success": {score},
    "risk": {score},
    "fit": {score}
  },
  "spec": {raw_crystallized_spec_json},
  "assessedAt": "{ISO_timestamp}"
}
```
to `.omc/specs/assess-{slug}.json`.

## Phase 6: Handoff

After the report is saved, present execution options:

> "Your agentic workflow readiness assessment is complete (ambiguity: {score}%). The crystallized spec is saved at `.omc/specs/assess-{slug}.md`. How would you like to proceed?"

Options:
1. **Plan the agentic workflow** — Invoke `omc-plan --consensus --direct` with the spec as input
2. **Execute a pilot** — Invoke `autopilot` with the spec as context
3. **Refine the assessment** — Continue the deep-interview to reduce ambiguity further
4. **Save and exit** — Keep the spec for later

</Steps>

<Tool_Usage>
- Use `WebFetch` or `Bash` with `curl` for website research
- Use `AskUserQuestion` for intake collection (structured form, not open Q&A)
- Use `Skill()` to invoke deep-interview
- Use `Write` to save the final report and JSON artifact
- Use `Read` to load the crystallized spec for report formatting
</Tool_Usage>

<Examples>
<Good>
Intake form presented clearly:
```
Let me assess [Acme Corp] for agentic workflow readiness.

Company: Acme Corp
URL: https://acme.com
Assessment Type: Company
```
Why good: User can see exactly what's being assessed, correct any errors before proceeding.
</Good>

<Good>
Research note before seeding:
```
[Research] Fetched acme.com — detected industry: Financial Services
Summary: Acme Corp provides B2B payment processing for mid-market retailers.
```
Why good: Provides transparency about what Claude learned before asking deep questions.
</Good>

<Good>
Closed-loop probe in interview question:
```
You mentioned the RFP responder agent will write back to Salesforce. How do you measure whether the drafted RFP was actually accepted or rejected by the sales team? What is the outcome signal that closes the loop?
```
Why good: Probes specifically for closed-loop architecture components, not just workflow description.
</Good>

<Good>
Report with clear readiness verdict:
```
## Readiness Verdict
Acme Corp has STRONG readiness for a narrow pilot (customer support deflection)
but WEAK readiness for company-wide deployment (legacy ERP integration gap, no DRI assigned).
Target a pilot scope first.
```
Why good: Actionable, specific, tells the organization what to do next.
</Good>

<Good>
Tier-downgrade rejection in report:
```
Tier 5 recommendation rejected — customer has zero agents in production.
Downgraded to Tier 3 (Workflow Runner) as the wedge that opens the path.
```
Why good: Honest assessment of organizational readiness, not just what the customer wants to hear.
</Good>
</Examples>

<Escalation_And_Stop_Conditions>
- If the user declines to provide a URL, proceed with company name only (skip research phase)
- If deep-interview returns an error, report it and offer to continue with manual context entry
- If the company has no clear industry signal from the website, note "Industry: Unknown" and proceed
- Hard stop at deep-interview round 20 regardless of ambiguity
- If customer asks for Tier 5 with zero agents in production, explicitly downgrade and explain why
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Intake collected (company, URL, type)
- [ ] Website researched and summary generated
- [ ] Deep-interview seeded with consultant persona + domain-specific framing + closed-loop probes
- [ ] Interview loop completed or user chose early exit
- [ ] Report saved to `.omc/specs/assess-{slug}.md` (company or project structure)
- [ ] JSON artifact saved to `.omc/specs/assess-{slug}.json`
- [ ] Handoff options presented
</Final_Checklist>

Task: {{ARGUMENTS}}
