---
title: Creating a Company
summary: Create a company with the setup wizard — name, first agent, mandate, goal, first task, launch
---

A company holds everything else: agents, issues, projects, goals, budgets. See [Companies](/concepts/companies).

You create one with the setup wizard. Open it from **New company** (sidebar company menu), **Add company** (company rail) or **New Company** (Companies page). A brand-new account is sent to a company-creation page first.

Source: `ui/src/components/OnboardingWizard.tsx`.

## The wizard

Six steps: **Company**, **Agent**, **Mandate**, **Goal**, **Task**, **Launch**.

1. **Company.** **Company name**, plus two optional fields:
   - **Mission / goal** — becomes the company's top-level goal and its description.
   - **Workspace code** — if you were given a code, enter it; it switches on extra capabilities for this workspace. Otherwise leave it blank.
2. **Agent.** Your first agent is a **Chief of Staff** (role `chief_of_staff`). Give it a name, pick an adapter type and model, and press **Test now** to check the adapter can run on this machine. See [Adapters](/adapters/overview).
3. **Mandate.** Four short questions that shape what the agent may do on its own and what it must ask about first. See [Mandates, directives and the agent bundle](/concepts/mandates-directives-and-the-agent-bundle).
4. **Goal.** The goal the work traces back to. Specific beats vague: "Ship a landing page with a signup form by Friday" over "build a landing page".
5. **Task.** The first issue for the agent.
6. **Launch.**

The wizard hires the agent through the normal hire path and approves its own hire, so the agent starts active.

## After the wizard

- **Goals** are under **More → Goals** in the sidebar.
- **Budgets** are set on **Costs → Advanced → Budgets**, or on an agent's **Budget** tab. See [Costs and budgets](/guides/board-operator/costs-and-budgets).
- **More agents:** **Agents → New agent**, or let the Chief of Staff ask to hire. See [Managing agents](/guides/board-operator/managing-agents).
- **New hires need you?** **Company Settings → Hiring → Require your approval for new hires** (off by default). When on, every hire files a `hire_agent` approval.
- **People:** invite them from **Company Settings → Invites**. See [Onboard a steward](/guides/board-operator/onboard-a-steward).

The API equivalent is `POST /api/companies` — see [Companies](/api/companies).
