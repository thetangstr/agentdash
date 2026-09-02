# Stewardship Mode — Steward vs Autonomous companies

**Date:** 2026-09-01 · **Status:** Draft (PM elaboration complete; Linear issue pending — Linear MCP was unreachable when this was written) · **Size:** XL · **Depends on:** AGE-2 steward cards (`feat/age-2-steward-cards`) landing first, since the mode must gate the chips/column/group option that branch adds.

## 1. Problem and decision record

Every steward surface is on for every company. A company that simply wants agents that run on their own — no human↔agent pairing — still gets pairing UI, "Needs a steward" badges, steward-routed escalations, and "your steward" wording in every agent prompt.

Decided 2026-09-01 with the founder:

| Decision | Choice | Why |
|---|---|---|
| Scope | Company-level mode, two values: `steward` (today's behavior) and `autonomous` | The workforce model is a company operating model, not a per-agent flag (per-agent `agents.autonomy` already exists and stays). |
| When chosen | At company creation, **and** toggleable at runtime by company admins | "We need to be able to turn it off or on." |
| Storage | `companies.stewardship_mode` enum column | Mirrors the proven `product_profile` pattern (server 404 guard + `selectedCompany` in UI, DB-enforced enum, admin-gated PATCH). Rejected `feature_flags` rows: PUT route only checks membership, not admin role, and has no creation-time semantics. Rejected instance-wide env: can't differ per company on a shared instance. |
| Default on deploy | Every existing company → `steward` | Zero behavior change for MKThink and everyone else. Autonomous is opt-in. |
| Data | **Non-destructive in both directions** | The mode only changes what is enforced and shown. It never deletes or rewrites `agent_stewardships`, `agents.autonomy`, or `accountable_user_id`. |

## 2. Semantics by mode

| Concern | Steward mode (unchanged) | Autonomous mode |
|---|---|---|
| `agent_stewardships` | Read + write via `/agent-stewardships*` | Frozen: rows kept, routes 404, no auto-pairing |
| Accountable human (`agent-accountability.ts`) | live steward → `accountable_user_id` → `created_by_user_id` → **first active admin (new fallback)** | `accountable_user_id` → dormant steward → `created_by_user_id` → first active admin |
| `minimumApproval: "steward"` | Steward/accountable decides; admin fallback only with no requesting agent | Accountable human **or any company admin** decides |
| Approval card delivery | Steward's paired channels | Accountable human's paired channels if any, else inbox only |
| Agent prompt text (4 surfaces + adapter directive block + MCP playbook/`whoami`) | "your steward" copy | Existing per-agent autonomous copy; no "steward" wording |
| Heartbeat steward-directive injection (`heartbeat.ts:5238-5255`) | On | Off |
| Steward-as-agent reply (`steward-agent-replier.ts`) | On | Off |
| Human channel pairing (`human-channels.ts`, `MyChannels.tsx`) | On | **Stays on** — it's per-human and still carries approval cards to the accountable person |
| Per-agent `agents.autonomy` / `agents_accountable_ck` | As today | Column untouched; company mode overrides it for behavior; preserved for flip-back |
| UI: My Agent, Override, `StewardshipAssignments`, `AgentKindBadge`, AgentDetail "Steward" row, `StewardRequestEditor` + governance `steward` option, mandate-editor steward bits, `QuestionsForYou`, issue steward chip/column/`groupBy: steward`/`__unstewarded` bucket | Shown | Hidden (server still enforces; hiding is presentation) |
| "Awaiting your review" badge | Shown | **Still shown** — it's about the review principal, not stewardship |
| Onboarding wizard | Auto-pairs owner to first agent (`OnboardingWizard.tsx:1010-1027`) | Mode question before first hire; Autonomous skips the pairing step |

## 3. Data model

```ts
// packages/shared/src/constants.ts
export const COMPANY_STEWARDSHIP_MODES = ["steward", "autonomous"] as const;
export type CompanyStewardshipMode = (typeof COMPANY_STEWARDSHIP_MODES)[number];

// packages/db/src/schema/companies.ts  (next to productProfile)
stewardshipMode: text("stewardship_mode")
  .$type<CompanyStewardshipMode>()
  .notNull()
  .default("steward"),
// + CHECK companies_stewardship_mode_ck: stewardship_mode in ('steward','autonomous')
```

- Migration: `pnpm db:generate` on **main's** migration line (this checkout is at 0121; main may be ahead — never hand-number). No backfill; the default covers existing rows.
- Validators: `createCompanySchema` / `updateCompanySchema` (`packages/shared/src/validators/company.ts`) gain `stewardshipMode: z.enum(COMPANY_STEWARDSHIP_MODES).optional()`.
- Wire: `Company.stewardshipMode` (`packages/shared/src/types/company.ts`).
- Auth: `POST /companies` and board-user `PATCH /companies/:id` accept it. The CEO-agent branch of PATCH (`routes/companies.ts:653+`, branding-only) must strip it — an agent may not change the company's operating model.
- Activity log on change: `company.stewardship_mode.changed` with `{ from, to }` and the acting user.

## 4. Data implications (answering "what happens to the data")

**Steward → Autonomous.** No writes. Pairings go dormant. Accountability resolves at read time through the assignment chain above. Steward-only routes 404 (same mechanism `requireProductProfile` already uses on 12 route files). Creator auto-pairing on first hire stops.

**Autonomous → Steward.** No writes. Dormant pairings are live again exactly as they were (`GET /me/agent`, history, channel bindings). Agents hired while autonomous have no pairing and show the existing "Needs a steward" state until an admin pairs them in Company Access.

**Pre-existing hole this closes.** Agents hired *by other agents* (`agent-creator-from-proposal.ts`, `routes/agents.ts:2572`) get `created_by_user_id: null`, no stewardship, `autonomy: 'stewarded'` — escalations reach nobody. Autonomous mode leans entirely on the resolver chain, so the resolver gains a last-resort **first active admin** fallback (the rule migration `0120_agent_autonomy.sql` already used for its backfill). Applies in both modes; reported as `via: "admin_fallback"` so UI can say "no one assigned — routed to an admin".

## 5. Gating pattern (single source of truth)

- Server: `requireStewardshipMode(company, "steward")` in `server/src/services/companies.ts`, beside `requireProductProfile`, throwing `notFound`. Plus `isStewardMode(company)` for branch-not-404 sites (resolver, approval authority, prompt rendering, heartbeat).
- UI: `ui/src/lib/stewardship-mode.ts` → `isStewardMode(company)`; `ui/src/hooks/useStewardshipMode.ts` reading `selectedCompany.stewardshipMode`. No component reads the column directly.
- Never gate on `productProfile` for this — the two are orthogonal (an `agentdash_mk` company could go autonomous; a `default` company could run stewards).

## 6. Acceptance criteria

- [ ] `POST /companies` accepts `stewardshipMode` (defaults `steward`); board-admin `PATCH /companies/:id` changes it and writes a `company.stewardship_mode.changed` activity entry; a CEO-agent PATCH carrying it is ignored/rejected.
- [ ] With the company in `autonomous`, every route under `/agent-stewardships`, `/companies/:id/me/agent`, `/agents/:id/stewardship*`, `/me/inbox`, `/inbox/override` returns 404, and `select count(*) from agent_stewardships` is identical before and after the flip.
- [ ] Hiring an agent in `autonomous` creates no stewardship row and does not auto-pair the creator; `GET /agents/:id` reports `accountable` = creator, or the first active admin (`via: "admin_fallback"`) when the creator is an agent or absent.
- [ ] Flipping `steward → autonomous → steward` returns `GET /me/agent` and `GET /agents/:id/stewardship/history` byte-identical to before; an agent hired while autonomous renders "Needs a steward".
- [ ] An approval with `minimumApproval: "steward"` in `autonomous` can be decided by the accountable human **and** by a company admin; card delivery targets the accountable human's channels.
- [ ] Instructions rendered for an `autonomous` company contain no "steward" wording across `default/AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`, `agent-creator-from-proposal.ts`, and the adapter directive block (`adapter-utils/server-utils.ts`); the drift check `.github/workflows/agents-md-drift-check.yml` passes; `whoami` returns `stewardshipMode`.
- [ ] UI in `autonomous`: no My Agent/Override nav, no stewardship panel in Company Access, no agent-kind badges, no steward chip/column/group option, `/my-agent` redirects to `/`; the awaiting-review badge still renders for the pending reviewer.
- [ ] Onboarding wizard asks the mode before the first hire; choosing Autonomous skips the owner pairing; Company Settings shows the toggle with a confirmation that lists what hides and how escalations route.
- [ ] After migration every existing company has `stewardship_mode = 'steward'` and the existing steward-mode test suites pass unchanged.

## 7. Affected areas

- **DB/shared:** `packages/db/src/schema/companies.ts`, new migration, `packages/shared/src/{constants.ts, types/company.ts, validators/company.ts}`
- **Server (gates):** `services/companies.ts` (guards), `routes/companies.ts` (create/patch + activity), `routes/agent-stewardships.ts`, `routes/agentdash-mk-inbox.ts`, `routes/agents.ts:2605-2640` (auto-pair), `services/agent-accountability.ts` (mode-aware chain + admin fallback), `services/approval-authority.ts`, `services/approval-card-delivery.ts`, `services/heartbeat.ts:5238-5255`, `services/steward-agent-replier.ts`, `services/agent-fact-requests.ts` (steward-answer path), `services/agent-governance.ts` (`steward_request` writes)
- **Prompt surfaces (all four + adapter, per `AGENTS.md`):** `server/src/onboarding-assets/{default,ceo,chief_of_staff}/AGENTS.md` (+ `HEARTBEAT.md`, `SOUL.md`), `services/agent-creator-from-proposal.ts`, `packages/adapter-utils/src/server-utils.ts:680-755`, `packages/mcp-server/src/{playbook.ts, tools.ts}`
- **UI:** `lib/stewardship-mode.ts` + `hooks/useStewardshipMode.ts` (new), `components/Sidebar.tsx`, `App.tsx` (route guards), `pages/CompanyAccess.tsx`, `components/access/StewardshipAssignments.tsx`, `components/AgentKindBadge.tsx`, `pages/AgentDetail.tsx`, `components/agent/{StewardRequestEditor,AgentGovernancePanel,AgentMandateEditor,QuestionsForYou}.tsx`, `components/{KanbanBoard,IssuesList,IssueColumns}.tsx`, `lib/inbox.ts` (steward column availability), `components/OnboardingWizard.tsx`, company settings page (toggle)
- **Tests:** mode-aware variants of `agent-autonomy`, `agent-stewardships`, `agent-create-stewardship`, `agentdash-mk-approval-authority`, `approval-card-delivery`, `agentdash-mk-harness-directives`, `agent-instruction-bundles`, `issues-service`; UI `IssuesList`, `Inbox`, `AgentKindBadge`, `StewardshipAssignments`, `MyAgent`, `OverrideInbox`; `mcp-server` `playbook`/`tools`

## 8. Sizing and deployment

- **XL (8 pts)** — migration, ~15 server files, ~18 UI files, 4+ prompt surfaces, ~15 test files. Per MAW: human verification required; **staging deployment recommended** (touches approvals and shared UI).
- Migration required. No new env vars. No breaking API (new optional field). Default `steward` ⇒ no behavior change on deploy.
- Ship order: AGE-2 (steward cards) → this issue.

## 9. Test focus areas

1. Flip round-trip is lossless (row counts, `GET /me/agent`, history) — automated.
2. Accountability chain in autonomous mode, including agent-hired-by-agent → admin fallback — automated.
3. Approval authority + card delivery in autonomous mode — automated.
4. Prompt surfaces contain no steward wording in autonomous mode; drift check passes — automated.
5. Chrome CUJ: create company → choose Autonomous → hire → confirm no steward UI anywhere; toggle back in settings → "Needs a steward" appears; pair; toggle again.

## 10. Out of scope

- Changing per-agent `agents.autonomy` semantics or the `agents_accountable_ck` invariant.
- Deleting, ending, or rewriting stewardship rows on toggle (explicitly forbidden).
- Touching `product_profile` / entitlement logic.
- Asking the mode inside the CoS interview (it's a wizard step); rewriting onboarding copy beyond that step.
- Hiding human channel pairing (stays available in both modes).

## 11. Builder notes / judgment calls

- `AgentKindBadge` hides entirely in autonomous mode (every agent is autonomous — nothing to distinguish) rather than showing "Autonomous" on all.
- Per-agent `autonomy` is **ignored, not rewritten**, in autonomous mode; `routes/agents.ts:3092-3120` (refuse turning a live-paired agent autonomous) stays as-is.
- Keep the `// AgentDash: agent-autonomy — DO NOT REMOVE OR REORDER` block in `agent-creator-from-proposal.ts` as the one place prompt wording branches; feed it `isStewardMode(company) ? agent.autonomy : "autonomous"`.
- Steward chip/column: gate availability in `getAvailableInboxIssueColumns` (so saved prefs still normalize) and skip the `includeAssigneeSteward` join server-side when the company is autonomous — no reason to pay for it.

## 12. PM → Builder handoff (attach to the Linear issue as `PM Handoff`)

```json
{
  "type": "pm_to_builder",
  "title": "Add company Stewardship Mode — Steward vs Autonomous, toggleable, non-destructive",
  "size": "XL",
  "labels": ["XL", "Feature"],
  "priority": 2,
  "depends_on": ["AGE-2"],
  "spec": "docs/superpowers/specs/2026-09-01-stewardship-mode-design.md",
  "acceptance_criteria": [
    "POST/PATCH company accepts stewardshipMode; admin-only; activity-logged; CEO-agent PATCH cannot change it",
    "Autonomous: stewardship/me-agent/inbox/override routes 404; agent_stewardships row count unchanged across flip",
    "Autonomous hire: no stewardship row, no auto-pair; accountable = creator or first active admin (via admin_fallback)",
    "steward->autonomous->steward round-trip restores /me/agent and history byte-identical; autonomous-era agents show Needs a steward",
    "minimumApproval=steward in autonomous: accountable human or any admin decides; cards go to accountable human",
    "Autonomous prompt surfaces (4 + adapter block) contain no steward wording; drift check passes; whoami reports stewardshipMode",
    "Autonomous UI hides My Agent/Override/stewardship panel/kind badges/steward chip+column+group; awaiting-review badge remains; /my-agent redirects",
    "Onboarding asks mode before first hire; Autonomous skips owner pairing; Company Settings toggle with confirmation",
    "Post-migration all existing companies are steward; steward-mode suites pass unchanged"
  ],
  "affected_areas": [
    "packages/db/src/schema/companies.ts", "packages/db/src/migrations/<generated>",
    "packages/shared/src/constants.ts", "packages/shared/src/types/company.ts", "packages/shared/src/validators/company.ts",
    "server/src/services/companies.ts", "server/src/routes/companies.ts", "server/src/routes/agent-stewardships.ts",
    "server/src/routes/agentdash-mk-inbox.ts", "server/src/routes/agents.ts", "server/src/services/agent-accountability.ts",
    "server/src/services/approval-authority.ts", "server/src/services/approval-card-delivery.ts", "server/src/services/heartbeat.ts",
    "server/src/services/steward-agent-replier.ts", "server/src/services/agent-fact-requests.ts", "server/src/services/agent-governance.ts",
    "server/src/onboarding-assets/*/AGENTS.md", "server/src/services/agent-creator-from-proposal.ts",
    "packages/adapter-utils/src/server-utils.ts", "packages/mcp-server/src/playbook.ts", "packages/mcp-server/src/tools.ts",
    "ui/src/lib/stewardship-mode.ts", "ui/src/hooks/useStewardshipMode.ts", "ui/src/components/Sidebar.tsx", "ui/src/App.tsx",
    "ui/src/pages/CompanyAccess.tsx", "ui/src/components/access/StewardshipAssignments.tsx", "ui/src/components/AgentKindBadge.tsx",
    "ui/src/pages/AgentDetail.tsx", "ui/src/components/agent/*", "ui/src/components/KanbanBoard.tsx", "ui/src/components/IssuesList.tsx",
    "ui/src/components/IssueColumns.tsx", "ui/src/lib/inbox.ts", "ui/src/components/OnboardingWizard.tsx"
  ],
  "deployment_notes": ["DB migration (companies.stewardship_mode, default steward)", "No env vars", "Not breaking", "Staging recommended (XL; approvals + shared UI)"],
  "test_focus": [
    "Flip round-trip lossless", "Accountability chain + admin fallback", "Approval authority/delivery in autonomous",
    "Prompt surfaces + drift check", "Chrome CUJ: create autonomous company -> hire -> toggle back -> pair"
  ],
  "out_of_scope": ["Per-agent autonomy semantics", "Deleting stewardship rows", "product_profile logic", "CoS-interview mode question", "Hiding channel pairing"]
}
```
