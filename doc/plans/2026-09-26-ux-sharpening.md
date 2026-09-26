# UX sharpening for 1.0: Ask, Watch, Approve, See results

2026-09-26 · Status: **decided 2026-09-26** (section 8). Punch-list items filed as GitHub issues with the `ux-sharpening` label. · Companion to `doc/plans/2026-09-24-mvl-1.0.md` and `docs/superpowers/specs/2026-09-23-assistant-mcp-design.md`.

**The founder's question:** "overall we need to make the app more sharp and easy to use. What does it actually unlock or accomplish for our users?"

**Short answer:** it unlocks a small software team getting real engineering work done in their own repo without hiring, managing, or babysitting. Today the product hides that behind an operator's control panel. This plan cuts the web app down to four verbs and one first-run path that ends in a real pull request.

**Method.** (1) A read-only walk of the local runner at `127.0.0.1:3199`, company Agent Runner, 27 screenshots in [`ux-audit-2026-09-26/`](ux-audit-2026-09-26/). Navigation only: nothing was created, approved, paused or submitted. The runner is on `ota/integration-mkthink` (v0.3.1, 73 commits behind `origin/main`), so where main differs, this says so. (2) A read of the first-run code on `origin/main` at `f6f2eccb0`. (3) An inventory of the sidebar, routes, settings and user-visible jargon in `ui/src`.

**Caveat.** The runner is a heavily used dogfood company, not a fresh box. First-run findings come from code, not from a live fresh-box walk; the M5 fresh-box Playwright run (CUJ-2) should re-check them.

---

## 1. The value proposition

### One line

> **Tell your assistant what you want built. A team of AI agents does the work in your repo, asks you only when a decision is yours, and tells you what shipped and what it cost.**

### What it unlocks

- **Engineering capacity without a hire.** A 2 to 15 person team gets agents that pick up issues and open pull requests in its own GitHub repo, on its own model key.
- **Delegation that doesn't need a manager.** You say what you want in one sentence, from your phone, through Muse or Grok. The agents plan, split and staff it themselves. You are asked only for decisions that are really yours: hires, spend, anything external.
- **A straight answer to "what did I get for my money?"** Every issue ends as a pull request or a written result, with its cost next to it.

### Where it appears in the product

| Place | What it says |
|---|---|
| `www.agentdash.cloud/start` and `/pricing` (`ui/src/pages/PricingPage.tsx`) | The one line, then the three bullets |
| Sign-up (`ui/src/pages/Auth.tsx:139-144`) | "Get an AI engineering team that works in your repo." Replaces "Create your workspace" and the "Email confirmation is not required in v1" line |
| First-run header on `/cos` | "Tell me what you want built. I'll staff it and ask you only when it's your call." |
| Home when empty | The three verbs as three cards: Ask, Decide, Shipped (section 3) |
| Assistant consent (`ui/src/pages/OAuthConsent.tsx`) | "Muse can ask your agents for work, tell you what shipped, and bring you their decisions." |
| The weekly `whats_new` answer in the assistant | "This week: 4 pull requests, 2 decisions, $31 of model spend." |

---

## 2. What a user meets today

### Navigation and concepts (inventory)

- **Sidebar:** 15 static links (New Issue, Dashboard, Guides, Inbox, Issues, Routines, Goals, Org, Skills, Costs, Evaluation, Billing, Activity, Settings, plus Workspaces behind a flag and My Agent/Override on the MK profile), then every project and every agent listed by name, plus a left rail of company avatars (`ui/src/components/Sidebar.tsx:90-145`, `SidebarProjects.tsx`, `SidebarAgents.tsx`). Screenshot [01](ux-audit-2026-09-26/01-dashboard.jpg) shows 13 companies in the rail and 23 clickable items in the sidebar.
- **Settings:** a separate sidebar with 5 company pages (General, Environments, Access, Invites, Health; `CompanySettingsSidebar.tsx:56-71`) and 9 instance pages (Profile, General, Access, Heartbeats, Experimental, Plugins, Adapters, About, Changelog; `InstanceSidebar.tsx:30-38`). Company General alone offers "Generate OpenClaw Invite Prompt", "Require board approval for new hires", attachment size limits and a danger zone ([11](ux-audit-2026-09-26/11-company-settings.jpg)).
- **Routes:** 185 `<Route>` elements, 88 distinct page components (`ui/src/App.tsx`).
- **Entity types a user can land on:** company, agent, issue, sub-issue, project, project workspace, execution workspace, goal, routine, approval, run, cost event, budget, skill, plugin, mandate, steward, evaluation milestone, invite, join request, guide. That is 21. The four verbs need five: issue, agent, decision (approval), result (PR / work product), cost.

