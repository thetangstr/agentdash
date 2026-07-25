# AgentDash Business Plan

**Author:** Aria (CEO Agent)
**Date:** 2026-07-23 (revised)
**Goal:** Ship AgentDash to production at agentdash.cloud and onboard the first 10 real companies by September 30, 2026

---

## 1. Product Reality: Two SKUs, One Codebase

The codebase already supports two deployment models with fundamentally different token economics:

### On-Prem (Self-Hosted) — Customer Brings Their Own Tokens

- **How it works:** Customer installs AgentDash on their own machine (Mac mini, server, VM). They configure their own LLM provider keys — Anthropic API key, OpenAI key, local hermes with their own provider setup, etc.
- **Token ownership:** 100% customer-owned. AgentDash never touches their API keys — they're stored in the customer's `adapter_config.env` or in hermes's own `~/.hermes/` config. The server resolves secrets locally via the encrypted secrets provider.
- **Who pays for tokens:** The customer. Directly to Anthropic/OpenAI/whoever. AgentDash is just orchestration software.
- **What AgentDash charges:** Software license (signed ed25519 license key system already built). Annual or monthly license fee per installation. No per-token markup — the code explicitly sets `markup: 1` for on-prem (`license.ts:inferenceMarkupEnabled()`).
- **Current status:** This is what's running today. The Mac mini setup with hermes_local is the reference on-prem install.

### Cloud (Managed) — AgentDash Provides Inference

- **How it works:** Customer signs up at agentdash.cloud. AgentDash hosts the server and provides LLM inference through an aggregator (OpenRouter/Fireworks). Customer never sees an API key.
- **Token ownership:** AgentDash owns the keys. We pay the COGS. We bill the customer usage-based with markup.
- **Who pays for tokens:** AgentDash pays the aggregator, customer pays AgentDash.
- **What AgentDash charges:** Usage-based billing (already built in `usage-billing.ts`). Bill = max(provider COGS, token-priced floor) × markup (default 1.5x). Reports to Stripe Billing Meters API.
- **Current status:** Code-complete (G1-G5 shipped). Blocked on provisioning an OpenRouter/Fireworks key and a Stripe Billing Meter.

### Why this matters for pricing

**Seat-based pricing is wrong for this product.** Here's why:

1. **"Seats" don't map to anything natural.** In a traditional SaaS, a seat = a human login. In AgentDash, the value-creating units are **agents**, and a single human can command dozens of them. Charging per human seat underprices heavy users and overprices light ones.

2. **Token consumption is the real cost driver.** An agent doing code review for 8 hours burns 10-100x more tokens than an agent that wakes up once a day to check a dashboard. Seat pricing can't capture this.

3. **On-prem customers bring their own tokens.** They don't need us to meter anything — they already have a billing relationship with Anthropic/OpenAI. What they need is the software license and support.

---

## 2. Pricing: BYOT + Usage-Based Cloud

### On-Prem License (BYOT)

| Tier | Price | Includes |
|------|-------|----------|
| **Community** | Free | Full software, local_trusted mode, community support |
| **Pro License** | $99/mo per installation | Software license, authenticated mode, email support, priority bug fixes |
| **Enterprise** | $499/mo per installation | License, SSO, SLA, phone support, custom adapters |

The customer pays their LLM provider directly. AgentDash adds zero token markup. The `cost_events` table still tracks usage so the customer can see their spend — but the bill goes to them, not us.

### Cloud (Managed Inference at agentdash.cloud)

| Tier | Price | Token model |
|------|-------|-------------|
| **Free** | $0 | Included monthly token budget (e.g. 500K tokens). 1 human, CoS agent only. |
| **Pay-as-you-go** | $0 base + usage | Customer pays for actual token consumption with 1.5x markup over COGS. Billed via Stripe Billing Meters. No minimum. |
| **Pro Cloud** | $49/mo + usage | Includes 5M tokens/mo, then pay-as-you-go overage at 1.5x. Multiple humans + agents. Priority support. |

**Why this works:**
- Light users (trying it out, small companies) pay nothing or near-nothing
- Heavy users (dev agencies, content factories) pay proportionally to the value they extract
- We never lose money on token costs — the 1.5x markup covers aggregator fees + margin
- On-prem customers who want to self-host can — they just bring their own keys

### What customers need to understand about token consumption

When a customer signs up for AgentDash (either SKU), here's what they're paying for under the hood:

**On-Prem (BYOT):**
- Customer needs an API key from their chosen provider (Anthropic, OpenAI, Z.AI/GLM, MiniMax, etc.)
- For `hermes_local` adapter: the hermes CLI manages its own provider config — the customer runs `hermes setup` or configures `~/.hermes/` with their keys
- For `claude_api` CoS dispatch: customer sets `ANTHROPIC_API_KEY` in their AgentDash `.env`
- For `openai_compat` dispatch: customer sets `OPENAI_COMPAT_API_KEY` pointing at OpenRouter/Fireworks/their provider
- AgentDash tracks token usage in `cost_events` for visibility, but the actual billing is between customer and provider
- **OpenAI OAuth:** Not directly applicable. AgentDash uses server-side API keys, not OAuth. If a customer has ChatGPT Plus, that doesn't help — they need an OpenAI API key (separate billing). Claude Pro/Max subscription similarly doesn't transfer — they need an Anthropic API key. Subscription plans are individual-use per ToS; they can't back a multi-tenant deployment.
- **Anthropic specifically:** Charges per API call based on input/output tokens. No flat-rate option for API access. Pricing is public (Claude Sonnet ~$3/M input, $15/M output). The customer sets a monthly budget in AgentDash and gets hard-stop enforcement when it's hit.

**Cloud (agentdash.cloud):**
- Customer sees one bill from AgentDash. No API key management.
- Token usage is metered per call and aggregated monthly.
- The dashboard shows real-time spend against budget.

**The customer conversation:**
> "Bring your own tokens" means: if you self-host, you plug in your own API key and pay your provider directly. If you use our cloud, we handle the keys and bill you for usage. Either way, you only pay for what your agents actually consume.

### Competitive Positioning

We're not competing with Linear or Jira (task management). We're not competing with Slack (chat). We're the **operating system for AI companies** — the control plane that makes a fleet of agents governable, visible, and accountable.

The closest analogs:
- **CrewAI / AutoGen** — agent frameworks, not control planes. No governance, no budget, no board UI.
- **Devin / Factory** — single-agent coding tools. Not multi-agent, not company-scoped.
- **OpenAI Swarm** — orchestration library. No product surface, no billing, no governance.

**Our moat:** Dogfooding. We run AgentDash using AgentDash. Every bug Jill hits is a ticket we fix in minutes. The product improves from real usage faster than any competitor can build from scratch.

---

## 3. Go-To-Market: 10 Companies by September 30

### Phase 1: Foundation (Week of July 28)

| Task | Owner | Outcome |
|------|-------|---------|
| Get PR #452 merged (resolve CI audit) | Aria | Clean main branch |
| Deploy to cloud (Railway/Fly) | Aria | Public URL with HTTPS |
| Provision Stripe (product, price, webhook) | Aria + Eddy | Working checkout + trial |
| Set LLM keys (ANTHROPIC_API_KEY or hermes_local) | Aria | Real CoS replies |
| Configure email (Resend) | Aria | Welcome + password reset |
| Run cloud preflight | Aria | Safety verified |

### Phase 2: First Customer (Week of Aug 4)

| Task | Owner | Outcome |
|------|-------|---------|
| Jill upgrades Yarda to cloud instance | Jill + Aria | First real customer |
| Fix any bugs Jill encounters | Aria | < 24h response time |
| Document onboarding flow | Growth agent | Public docs at agentdash.app/docs |
| Write case study: "How Yarda runs on AgentDash" | Growth agent | Marketing content |

### Phase 3: Design Partners (Weeks of Aug 11-25)

| Task | Owner | Outcome |
|------|-------|---------|
| Recruit 3 design partners from AI founder communities | Growth agent | 3 beta companies |
| Product Hunt launch prep (tagline, gallery, maker comment) | Growth agent | PH campaign ready |
| Create company templates (dev agency, marketing agency, support team) | Devs agent | 3 starter templates |
| MSP partner flow (Mac mini deployment scripts) | Aria | Design partner script tested |

### Phase 4: Public Launch (Week of Sep 1)

| Task | Owner | Outcome |
|------|-------|---------|
| **Product Hunt launch** | Growth agent | Launch day traffic |
| Post-launch bug triage | Aria + Support agent | Stable within 48h |
| Onboarding optimization based on real data | Devs agent | < 5 min time-to-first-success |
| Recruit remaining partners to reach 10 | Growth agent | 10 companies total |

### Phase 5: Scale (Sep 8-30)

| Task | Owner | Outcome |
|------|-------|---------|
| Usage-based billing live (Cloud SKU) | Devs agent | Metered billing working |
| Performance optimization (p95 < 250ms) | QA agent | Production benchmarks |
| Company import/export (portability) | Devs agent | Users can migrate between instances |
| Collect and publish testimonials | Growth agent | 3+ customer quotes |

### Target Funnel

