# AgentDash — MCP Signup Lead Capture (Minimal)

Date: 2026-07-26
Status: **Design only. Implementation deferred (back-burner).** Tracked as GitHub issues for pickup when ready.
Companion: `doc/plans/2026-06-28-launch-checklist.md` (item A3 — Resend), `doc/plans/2026-06-24-launch-and-runtime-independence-plan.md`.

## 1. Goal

Capture the first real customer's signup as a **lead record on the agentdash.cloud control plane** — automatically, at signup. This is intentionally the minimum: it records that "a customer exists and who they are." Everything downstream of raw capture is out of scope (see §6).

The trigger the user cares about: a customer installs AgentDash, runs the MCP onboarding prompt we give them, signs up, and we want that signup logged as a customer for us — so the lead can later be turned into a paid customer.

## 2. Context (verified 2026-07-26)

- **Same repo, two deploys, separate DBs.** `www.agentdash.cloud` runs this codebase as a second deployment (the control plane). The product instance is the customer's deploy. (Confirmed with user.)
- **A phone-home channel already exists.** The customer instance phones home to `www.agentdash.cloud/api/invites/validate` for invite-gate authorization (#458). We reuse that pattern (env-configured base URL + bearer token).
- **First sign-in does NOT depend on email.** better-auth is `emailAndPassword.enabled` with `requireEmailVerification: false` (`server/src/auth/better-auth.ts:139-141`). A user sets a password at signup and is authenticated immediately. Email (Resend) and Stripe are both OFF in prod; this design depends on **neither**.
- **The capture seam already exists.** `databaseHooks.user.create.after` (`server/src/auth/better-auth.ts:165-201`) fires at every successful signup with `{id, email, name}` and already runs two best-effort steps (workspace bootstrap, welcome email) inside try/catch. We add a third best-effort step there.
- **The MCP `agentdashBootstrapWorkspace` tool operates "for the authenticated user"** (`packages/mcp-server/src/tools.ts:635-640` → `POST /onboarding/bootstrap`, which requires a board actor — `server/src/routes/onboarding-v2.ts:209-212`). I.e., signup (which creates the account **and** auto-bootstraps the workspace via the hook) happens *before* any MCP onboarding step. So capturing at the `onUserCreated` hook captures every MCP-driven signup.

## 3. Design

### 3.1 Identity

A lead = **one customer install**, keyed by `instanceId` (`resolvePaperclipInstanceId()`, already used by better-auth cookie scoping). Multiple humans on one install collapse to one lead (the install *is* the customer). The first signup contributes `email`, `name`, and (later) `companyName`.

### 3.2 Data model — `packages/db/src/schema/leads.ts` (new)

Re-exported from `packages/db/src/schema/index.ts` — the `check-architecture` rule `schema-export` (error-level) will fail CI otherwise.

```
leads
  id            uuid pk default_random
  instance_id   text  not null unique        -- resolvePaperclipInstanceId()
  invite_code   text  nullable               -- from the invite-gate phone-home payload, if present
  email         text  nullable               -- first signup's email
  name          text  nullable
  company_name  text  nullable               -- see §7 open question; null in minimal scope
  status        text  not null default 'captured'
  source        text  nullable               -- e.g. "mcp-onboarding"
  metadata      jsonb not null default '{}'
  created_at    timestamptz not null default now
  last_seen_at  timestamptz not null default now
  -- unique index on instance_id; index on created_at for listing
```

No `lead_events` log in minimal scope — that arrives with the back-burner lifecycle-event work.

### 3.3 Capture client — `server/src/services/lead-capture-client.ts` (new)

```ts
captureSignup(input: { instanceId; inviteCode?; email; name? }): Promise<void>
```

- Reads `AGENTDASH_CONTROL_PLANE_URL` + `AGENTDASH_CONTROL_PLANE_TOKEN`.
- `POST {baseUrl}/api/leads` with bearer token + JSON body.
- **Fire-and-forget:** the entire body is wrapped in try/catch; failures are `logger.warn`'d. It **never throws to the caller** — signup latency and success are unaffected if agentdash.cloud is unreachable.
- **No-op when env unset** (returns immediately) so product deploys that aren't wired don't emit, and so local/dev never phones home.

### 3.4 Endpoint — `POST /api/leads` (on the agentdash.cloud deploy)

- Bearer auth against `AGENTDASH_CONTROL_PLANE_TOKEN` (constant-time compare). 401 on mismatch.
- Zod-validated body (`instanceId` required; `email`/`name`/`inviteCode`/`companyName`/`source` optional, length-capped).
- **Idempotent upsert** on `instance_id` (`INSERT … ON CONFLICT (instance_id) DO UPDATE SET email=excluded.email, name=…, last_seen_at=now()`). 201 on insert, 200 on update.
- Rate-limited (reuse the existing limiter pattern). 422 on invalid payload.

### 3.5 Wiring — `server/src/auth/better-auth.ts`

Inside the existing `databaseHooks.user.create.after` hook, after the workspace-bootstrap `try/catch` and the welcome-email `try/catch`, add a third independent best-effort block:

```ts
try { await captureSignup({ instanceId: resolvePaperclipInstanceId(), email: user.email, name: user.name, source: "mcp-onboarding" }); }
catch (err) { logger.warn({ userId: user.id, err }, "[lead] captureSignup failed — signup unaffected"); }
```

Same discipline as the two existing blocks: a failure leaves the user without a captured lead but does **not** abort the user-create transaction.

### 3.6 Optional — `GET /api/admin/leads` (operator-only)

Paginated list, newest first, operator-auth'd (reuse the existing operator/admin auth gate). Lets the founder see captures without hitting the DB. Defer if not worth it for a single customer.

## 4. Data flow (signup)

```
user signs up (email + password)
  → better-auth commits user row
  → onUserCreated hook fires
      → [1] workspace + CoS bootstrapped (existing)
      → [2] welcome email (existing; no-op while Resend unset)
      → [3] captureSignup() POSTs {instanceId, email, name} → agentdash.cloud  (NEW)
              → POST /api/leads validates token + payload
              → upsert lead row (status: captured), 200/201
  → signup returns; user is authenticated
```

Client failures are logged and dropped — never block or retry-block the signup path.

## 5. Config to add (at implement time)

- **Product instance deploy:** `AGENTDASH_CONTROL_PLANE_URL` (e.g. `https://www.agentdash.cloud`), `AGENTDASH_CONTROL_PLANE_TOKEN`.
- **Control-plane deploy (agentdash.cloud):** verify the same `AGENTDASH_CONTROL_PLANE_TOKEN` server-side.

## 6. Out of scope (back-burner — separate epic)

Captured here so nothing is lost; each becomes its own issue when prioritized:

- **Lifecycle event stream** — typed events `installed → signed_up → onboarded → activated → trial → paid`, an append-only `lead_events` log, and a pure `(status, event) => status` reducer. Replaces the single upsert with an event-sourced funnel.
- **Funnel dashboard** — counts/conversion by stage, visible on agentdash.cloud.
- **Outreach** — transactional emails on status transitions. Blocked on the Resend fix (launch-checklist A3), which also unblocks password-reset.
- **Paid flip** — `trial`/`paid` events; depends on Stripe wiring (launch-checklist A2).
- **CRM-ish fields** — owner, notes, follow-ups (the surface v2 explicitly dropped; revisit only if needed).

## 7. Testing (when built)

- **Unit:** `captureSignup` no-ops with env unset; never throws on fetch failure (mocked).
- **Integration:** `POST /api/leads` creates on first call, upserts on repeat (id idempotent), 401 on bad token, 422 on bad payload.
- **Architecture gate:** `pnpm check:architecture` passes — i.e. `leads` is re-exported from `schema/index.ts`.

## 8. Open question

`companyName` is not available at `onUserCreated` time (the company is created by the bootstrap step that runs inside the same hook). For minimal scope we capture `email`/`name` only and leave `company_name` null; it gets filled when the back-burner `onboarded` event (fired after workspace bootstrap completes) is implemented.