### Jargon a new user meets (user-visible)

| Term | Where it shows | 1.0 verdict |
|---|---|---|
| heartbeat | "Run Heartbeat" button on every agent (`AgentDetail.tsx:1030`, [04](ux-audit-2026-09-26/04-agent-detail-maya.jpg)); Heartbeats settings page | Rename "Wake now", move to the agent's overflow menu; hide the settings page |
| adapter | New Agent form, 9 adapter choices (`adapter-display-registry.ts:58-108`, [23](ux-audit-2026-09-26/23-new-agent.jpg)) | Hide on hosted boxes: Hermes is the only runtime |
| preflight / harness | "Harness preflight required" (`AgentHarnessReadinessPanel.tsx:93`) | Rename "Check setup"; show only on failure |
| instructions bundle | Agent Instructions tab (`AgentDetail.tsx:2408-2501`) | Advanced |
| steward, stewardship, "Needs a steward" | Agent list badges ([03](ux-audit-2026-09-26/03-agents-list.jpg)); member welcome links to "Getting started as a steward" on every profile (`MemberOnboarding.tsx:69-74`) | Hide on the default profile (MK only) |
| mandate | Agent Mandates tab; onboarding wizard step ([24](ux-audit-2026-09-26/24-onboarding.jpg)) | Advanced |
| routine | Top-level sidebar item | Advanced |
| goal | Top-level sidebar item | Advanced (projects cover it) |
| evaluator / evaluation | Sidebar item; page of "withheld, coverage 67%, synthetic human identities" cards ([17](ux-audit-2026-09-26/17-evaluation.jpg)) | Hide behind a flag: our dogfood tool |
| run | Live runs grid ([02](ux-audit-2026-09-26/02-dashboard-live.jpg)), 275-run counters | Keep inside an agent or issue, not as its own place |
| execution workspace, isolated checkouts | Project configuration (`ProjectProperties.tsx:916-994`) | Advanced |
| board | "good afternoon, board" (`Overview.tsx:898`); "board approval" in settings | Use the person's first name; say "your approval" |
| company | Every screen, for what the ICP calls a team or workspace | Say "workspace" in copy; keep the data model |
| CEO vs Chief of Staff | "Ask your Chief of Staff (CoS)" and a button "Ask the CEO to create a new agent" in one dialog (`NewAgentDialog.tsx:168`) | One name: Chief of Staff |
| Inference ledger, Finance ledger, Billers, debits/credits | Costs page ([08](ux-audit-2026-09-26/08-costs.jpg)) | One number per issue; ledgers to Advanced |

### Screen-level observations from the walk

