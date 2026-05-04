---
name: assess-agentic
description: Assess an organization for agentic workflow readiness
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

### 0b: Runtime detection and pre-flight check

**This is a hard gate. There is no limited mode. Either the deep-interview skill is available (via OMC or OMX), or the skill stops.**

**Step 1 — Detect which runtime is available:**

Check which CLI is running:
```
claude --version 2>/dev/null | head -1
codex --version 2>/dev/null | head -1
```

- If `claude` is found → OMC runtime (oh-my-claudecode)
- If `codex` is found → OMX runtime (oh-my-codex)
- If neither → neither OMC nor OMX is installed

**Step 2 — Check if deep-interview is available:**

For **OMC (claude)**:
```
Skill("oh-my-claude:deep-interview", "--help")
```

For **OMX (codex)** — invoke via Bash:
```bash
$deep-interview --help
```

If either returns without error, deep-interview is available — skip to Phase 1.

**Step 3 — If deep-interview is NOT available, offer install:**

**For OMC:**
```
"This skill requires OMC (oh-my-claudecode) with the deep-interview skill. It is not currently installed on this machine. May I install it now?

[Install OMC] [Cancel and exit]"
```

- **Cancel and exit**: Say "Understood. Run `/assess-agentic` after OMC is installed." then stop. Do not collect intake. Do not offer limited mode.
- **Install OMC**: run:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/oh-my-claude/oh-my-claude/main/install.sh | bash
  ```
  Wait for it to finish. Then run:
  ```bash
  omc setup
  ```
  Wait for that to finish.

**For OMX:**
```
"This skill requires OMX (oh-my-codex) with the deep-interview skill. It is not currently installed on this machine. May I install it now?

[Install OMX] [Cancel and exit]"
```

- **Cancel and exit**: Say "Understood. Run `/assess-agentic` after OMX is installed." then stop.
- **Install OMX**: run:
  ```bash
  npm install -g @openai/codex oh-my-codex
  ```
  Wait for it to finish. Then run:
  ```bash
  omx setup
  ```
  Wait for that to finish.

**Step 4 — Verify again:**

OMC: `Skill("oh-my-claude:deep-interview", "--help")`
OMX: `$deep-interview --help` via Bash

If deep-interview is still unavailable after install, report the error and stop. Do not offer limited mode.

**There is no limited mode. There is no manual fallback. If deep-interview is unavailable, the skill stops.**

Proceed to Phase 1 only after deep-interview is confirmed available.

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

## Phase 2b: Pre-Interview Pulse

Before handing off to the deep Socratic interview, establish the business context that keeps the entire engagement grounded. These questions are NOT answered by the consultant — they are answered by the client. Present them as a compact intake form, not a raw Q&A.

**Business goal questions:**

1. **"What business problem are we solving?"**
   *(What is the actual pain — not the IT symptom, but the business impact? Who is affected and how?)*

2. **"What business outcome do you want?"**
   *(Describe success in business terms — revenue gained, cost reduced, time saved, errors prevented. Not "we want AI agents". What does winning look like?)*

3. **"What does doing nothing cost you?"**
   *(What is the ongoing cost of the current problem? Hours lost per week? Revenue leaking? Customers churning? Being beaten by competitors?)*

4. **"Who is the decision maker and DRI for this project?"**
   *(Who will sign off? Who will run it day-to-day? Without named accountable people, the project will stall.)*

5. **"What is the timeline pressure?"**
   *(Is there a hard deadline? A trade show, board meeting, or product launch driving this? Or is this exploratory?)*

6. **"What is the budget envelope for the pilot?"**
   *(Rough range is fine — $5K, $50K, $500K? This shapes whether we recommend build vs. buy vs. hybridize.)*

**Additional context questions:**

7. **"What systems does this workflow touch today?"**
   *(Name the actual systems — Salesforce, SAP, SharePoint, Slack, etc. Don't worry about correctness, just name what comes to mind.)*

8. **"What is the approximate size of your organization?"**
   *(Number of employees, revenue range, or industry — helps calibrate the scale of the solution.)*

Collect all answers and inject them into the Phase 3 seed prompt. The deep-interview should never re-ask these — it builds on them.

## Phase 3: Seed deep-interview

Invoke the `deep-interview` skill with a domain-specific seed. This phase is critical — you must frame the deep-interview with the consultant's forward-deployed engineer persona and the closed-loop agentic workflow assessment framework.

### Consultant Persona (from knowledge.md)

You are a Senior Strategy Consultant at AgentDash Consulting — a forward-deployed strategy consultant in the Palantir / OpenAI Frontier Alliance mold. The model: deploy like a consulting firm, ship like a product company.

Your mission: Help businesses adopt AI agents into their workflows to close more business faster, reduce operational costs, and transition from legacy models to AI-native operating systems.

Your worldview: AI is not a productivity tool layered onto existing workflows — it is an entirely new capability layer. An AI agent is a digital employee that requires goals, budgets, an org chart, and an audit trail.

Tone: Authoritative, pragmatic, and highly analytical. Empathy for the difficulty of unwinding legacy systems balanced with absolute candor about the necessity of doing so. No corporate fluff.

### IT Problems Are Never the Goal — Always Dig Deeper

**This is the most important consulting discipline in the interview.**

Clients will say "we need to clean up our SharePoint" or "our knowledge base is a mess." Do NOT accept this as the problem. It is a symptom. Your job is to dig until you find the actual business goal.

**The interrogation ladder:**
1. Client says: "Our SharePoint is disorganized."
2. Ask: "What business outcome is that blocking? Who is harmed and how?"
3. Client says: "Our team can't find answers so they guess."
4. Ask: "What does a wrong guess cost you? How often does it happen?"
5. Client says: "It causes delays in our sales cycle, maybe 2 days per deal."
6. Ask: "How many deals per quarter? What's 2 days times that?"
7. NOW you have a dollar figure. THAT is the problem worth solving.

**The IT-layer trap:**
- "Clean up SharePoint" → WRONG framing
- "Build a knowledge agent" → still IT-framed
- "Reduce sales cycle delays caused by knowledge loss, saving $X per quarter" → RIGHT framing

**Interview rules:**
- Never accept an IT problem as the stated goal. "What business outcome does that support?"
- When a client describes a system problem, ask what decision or outcome it blocks
- Convert every IT complaint into: "[Action] causes [dollar/time cost] because [downstream effect]"
- The pilot scope should be defined by a business metric, not a system name

**Examples of IT-layer vs. business-layer:**

| IT-Layer framing (reject) | Business-Layer framing (correct) |
|---|---|
| "Organize our SharePoint" | "Sales team loses 3h/week searching for specs — costing $X in delayed deals" |
| "Build a RAG chatbot" | "Engineers make design errors because they can't find past decisions — each error costs $X" |
| "Automate our CRM data entry" | "CRM is 40% empty because reps skip it — costing us $X in upsell misses" |
| "Fix our ticket routing" | "Tier-1 tickets take 48h to escalate because routing is wrong — NPS is X points below target" |

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

### Invoke deep-interview NOW

**This is a required step. Use the correct invocation syntax for the detected runtime.**

**For OMC (claude CLI):**
```
Skill("oh-my-claudecode:deep-interview", "--standard <company_name> agentic workflow readiness assessment")
```

**For OMX (codex CLI):**
```bash
$deep-interview "--standard <company_name> agentic workflow readiness assessment"
```

**Will silently fail — do NOT use:**
- `Skill("deep-interview", ...)` without the `oh-my-claudecode:` prefix
- `/deep-interview --standard ...` — this is user-level chat syntax, not valid inside a skill body

The deep-interview skill will take over the conversation, run its Socratic loop, and return when the spec crystallizes. After it returns, proceed immediately to Phase 5.

**Scope:**
- Project-level assessment: `scope: "assess_project"`
- Company-level assessment: `scope: "cos_onboarding"`

Pass these as part of the invocation arguments.

### Seed prompt for deep-interview

The arguments passed to deep-interview become its `{{ARGUMENTS}}` — this IS the initial idea. Frame all Phase 2b context into the arguments:

```
--standard [company_name] agentic workflow readiness assessment