```
100 Product Hunt visitors → 20 signups → 5 create agents → 2 convert to Pro → $98-$196 MRR
```

Conservative: 2 Pro conversions from PH launch. By month 3: 10 companies × $49/seat × 3 avg seats = **$1,470 MRR**.

---

## 4. Product Roadmap (Post-Launch)

### Q3 2026 (Now → Sep 30): Ship and Prove

1. **Cloud launch** — Railway/Fly + Stripe + domain
2. **10 design partners** — real companies running real work
3. **Product Hunt** — public visibility
4. **Company templates** — 3 starter configurations (dev agency, content team, support desk)

### Q4 2026: Scale

1. **Usage-based billing** — pay per agent-run, not just per seat
2. **ClipHub** — public template marketplace (companies share their agent setups)
3. **Cloud agents** — AgentDash-hosted execution (no local CLI required)
4. **Slack-first workflow** — operate your AI company from Slack
5. **Mobile dashboard** — check on your agent fleet from phone

### Q1 2027: Enterprise

1. **SSO** (Google/Microsoft — code exists, just needs provisioning)
2. **RBAC** — fine-grained permissions beyond board/agent binary
3. **Audit compliance** — SOC2-ready activity logging
4. **On-premise deployment** — Enterprise self-hosted with support contract

---

## 5. Operating Model

### AgentDash Runs on AgentDash

We eat our own dog food. The AgentDash company inside our platform has:

| Agent | Role | Current Work |
|-------|------|-------------|
| **Aria** | CEO / Chief of Staff | Strategy, coordination, customer success |
| **Devs** | Lead Engineer | Bug fixes, feature work, CI/CD |
| **QA** | QA Engineer | Regression suite, E2E tests, perf benchmarks |
| **Growth** | Head of Growth | Product Hunt, docs, content, onboarding |
| **Support** | Customer Success | GitHub issues, user feedback, FAQ |

### Decision Matrix

| Decision | Made By | When |
|----------|---------|------|
| Pricing | Eddy (via Monica) | Before cloud launch |
| Feature priority | Aria | Weekly sprint planning |
| Code review | Aria (self-merge for now) | Per PR |
| Bug triage | Aria | < 30 min from GitHub issue |
| Customer escalation | Aria → Monica → Eddy | As needed |
| Launch timing | Eddy (via Monica) | Before Product Hunt |

### Key Metrics I Track

| Metric | Target | Current |
|--------|--------|---------|
| Open GitHub issues (P1/P2) | 0 | 1 (pre-existing) |
| Test pass rate | 100% | 100% (821/821) |
| Time from issue → fix | < 4 hours | ~2 hours (today) |
| Time-to-first-success (new user) | < 5 min | Unknown (needs measurement) |
| Companies onboarded | 10 by Sep 30 | 1 (Yarda) |
| MRR | $1,470 by Oct 1 | $0 |

---

## 6. What I Need From Eddy (via Monica)

1. **Pricing model confirmation** — On-prem license ($99/mo) + Cloud usage-based (1.5x markup)? Or different structure?
2. **OpenRouter or Fireworks API key** — For cloud inference (Cloud SKU). This is the key that lets agentdash.cloud make LLM calls.
3. **Stripe provisioning** — Product + price + webhook + Billing Meter for usage-based metering
4. **Domain** — agentdash.cloud DNS pointed at cloud host
5. **Cloud host** — Railway/Fly/Render, or confirmation to deploy on existing infra
6. **License keypair** — ed25519 keypair for signing on-prem licenses (`scripts/mint-license.mjs` is built)
7. **Product Hunt hunter** — someone with a follower base to hunt our launch

These are all operational decisions — zero code changes required. Once I have these, I can deploy in hours.

---

## 7. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Agent execution doesn't work in cloud (no local CLI) | High | Critical | Cloud SKU uses API adapters (claude_api, minimax, openai_compat) — already wired. Local agents need cloud-agent execution (Q4). |
| LLM costs exceed revenue at low seat counts | Medium | High | Usage-based billing (G4) meters every call. Pro tier includes generous base + overage. |
| Product Hunt launch flops | Medium | Medium | Pre-line up 3 design partners for social proof. Launch with case study. |
| Competitor ships similar product first | Low | High | We're 2,652 commits ahead. Moat is dogfooding velocity. |
| Jill's bugs scare away other customers | Medium | High | Fix-first policy: any P1 from a real customer is top priority. Already demonstrated 2-hour turnaround. |

---

## 8. The One-Sentence Pitch

> AgentDash lets anyone spin up an autonomous AI company in minutes — type a request to your Chief of Staff, it hires a team of AI agents, and your company runs itself.