1. **The dashboard contradicts itself** ([01](ux-audit-2026-09-26/01-dashboard.jpg)). The header says "6 agents · 92 open tasks"; the tiles below say **Agents 0** and **Open tasks 7** (15 seconds later, 0). The tiles run through a count-up animation (`useCountUp`, `Overview.tsx:760-761`) that did not reach its value in the audit tab, most likely because `requestAnimationFrame` stalls in a tab that is not in front, which is exactly how a person returns to a dashboard. Separately, "Awaiting you 0, all clear" sits beside an Inbox holding dozens of items addressed to "You" ([09](ux-audit-2026-09-26/09-inbox.jpg)), because `awaitingCount = pendingApprovals` (`:801`) ignores tasks assigned to the person. A user cannot trust the first screen.
2. **Nothing shows what shipped.** The server stores pull requests and outputs as work products (`services/work-products.ts`, `GET /issues/:id/work-products`), the UI has the client (`ui/src/api/issues.ts:238`), and **no page calls it.** "See results" has no screen at all. The closest is Maya's agent page: "275 runs, 96 failed, 137 succeeded without leaving anything" and a latest run reading "Wake complete. Summary:" with nothing after it ([04](ux-audit-2026-09-26/04-agent-detail-maya.jpg)).
3. **The inbox is noise.** "Mine" is 30+ rows of "Evaluator — immediate: E3 authority breach — AGE-112" ([09](ux-audit-2026-09-26/09-inbox.jpg), same in Issues [05](ux-audit-2026-09-26/05-issues.jpg)). Evaluator is off on hosted boxes, but the lesson holds: machine-generated items and real decisions share one list with no grouping.
4. **Approvals is an empty page with no explanation** ([07](ux-audit-2026-09-26/07-approvals.jpg)): "No pending approvals." No word on what would appear there or why.
5. **Live runs is mostly empty cards** ([02](ux-audit-2026-09-26/02-dashboard-live.jpg)): "Priya run c4f7ac0f succeeded", no issue title, no result.
6. **Hiring is an engineer's form** ([23](ux-audit-2026-09-26/23-new-agent.jpg)): adapter type, command, model, cheap model, thinking effort, Enable Chrome, Skip permissions, max turns 1000, "Agent instructions file /absolute/path/to/AGENTS.md", extra args, environment variables.
7. **Issue detail is strong for an engineer** ([06](ux-audit-2026-09-26/06-issue-detail.jpg)): sub-issue progress and "Next up" are exactly the Watch signal. But 26 related-task chips and a properties rail dominate, and there is no "result" block.
8. **Costs answers an accountant's question** ([08](ux-audit-2026-09-26/08-costs.jpg)): $4,594.25 of "inference spend", "168 tokens across request-scoped events", then four $0.00 finance tiles. It never says what that money bought.
9. **Billing** showed only "Loading…" during the walk ([19](ux-audit-2026-09-26/19-billing.jpg)); on main it prints the raw tier string ("Plan: free", `BillingPage.tsx:135`).
10. **The CoS screen is a blank page with an input** ([10](ux-audit-2026-09-26/10-cos.jpg)): no header line on what the Chief of Staff can do, no suggested first message.

---

## 3. The information architecture: four verbs

### Proposed sidebar (6 items, plus Settings)

**Scope:** the default profile, which is every hosted box. Companies on the `agentdash_mk` profile keep the current sidebar unchanged. The on-screen word stays **issues**.