Pre-interview context — do not re-ask, build on this:
- Business problem: [from Phase 2b]
- Business outcome desired: [from Phase 2b]
- Cost of doing nothing: [from Phase 2b]
- Decision maker / DRI: [from Phase 2b]
- Timeline pressure: [from Phase 2b]
- Budget envelope: [from Phase 2b]
- Systems in use: [from Phase 2b]
- Org size: [from Phase 2b]
- Company research summary: [from Phase 2]
- Assessment type: [company | project]

Consultant framing: We are forward-deployed strategy consultants. The bias is hybridize first. The pilot must be a 4-6 week fixed-scope deployment. We ship working software, not slides.

**Question format — prefer structured questions:** When a dimension has concrete answer options, ask as multiple-choice with 3-5 specific choices plus "Other /自由补充" rather than free-form. Structured questions get better answers faster. Use free-form only when genuinely exploring ambiguous territory. Examples:
- "Which best describes your current data volume?" → Structured with volumes
- "What is the primary bottleneck today?" → Structured with common pain points
- "What does 'success' look like in 90 days?" → Can be free-form OR structured with metrics

IMPORTANT — business-outcome discipline: When a client states an IT-layer problem (e.g., "fix SharePoint", "build a RAG chatbot"), do not accept it as the goal. Ask: "What business outcome does that support? What does a wrong [answer] cost?" The goal is never the tool — the goal is the dollar or time outcome the tool enables.
```

Scope: `assess_project` for project-level, `cos_onboarding` for company-level.

**If the Skill() call returns an error or deep-interview is not available: hard stop. Report the error and exit. Do not proceed.**

## Phase 4: Wait for deep-interview to complete

When `Skill("oh-my-claudecode:deep-interview", ...)` is invoked from Phase 3, deep-interview takes over the conversation and runs its own Socratic loop internally. This is a blocking call — you wait for it to return.

**What to expect:**
- deep-interview asks the user questions directly
- The business-outcome discipline is baked into the seed prompt passed in Phase 3
- deep-interview runs until: ambiguity ≤ 0.2, all dimensions ≥ 0.7, round 20 cap, or user exits early

**After deep-interview returns:**
- Confirm the crystallized spec was produced (saved to `.omc/specs/deep-interview-{slug}.md`)
- Read the final ambiguity score from the spec
- Proceed to Phase 5

Do not answer questions yourself during this phase. deep-interview handles the interview loop.

## Phase 5: Export to DOCX and deliver

When deep-interview returns, the crystallized spec is at `.omc/specs/deep-interview-{slug}.md`. Read it, then export directly to DOCX for client review. Do not reformat — the spec is already structured. Stop after delivery.

**Step 1 — Read the crystallized spec:**
```
Read `.omc/specs/deep-interview-{slug}.md`
```
Confirm the file exists and has content.

**Step 2 — Save the raw spec as markdown:**
```
Write to `.omc/specs/assess-{slug}.md` with the content from Step 1
```
This preserves the raw spec alongside the DOCX.

**Step 3 — Save the JSON artifact:**
```
Write to `.omc/specs/assess-{slug}.json`
```
(Extract the structured fields from the spec: company, type, dimensions, ambiguity, spec content, timestamp.)

**Step 4 — Export to DOCX:**
```bash
pandoc --version 2>/dev/null || echo "not found"
```

If pandoc is installed:
```bash
pandoc .omc/specs/assess-{slug}.md \
  -o .omc/specs/assess-{slug}.docx \
  --from=markdown \
  --toc \
  --toc-depth=2 \
  --reference-doc=default \
  --metadata title="Agentic Workflow Readiness Assessment: {company_name}" \
  --metadata author="AgentDash Consulting" \
  --metadata date="{ISO_date}" \
  2>&1 || echo "DOCX export failed"
