# Plan: AgentDash-MK Admin Capabilities — Configurable Admin Powers + Governed Bulk Updates

- **Date:** 2026-11-06
- **Status:** Proposed for the next release
- **Primary persona:** Titus (MKThink company owner/admin; stewards Casper)
- **Profile:** `agentdash_mk` — every new surface is server-gated via `requireProductProfile` / owner-admin authority checks; no `agentdash_mk` branches in `ui/src` (One-UX rule, `doc/plans/2026-09-30-one-ux.md`).

## Goal

Give company admins (Titus) a configurable, auditable package of new powers — headline: **governed bulk updating of connector records** (HubSpot contacts, companies, deals) — without weakening the existing invariants:

- Directives cannot grant capability (nothing in the authorization path may read `agent_directives`).
- Effective policy stays `owner ceiling ∩ steward request`; all writes are narrowing clamped.
- Every mutating admin action writes an activity-log entry.
- One-UX: the UI ships for every company; capability-that-varies is gated server-side, with "available on request" empty states.

## Non-goals

- No admin writes to directives during normal operation (steward-only; admin gets read + emergency break-glass below, which is TTL'd and reason-logged, not a standing right).
- No AgentDash-domain bulk editing (tasks/issues/agents) in this release.
- No new connector providers in this release; HubSpot is the first and only bulk target.
- Teams inbound auth stays off (tracked separately in `doc/api/agentdash-mk.md`).

## Feature list (focused release — 6 abilities)

### 1. Admin capability configuration (the meta-feature)

Company-level settings that make the rest of this release **configurable by the admin**. Owner/admin only.

New table `company_admin_capability_settings` (one row per company, typed columns, not freeform jsonb):

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `bulkOpsEnabled` | boolean | `false` | Master switch for capability 2 |
| `bulkMaxBatchSize` | integer | `250` | Hard cap on records per confirmed bulk op |
| `bulkRequireApprovalAbove` | integer | `0` | Records above this require an approval decision even when the agent policy says `none` (0 = defer entirely to per-agent policy) |
| `bulkAllowedObjectTypes` | string[] | `["contacts","companies"]` | Whitelist for bulk targets (deals off until explicitly enabled) |
| `breakGlassDirectiveTtlHours` | integer (1–72) | `24` | Lifetime of an admin emergency directive push |
| `breakGlassEnabled` | boolean | `false` | Master switch for capability 4's override path |

Routes:

- `GET /api/companies/:companyId/admin-capabilities` — owner/admin (others: 404 on MK profile)
- `PUT /api/companies/:companyId/admin-capabilities` — owner/admin, full-body replace, activity-logged, validation via a new zod validator in `packages/shared`

Files: `server/src/routes/admin-capabilities.ts`, `server/src/services/admin-capabilities.ts`, `packages/db/src/schema/company_admin_capability_settings.ts` (exported from `packages/db/src/schema/index.ts`), shared validator + type.

### 2. Governed bulk connector record updates

The headline. Admin-driven bulk mutation of external connector records flowing through the **same governed path agents use**, so data scopes, provider ceilings, destructive-action modes, and approvals apply.

Flow (mirrors the governed-write ergonomics that already exist per-agent):

1. `POST /api/companies/:companyId/bulk-connector-ops` — `{ provider: "hubspot", objectType, filter, changes, dryRun: true }` → returns a **preview**: matched count, sampled diffs (first N), and the enforcement estimate (`willRequireApproval`, `blockedByScope`).
2. `POST .../bulk-connector-ops/:opId/confirm` — requires `idempotencyKey` + the preview's `revision`; batch size capped by `bulkMaxBatchSize`.
3. Batched async execution (batches of ≤ cap), each batch an activity-log entry; `GET .../bulk-connector-ops/:opId` reports progress/success/failure counts; failures are per-record, non-fatal, reported in the result.

New tables: `connector_bulk_operations` (companyId, actorUserId, provider, objectType, filter/changes jsonb, status, counts) and `connector_bulk_operation_items` (opId, recordId, status, error). Approval gating reuses the existing approval service — when required, the confirmed op parks in `awaiting_approval` and executes on approval; `bulkRequireApprovalAbove` tightens (never loosens) the per-agent policy.

Enforcement points (reused, not new): `connectorService.resolveActingAs` for scope/provider; the destructive classifier for op class (`external_bulk_mutation` already exists in `packages/shared/src/agent-destructive-classifier.ts`); capability 4 supplies the runtime consumer for `destructiveActions`.

Files: `server/src/routes/bulk-connector-ops.ts`, `server/src/services/bulk-connector-ops.ts`, bulk methods in `server/src/services/hubspot-connector.ts` (batched on top of the existing read/write path), UI in `ui/src/pages/CompanySettings.tsx` as a "Bulk operations" panel with preview + confirm + history.

### 3. `destructiveActions` runtime enforcement (close the stored-but-unenforced gap)

`effectivePolicy.destructiveActions` is written, clamped, and stored today but has **no runtime consumer** (`doc/api/agentdash-mk.md`). This release wires it into `resolveActingAs`: a connector write classified destructive (`update`, `delete`, `external_bulk_mutation`, …) is checked against the mode — `approval_required` parks the decision in the approval flow; refusal is reported to the agent with the reason. Bulk ops inherit this gate (capability 2's `bulkRequireApprovalAbove` can only tighten it).

This is the agent-facing change of the release (agents start receiving structured block/approval reasons), so the prompt surfaces must be updated in the same PR (see Agent-facing impact).

### 4. Admin directive visibility + break-glass override

- **Read:** `GET /api/companies/:companyId/agents/:agentId/directives` extended so owner/admin can read active + history (today: steward-only). Attributed as admin *audit* access; activity-logged when `breakGlassEnabled` matters for framing, not for capability.
- **Emergency push (break-glass):** `PUT /api/companies/:companyId/agents/:agentId/directives/break-glass` — owner/admin only, requires `breakGlassEnabled`, a mandatory `reason`, `revision` (optimistic concurrency), and `idempotencyKey`. The pushed directive row is flagged `breakGlass: true` with `expiresAt = now + breakGlassDirectiveTtlHours`; expiry permanently supersedes it and the steward's prior active directive becomes active again (the append-only supersede model in `agent-directives.ts` already supports versioned rows — expiration is a read-time resolution + a scheduled/manual sweep writing the supersede row).

**Invariants preserved (load-bearing):**
- The break-glass write lives in the *directives* store only. Authorization still never reads `agent_directives`; a break-glass directive cannot widen `resolveActingAs` ceilings, budgets, providers, or scopes. Shape behaviour only.
- Steward is notified on every break-glass push (steward inbox entry + email notice, reusing `steward_email_notices`), and the override inbox pattern (mandatory reason, distinguishing steward action from override) is followed.

Files: `server/src/routes/agent-directives.ts` (admin read + break-glass route), `server/src/services/agent-directives.ts` (expiry resolution), `server/src/__tests__/agentdash-mk-harness-directives.test.ts` grows the "break-glass cannot widen resolveActingAs" case.

### 5. Consolidated admin audit console

Read-only UI (a CompanySettings tab) that answers "what have admins and stewards done lately": ceiling writes + clamps, steward-request writes, break-glass pushes and expiries, approval overrides, bulk-op history. Backed by the existing activity log + the new tables above; admin-gated server-side; renders as a plain One-UX page so every company gets the page shape with an empty state where capabilities are off.

### 6. Governance ceiling templates (admin-side bulk apply)

Admin-authors a named ceiling template (budget, providers, data scopes, minimum approval, destructive mode) in company settings and applies it to a selected set of agents in one action. Each agent's write goes through the **existing** per-agent ceiling path (`PUT .../governance/ceiling`) with its clamping and revision semantics intact — the batch is a loop, not a new write model. One agent's revision conflict does not abort the batch; per-agent results are returned. This gives Titus "bulk" on the control-plane side to complement record-side bulk.

## Agent-facing impact (both prompt surfaces, same PR)

This release adds new agent-observable behavior: structured destructive-action blocks and approval parking (feature 3), and directives that may arrive flagged as break-glass (feature 4). Per the agent-facing-feature convention, update **both** surfaces in the release PR:

- `server/src/onboarding-assets/default/AGENTS.md` — new `agentdash-mk-admin-capabilities` named block: how to interpret destructive-action blocks from `resolveActingAs`, that approval-parked connector sends must not be retried, and that break-glass directives are authoritative for behaviour but never authorization.
- `server/src/services/agent-creator-from-proposal.ts` — `renderAgents` prepends the same bundle, so new hires get it.

The `.github/workflows/agents-md-drift-check.yml` gate will demand this anyway (new routes + schema files). Adapter-neutral wording: HTTP endpoints and JSON field names only.

## Sequencing (suggested slice order)

1. **Slice 1** — capability 1 (settings table + routes + validators) and capability 5's skeleton. Foundation; everything else reads this config.
2. **Slice 2** — capability 3 (`destructiveActions` runtime enforcement) + prompt-surface updates.
3. **Slice 3** — capability 2 (bulk connector ops) — depends on 1 and 3.
4. **Slice 4** — capability 4 (admin directive read + break-glass) + remaining prompt-surface updates.
5. **Slice 5** — capability 6 (ceiling templates) + finish the audit console.

Each slice: `pnpm db:generate` when schema changes, `pnpm -r typecheck`, targeted `pnpm test` files; full `pnpm -r typecheck && pnpm test:run && pnpm build` before release PR.

## Verification plan

- Unit: capability settings validation + authority checks; ceiling-template per-agent clamp behavior; bulk op preview/confirm idempotency; destructive-action gate at `resolveActingAs`; break-glass expiry + cannot-widen-authorization test.
- Contract sync check: db schema exports, shared types/validators, route registration, `doc/api/agentdash-mk.md` endpoint table updated in the same PR.
- Manual (MK staging): Titus runs a 2-step dry-run bulk update on contacts, an approval-parked bulk, and a break-glass push that expires and restores the steward directive.

## Risks / open questions

- **Bulk blast radius:** largest new destructive surface in the product — mitigated by dry-run-first design, whitelisted object types defaulting to contacts+companies, batch caps, per-record failure isolation, and full activity logging. Open question: should `bulkRequireApprovalAbove` have a hard system maximum (e.g. 25) regardless of admin config?
- **Break-glass vs. steward intent:** a break-glass directive can contradict what the steward pushed. TTL + notification + restore-on-expiry is the mitigation; the plan deliberately does not let admins silently make directive changes permanent.
- **Template clamping surprises:** applying a template to agents with heterogeneous standing config triggers clamps — the per-agent result payload must surface what was clamped rather than only "done".
- **Release cut:** target the next stable release tag (`releases/v2026.MMDD.P.md`); slices 1–3 are the minimum for the headline feature to be meaningful.