| # | Item | Verb | What it holds | Replaces |
|---|---|---|---|---|
| 1 | **Home** | Watch | Three blocks, in this order: *Waiting on you* (decisions + tasks assigned to you, the same definition as the assistant's `list_pending_decisions`), *Working now* (each active issue: title, agent, last step, time), *Shipped this week* (PRs and results with cost). Honest counts. | Dashboard, Live runs, Activity |
| 2 | **Ask** | Ask | The Chief of Staff chat, with a "New issue" composer on top, and "Plan with your Chief of Staff" for the longer planning chat. One place to say what you want. | New Issue button, `/cos`, Company Chat tab |
| 3 | **Work** | Watch | Every issue, grouped by status, filterable by project and agent. Opens issue detail. | Issues, Projects list, Goals |
| 4 | **Decisions** | Approve | Pending approvals plus issues that need your answer, each with the agent's question, what happens on yes/no, and one button. Badge count. | Approvals, Inbox |
| 5 | **Shipped** | See results | Work products newest first: PR link and status, the issue it closes, agent, time, cost. Month total at the top. | Costs overview, nothing today for PRs |
| 6 | **Team** | Watch | Agents as cards: doing what, last shipped, spend this month, one "Hire" button that asks the Chief of Staff. | Agents list, Org |
| footer | **Settings** | | Workspace, Members and invites, Plan and billing, Connections (GitHub, assistant), Model key, **Advanced** | Company + instance settings, Billing |

The per-project and per-agent lists leave the sidebar (they belong in Work and Team). The company rail is hidden when the person belongs to one company, which is every hosted box.

### Where everything else goes

| Concept / page | 1.0 hosted, default profile |
|---|---|
| Dashboard, Live runs, Activity | **Merge into Home** |
| Issues, Projects, sub-issues | **Keep**, under Work |
| Approvals, Inbox (Mine/Recent/Unread) | **Keep**, as Decisions |
| Agents, agent detail | **Keep**, under Team; agent detail leads with doing / shipped / cost, config tabs move under one "Settings" tab |
| Costs | **Keep** the month total and per-issue cost in Shipped; Budgets, Providers, Billers, Finance tabs → **Advanced** |
| Billing, Invites, Guides | **Keep**, in Settings footer / Help |
| Routines, Goals, Org chart, Skills, Workspaces, Environments, Health, company import/export, Heartbeats, Plugins, Adapters, Experimental, Changelog | **Advanced** (Settings → Advanced, collapsed) |
| Evaluation, My Agent, Override, stewards, steward badges, mandates in onboarding, OpenClaw invite prompt, `/agents/new/studio`, design guide | **Hide behind a flag** (dogfood or `agentdash_mk` only) |
| Adapter picker, instructions bundle, "Test Agent" preflight gate | **Hide on hosted** (Hermes only); keep for self-hosted |

---

## 4. Time to value: signup to "an agent opened a PR in my repo"

### Today (hosted box, founder, from code)

| # | Screen | Choice / friction | Minutes |
|---|---|---|---|
| 1 | `/auth` sign-up | name, email, password | 1 |
| 2 | `/company-create` | workspace name | 0.5 |
| 3 | `/assess?onboarding=1` | **five-question readiness assessment**, mandatory in the chain (`CompanyCreate.tsx:39`, `AssessPage.tsx:190-244`) | 3 to 5 |
| 4 | `/cos` → provider step | provider, API key, optional model (`HermesProviderStep.tsx`) | 2 |
| 5 | CoS interview | adaptive questions, plan card, confirm | 8 to 12 |
| 6 | First hire | materialised from the plan; on Free the cap wall unless `AGENTDASH_FREE_AGENT_CAP=2` | 1 |
| 7 | **Find where to put the repo** | no prompt anywhere. Sidebar → Projects "+" → `NewProjectDialog` → "Repo URL" (`NewProjectDialog.tsx:283-327`) | 3 to 5, if found |
| 8 | **Give the repo credentials** | **no screen exists.** No GitHub App, OAuth or token field in UI or server | blocked |
| 9 | New issue, assign, wait | assign to the right agent in the project | 2 + agent time |

**Result today: about 9 screens and 20 to 30 minutes of the user's time, and then it stops.** An agent on a hosted box cannot push to a private repo, and cannot open a PR on a public one, without an operator placing git credentials on the box. Nothing after the CoS interview tells the user the next step is a repo.

### Proposed

| # | Screen | Minutes |
|---|---|---|
| 1 | Claim link → account (email prefilled from the waitlist) | 1 |
| 2 | "Your model": provider + key, one check request | 1.5 |
| 3 | "Your repo": paste a **fine-grained GitHub token** scoped to one repo (contents + pull requests read/write) and the repo URL; one check call. Creates the first project with the repo attached. The AgentDash GitHub App replaces the token before signup opens fully (~11-04) | 2 |
| 4 | "What should we build first?" One sentence becomes the first issue, with suggestions ("Add a /health badge to the README"). The Chief of Staff assigns it to one engineer (Free cap 2) | 1 |
| 5 | Home, *Working now* shows the issue live; a card offers "Connect Muse so you can do this from your phone" | 0.5 |

**Target: 5 screens, under 6 minutes of user time to first run, and a first PR about 20 to 30 minutes after signup** (agent time). The CoS interview and the 5-question assessment are optional: "Plan with your Chief of Staff" is offered from Home, and the assessment moves to Settings → Advanced.

### Empty states that say what to do next

| Screen | Empty-state text | One action |
|---|---|---|
| Home, no repo | "Connect a repo so your agents have somewhere to work." | Connect GitHub |
| Home, no issues | "Tell your team what to build. One sentence is enough." | Ask |
| Work | "No issues yet. Everything you or your assistant asks for shows up here." | Ask |
| Decisions | "Nothing needs you. Agents ask here before hiring, spending over your limit, or doing anything outside your repo." | none |
| Shipped | "Pull requests and results land here with what they cost. Your first one usually takes 20 to 30 minutes." | See what's running |
| Team | "Your Chief of Staff hires agents when an issue needs them. You can also ask for one." | Ask for a hire |
| Ask, first visit | Header line from section 1 plus three suggestion chips | send |

---

## 5. Top-15 punch list

Ranked by user impact against effort. S = up to 2 days, M = 3 to 7 days, L = over a week.

| Rank | Screen | Problem | Fix | Size | Files |
|---|---|---|---|---|---|
| 1 | First run / project | No way to give agents repo access on a hosted box; the core promise cannot complete | GitHub connection: a fine-grained token stored as a company secret, injected into the Hermes run environment for that project's workspace; one "Connect GitHub" step. The GitHub App follows as its own issue before open signup (~11-04) | L | `ui/src/components/NewProjectDialog.tsx:283-327`, new `ui/src/pages/settings/Connections.tsx`, `server/src/services/secrets.ts`, Hermes env build in `server/src/adapters/registry.ts`, `server/src/routes/onboarding-v2.ts` |
| 2 | Issue detail + new Shipped page | PRs and results are stored but never shown; "See results" has no screen | Render work products on issue detail (PR link, state, checks) and a company-wide Shipped feed with cost per issue | M | `ui/src/api/issues.ts:238` (client exists), `ui/src/pages/IssueDetail.tsx`, new `ui/src/pages/Shipped.tsx`, `server/src/services/work-products.ts`, `server/src/routes/issues.ts` |
| 3 | Dashboard → Home | Tiles show 0 while the header shows 6 agents and 92 tasks (stalled count-up animation); "awaiting you 0" beside a full inbox; "board" greeting | Render final numbers without the animation; Waiting on you / Working now / Shipped this week; first-name greeting; *Waiting on you* uses the same query as `list_pending_decisions` | M | `ui/src/pages/Overview.tsx:746-801,898-990`, `server/src/services/dashboard.ts`, `packages/mcp-server/src/assistant/tools.ts` |
| 4 | Sign-up chain | Mandatory 5-question assessment before the user sees anything | Route `/company-create` straight to setup; offer the assessment later under Advanced | S | `ui/src/pages/CompanyCreate.tsx:39`, `ui/src/pages/AssessPage.tsx:55-78`, `ui/src/lib/onboarding-route.ts` |
| 5 | First run | After the CoS interview nothing says "connect a repo" or "give a first task" | Replace the interview-first flow with key → repo → first issue (section 4); the CoS interview becomes an optional "Plan with your Chief of Staff" chat on Home | M | `ui/src/pages/CoSConversation.tsx:35-205`, `ui/src/components/onboarding/HermesProviderStep.tsx`, `server/src/routes/onboarding-v2.ts:357-706` |
| 6 | Sidebar | 23 items, 13-company rail, per-agent and per-project lists | Six items plus Settings (section 3); Advanced group collapsed; hide rail for single-company users | M | `ui/src/components/Sidebar.tsx:90-145`, `SidebarProjects.tsx`, `SidebarAgents.tsx`, `Layout.tsx:360-388`, `MobileBottomNav.tsx:45-55`, `ui/src/lib/company-routes.ts` |
| 7 | Inbox + Approvals → Decisions | Two lists, neither complete; real decisions buried among machine-made items; empty page with no explanation | One Decisions page: approvals + tasks needing your answer, each with question, consequence, one button; group or mute agent-generated noise | M | `ui/src/pages/Approvals.tsx`, `ui/src/pages/Inbox.tsx`, `ui/src/pages/ApprovalDetail.tsx`, `ui/src/components/ApprovalPayload.tsx` |
| 8 | Hire | 9 adapters and a CLI-flag form; "Ask the CEO" button in a CoS dialog | On hosted, hiring is "Ask your Chief of Staff" only; hide adapter grid and `/agents/new` behind Advanced; fix the CEO label | S | `ui/src/components/NewAgentDialog.tsx:73-177`, `ui/src/pages/NewAgent.tsx:61-435`, `ui/src/adapters/adapter-display-registry.ts` |
| 9 | Cap walls | "Upgrade to Pro" appears as plain error toast text; raw "Plan: free" | Upgrade button in the invite, hire and run-quota walls; humanised plan name and a trial countdown | S | `ui/src/pages/CompanyInvites.tsx:129-135`, `ui/src/pages/BillingPage.tsx:135`, `server/src/services/tier-policy.ts:52-65` |
| 10 | Everywhere | Operator jargon (section 2 table) | Copy pass: Wake now, Check setup, your approval, workspace, Chief of Staff; drop "v1" from sign-up; no steward link on the default profile | S | `AgentDetail.tsx:1030`, `AgentHarnessReadinessPanel.tsx:93`, `Auth.tsx:144`, `MemberOnboarding.tsx:69-74`, `CompanySettings.tsx` |
| 11 | All list pages | Empty states say nothing or point at the wrong next step | The empty states in section 4, one action each | S | `Overview.tsx:1014-1024`, `Approvals.tsx`, `Issues.tsx`, `Agents.tsx`, new Shipped page |
| 12 | Settings → Connections | Assistant connection is the product's main channel but has no obvious home or first-run nudge | Connections page with GitHub and "Connect Muse / Grok" (PR #688's card), a Home card after the first issue, the value line on consent | S | `ui/src/pages/OAuthConsent.tsx`, the #688 Connections card, `Overview.tsx` |
| 13 | Model key | Non-admins hit a dead end ("ask the person who set up the workspace"); no place to rotate the key | Name the admin and notify them; Settings → Model key to view provider and rotate | S | `ui/src/components/onboarding/HermesProviderStep.tsx:38-47`, `server/src/routes/hermes-provider-setup.ts` |
| 14 | Agent detail | Leads with run charts and 7 config tabs; "137 succeeded without leaving anything" is buried | Lead with doing now / last shipped / spend; one Settings tab for Instructions, Skills, Configuration, Budget, Mandates; surface "runs that leave nothing" as a health warning | M | `ui/src/pages/AgentDetail.tsx` |
| 15 | Costs | Ledgers and $0.00 tiles; no link from money to outcome | Month total, per-agent and per-issue cost, "cost per shipped PR"; Budgets/Providers/Billers/Finance tabs to Advanced | M | `ui/src/pages/Costs.tsx:660-941` |