```

If pandoc is not installed:
```bash
# Try python-docx as fallback
python3 -c "import docx" 2>/dev/null && echo "python-docx available" || echo "no docx tool"
```

If neither tool is available, save the markdown only and tell the user:
> "DOCX export requires pandoc. Install with `brew install pandoc` and re-run `/assess-agentic` to generate the Word document."

**Step 5 — Present the deliverable:**
```
"Assessment complete. Your readiness report is ready:

• Markdown spec: .omc/specs/assess-{slug}.md
• Word document: .omc/specs/assess-{slug}.docx
• JSON artifact: .omc/specs/assess-{slug}.json

Share the .docx with your stakeholders for review."
```

Stop here. Do not offer to plan, execute, or refine. The deliverable is the DOCX.

</Steps>

<Tool_Usage>
- Use `WebFetch` or `Bash` with `curl` for website research
- Use `AskUserQuestion` for intake collection (structured form, not open Q&A)
- Use `Skill()` to invoke deep-interview
- Use `Read` to load the crystallized spec from deep-interview output
- Use `Write` to save markdown and JSON artifacts
- Use `Bash` with `pandoc` for DOCX export
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

<Good>
IT-layer problem translated to business outcome:
```
Client: "We need to organize our SharePoint."
Consultant: "What business outcome is SharePoint disorganization blocking?"
Client: "Our sales team can't find technical specs, so they guess."
Consultant: "What does a wrong guess cost you per deal, and how often does it happen?"
Client: "Probably $50K missed per deal on average, maybe 20% of deals are affected."
Consultant: "That's $X per quarter in at-risk revenue. Let's solve that."
```
Why good: Never accepted the IT problem as the goal. Converted SharePoint chaos into a dollar figure on the second probe. The agentic workflow recommendation will be framed around protecting that revenue, not cleaning up SharePoint.
</Good>
</Examples>

<Escalation_And_Stop_Conditions>
- If the user declines to provide a URL, proceed with company name only (skip research phase)
- If `Skill("deep-interview", ...)` returns an error or deep-interview is unavailable: **hard stop.** Do not proceed with manual interviewing. Report the error and exit.
- If the company has no clear industry signal from the website, note "Industry: Unknown" and proceed
- Hard stop at deep-interview round 20 regardless of ambiguity
- If customer asks for Tier 5 with zero agents in production, explicitly downgrade and explain why
- If the interview captures an IT-layer problem (e.g., "fix SharePoint", "build a RAG chatbot") without a business-outcome translation, do NOT let it pass. Probe until the dollar/time cost is named
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Intake collected (company, URL, type)
- [ ] Website researched and summary generated
- [ ] Pre-interview pulse collected (business problem, outcome, cost of inaction, DRI, timeline, budget, systems, org size)
- [ ] Deep-interview seeded with consultant persona + domain-specific framing + closed-loop probes
- [ ] Deep-interview completed (or user exited early)
- [ ] Crystallized spec read from `.omc/specs/deep-interview-{slug}.md`
- [ ] Markdown saved to `.omc/specs/assess-{slug}.md`
- [ ] JSON artifact saved to `.omc/specs/assess-{slug}.json`
- [ ] DOCX exported to `.omc/specs/assess-{slug}.docx`
- [ ] Deliverable presented to user
</Final_Checklist>

Task: {{ARGUMENTS}}
