# Introducing AgentDash: An AI Workforce Management Platform Built on Open Source

*For Medium and LinkedIn*

---

We've been building AgentDash — an AI agent orchestration platform that lets companies deploy, manage, and scale AI agent workforces with real human oversight.

Today we want to share what we're building, why, and how we're onboarding our first client.

## The Problem We Kept Seeing

Every company we talked to had the same story: they're using AI — ChatGPT here, Claude there — but it's chaos. No one knows what the agents are working on, what they're spending, or how to stop one that's going off the rails.

The missing piece isn't better AI. It's management infrastructure.

AgentDash is that infrastructure. Think of it as the control plane between your business and your AI agents.

## What We Built

AgentDash is a full platform for running AI agent workforces:

- **Agent Factory** — Create agent templates with defined roles, budgets, and skills. Spawn agents from templates with approval gates. No agent runs without a human saying "go."
- **Morning Dashboard** — A single screen showing what your agents are doing, what needs attention, and where the money's going. The CEO briefing for your AI workforce.
- **CRM Pipeline** — Accounts, contacts, deals, and leads with bidirectional HubSpot sync. Your agents work inside your existing sales workflows, not alongside them.
- **Security & Kill Switch** — Security policies, sandbox environments, and a kill switch that halts every agent instantly. Because "move fast" and "don't break things" aren't mutually exclusive.
- **Task Dependencies** — Create work with dependency chains. When Agent A finishes a task, Agent B's blocked task automatically unblocks. No human needed to route work.
- **Budget Tracking** — Set monthly budgets by department. Hard stops when limits are hit. No surprise bills.
- **Skills Registry** — Versioned, reviewed capabilities that agents can learn. Draft, review, publish — like code review, but for agent skills.
- **Guided Onboarding** — An LLM-powered onboarding flow that ingests your company docs, extracts context, and suggests the right agent team for your business.

29 database tables. 15 services. 120+ API endpoints. 10 UI pages. All company-scoped with proper tenant isolation.

## Built on Paperclip

We didn't build from zero. AgentDash is built on [Paperclip](https://github.com/paperclipai/paperclip), the open-source AI agent control plane.

Paperclip gives us the core engine — agent lifecycle management, heartbeat monitoring, issue tracking, approval workflows, plugin system, and execution workspaces. It's solid, well-tested infrastructure that we'd rather build on than rebuild.

What we added is the business layer: the Agent Factory for template-based deployment, CRM integration for sales workflows, security policies for governance, budget management for cost control, and guided onboarding so a new client can go from zero to running agents in a single session.

We actively track Paperclip's upstream releases and merge them regularly. We built a repeatable sync process so we're never more than a few days behind. When Paperclip ships workspace runtime improvements or inbox features, we get them automatically.

Open source is how infrastructure should work. Paperclip is the engine. AgentDash is the cockpit.

## How We Onboard a Client

We spent a lot of time making onboarding fast and real. Here's the actual flow we run for a new client — tested end-to-end with automated validation:

**Phase 1: Deploy** (30 minutes)
Spin up AgentDash on the client's infrastructure. Docker compose, health check, bootstrap the admin account. Embedded PostgreSQL starts automatically.

**Phase 2: Set Up the Company** (1 hour)
Create the company in the system. Start a guided onboarding session. Paste in company descriptions, docs, wiki pages — the LLM extracts your domain, products, tech stack, and team structure. Set strategic goals with priorities and target dates.

**Phase 3: Governance First** (30 minutes)
Before any agent runs, we set up departments, security policies, and budget limits. This isn't optional. We believe in governance-first AI deployment.

**Phase 4: Design the Agent Team** (1 hour)
Create agent templates — a Tech Lead, Engineers, QA agents — each with defined budgets, skills, and department assignments. The system can suggest a team composition based on your company context.

**Phase 5: Deploy Agents** (30 minutes)
Spawn agents from templates. Every spawn request requires approval. Once approved, agents inherit their template's budget, department, and configuration. Set OKRs so every agent has measurable objectives.

**Phase 6: Create Work** (1 hour)
Set up projects, create issues with dependency chains, assign to agents. The dependency DAG ensures work flows in the right order automatically.

**Phase 7: Connect CRM** (30 minutes)
Configure HubSpot integration. Map your pipeline. Your agents can now read and write to your CRM — creating contacts, updating deals, managing leads.

**Phase 8: Go Live** (15 minutes)
Verify the dashboard, check capacity, test the kill switch. Done.

**Total: about 5 hours from zero to a running AI workforce.** Not weeks. Not months. One focused day.

## The BYOT Model

AgentDash charges for orchestration, not AI usage. You bring your own LLM API keys — Anthropic, OpenAI, whatever you use. Your agents run on your tokens, on your infrastructure, with your data.

We think this is the right model. You shouldn't have to pay a markup on API calls to get management infrastructure. And your data should never leave your environment.

## What's Next

We're onboarding our first client now. A mid-size B2B SaaS company that's using HubSpot and wants to deploy agents for lead qualification, content drafting, and engineering task triage.

If that sounds like you — a 20-100 person company drowning in work that AI could handle, using HubSpot, and wanting to move fast but responsibly — we'd love to talk.

The platform is real. The onboarding flow is tested. The kill switch works.

Let's build your AI workforce.

---

*AgentDash is open source, built on [Paperclip](https://github.com/paperclipai/paperclip). We believe AI workforce management should be transparent, self-hosted, and governed.*