Dependencies: 1 blocks the promise and the rest of first run (5). 2 feeds Home (3) and Costs (15). OBS-1 (#694 / PR #704) must land for any cost number on a Hermes box to be real; without it, items 2, 3 and 15 show $0.

**Suggested order:** 4, 8, 9, 10, 11 in one S batch (about a week, all copy and routing); then 2 and 3; then 1 and 5 together; then 6 and 7; 12 to 15 as capacity allows.

---

## 6. What the assistant covers, so the web can be simpler

The assistant MCP spec already assigns each verb a tool. If Muse is the front desk, the web app does not need to be a second full front desk.

| Verb | In Muse / Grok | What the web must still do |
|---|---|---|
| Ask | `start_project`, `create_work_item`, `assign_work`, `comment_on_work` (M3, #678) | Ask page for people at a desk; that is all |
| Watch | `find_work`, `get_project`, `get_work_item`, `explain_blocker` (M1, built) | Home and issue detail as **landing pages for the assistant's deep links**. Every link the assistant speaks must open a page that answers the question in its first screen |
| Approve | `list_pending_decisions`, `prepare_decision`, `confirm_action` (M4, #679) | Decisions page and approval detail for the cases that need reading (a diff, a hire's cost) |
| See results | `whats_new` (M1) | Shipped page with PR links and cost, the same numbers `whats_new` speaks |
| Setup | none by design | Claim, model key, GitHub connection, assistant consent, invites, plan. These stay web-only |

Consequences for the web app:

- The web is **setup, a glanceable Home, and good detail pages.** It does not need rich in-app notification, a heavy chat product, or bulk editing.
- **"Waiting on you" must be one definition** across Home, Decisions and `list_pending_decisions`, or the assistant and the web will disagree the way the dashboard and inbox disagree today.
- **Push** stays with the assistant (a morning "what's new"), as the MVL plan already accepts (CUJ-6).

---

## 7. What NOT to build for 1.0

- **No new notification or push system** (email digests, Slack, Teams, mobile push). The assistant is the channel.
- **No in-app code review or diff viewer.** Link to the PR on GitHub.
- **No customisable dashboards, saved views or kanban options.** The existing list/board toggles stay; no new ones.
- **No agent builder** for hosted users. `/agents/new/studio` and the adapter form stay self-hosted and Advanced.
- **No routines, goals or org-chart work.** They move to Advanced as they are.
- **No evaluator surface** on hosted boxes; it stays our dogfood tool behind a flag.
- **No multi-company UX.** One box, one workspace.
- **No second onboarding wizard.** Retire `OnboardingWizard.tsx` from the hosted path rather than polishing it ([24](ux-audit-2026-09-26/24-onboarding.jpg) still shows Company/Agent/Mandate/Goal/Task/Launch tabs and an MK "workspace code").
- **No theming, logo or brand-colour work** beyond what exists.
- **No MK-profile features** (stewards, bridge, directives, override inbox) on hosted boxes.
- **No renaming of data models or routes.** Change words on screen; `issues`, `companies`, `approvals` stay in code and API for upstream compatibility.

---

## 8. Decisions (founder, 2026-09-26)

1. **GitHub:** a fine-grained token pasted in onboarding for the first ~10 waitlist boxes. The AgentDash GitHub App is built before signup opens fully (~11-04), as a separate issue that is not on the 10-28 critical path.
2. **Sidebar:** the six items (Home, Ask, Work, Decisions, Shipped, Team), everything else under Advanced, **for the default profile and hosted boxes only.** The MK profile keeps its current layout.
3. **First run:** claim → model key → connect GitHub → first issue → Home. The CoS interview and the 5-question assessment become optional; "Plan with your Chief of Staff" is available from Home.
4. **Naming:** keep **"issues"** in the UI. "Request" is not adopted; the Work page lists issues and Ask's composer says "New issue".
5. The top-15 punch list and the GitHub App are filed as GitHub issues (labels `ui`, `ux-sharpening`, `mvl-1.0` except the App), with owners and dependencies in each issue.

## Screenshots

All in [`ux-audit-2026-09-26/`](ux-audit-2026-09-26/): 01 dashboard, 02 live runs, 03 agents, 04 agent detail, 05 issues, 06 issue detail, 07 approvals, 08 costs, 09 inbox, 10 CoS, 11 company settings, 12 guides (not on the runner build), 13 projects, 14 routines, 15 goals, 16 activity, 17 evaluation, 18 org, 19 billing, 20 my agent, 21 skills, 23 new agent, 24 onboarding wizard, 25 invites, 26 environments, 27 MCP page, 28 pricing.
