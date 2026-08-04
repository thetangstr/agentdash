# AgentDash-MK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete `agentdash_mk` company profile with one-to-one human-agent stewardship, owner policy ceilings, steward-scoped web and IM approvals, Telegram-first messaging, Microsoft Teams messaging, and complete issue-based collaboration provenance.

**Architecture:** Add the profile and workforce governance as company-scoped platform domains, then layer web and provider adapters over shared authorization, approval, binding, idempotency, and audit services. Existing AgentDash companies remain on the `default` profile. Telegram and Teams share normalized human-channel infrastructure but retain provider-specific authentication and rendering.

**Tech Stack:** TypeScript, Express 5, React 19, Drizzle/PostgreSQL, Zod, Vitest, Playwright, Telegram Bot API, `@microsoft/teams.apps`, Adaptive Cards.

**Design:** `docs/superpowers/specs/2026-07-28-agentdash-mk-design.md`

---

## File structure

### Shared and database

- Modify `packages/shared/src/constants.ts` for product profiles, governance enums, channel providers, and activity actions.
- Modify `packages/shared/src/types/company.ts` and `packages/shared/src/validators/company.ts` for `productProfile`.
- Create `packages/shared/src/types/agent-stewardship.ts` and `packages/shared/src/validators/agent-stewardship.ts`.
- Create `packages/shared/src/types/agent-governance.ts` and `packages/shared/src/validators/agent-governance.ts`.
- Create `packages/shared/src/types/human-channel.ts` and `packages/shared/src/validators/human-channel.ts`.
- Modify `packages/shared/src/index.ts` to export every new contract.
- Modify `packages/db/src/schema/companies.ts` for `product_profile`.
- Create `packages/db/src/schema/agent_stewardships.ts`.
- Create `packages/db/src/schema/agent_governance_policies.ts`.
- Modify `packages/db/src/schema/approvals.ts` for revision/channel/override/idempotency fields.
- Create `packages/db/src/schema/human_channel_bindings.ts`.
- Create `packages/db/src/schema/external_channel_events.ts`.
- Modify `packages/db/src/schema/index.ts` and generate a Drizzle migration.

### Server

- Create `server/src/services/product-profiles.ts`.
- Create `server/src/services/agent-stewardships.ts`.
- Create `server/src/services/agent-governance.ts`.
- Create `server/src/services/approval-authority.ts`.
- Create `server/src/services/human-channels.ts`.
- Create `server/src/services/telegram-connector.ts`.
- Create `server/src/services/teams-connector.ts`.
- Create `server/src/routes/agent-stewardships.ts`.
- Create `server/src/routes/agent-governance.ts`.
- Create `server/src/routes/human-channels.ts`.
- Create `server/src/routes/telegram-connector.ts`.
- Create `server/src/routes/teams-connector.ts`.
- Modify `server/src/services/approvals.ts` and `server/src/routes/approvals.ts`.
- Modify `server/src/services/access.ts` for offboarding stewardship.
- Modify `server/src/services/issues.ts` and `server/src/routes/issues.ts` for complete child contributions.
- Modify `server/src/app.ts`, `server/src/routes/index.ts`, and `server/src/services/index.ts`.
- Modify `server/package.json` to add the current Teams SDK; do not commit `pnpm-lock.yaml`. [Superseded 2026-08-03: the lockfile is now tracked; CI owns it via the refresh-lockfile bot — see DEVELOPING.md.]

### UI

- Create `ui/src/api/stewardships.ts`, `ui/src/api/agent-governance.ts`, and `ui/src/api/human-channels.ts`.
- Create `ui/src/pages/MyAgent.tsx`.
- Create `ui/src/components/agent/AgentGovernancePanel.tsx`.
- Create `ui/src/components/access/StewardshipAssignments.tsx`.
- Create `ui/src/components/settings/HumanChannelBindings.tsx`.
- Modify `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/pages/Inbox.tsx`, `ui/src/pages/ApprovalDetail.tsx`, `ui/src/pages/CompanyAccess.tsx`, `ui/src/pages/CompanySettings.tsx`, and `ui/src/lib/queryKeys.ts`.

### Prompts, docs, and E2E

- Modify all four mandatory prompt surfaces named in `AGENTS.md`.
- Modify `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, `.env.example`, and API documentation.
- Create `tests/e2e/agentdash-mk-workforce.spec.ts`.

---

### Task 1: Product-profile contract

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types/company.ts`
- Modify: `packages/shared/src/validators/company.ts`
- Modify: `packages/db/src/schema/companies.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `server/src/services/companies.ts`
- Test: `server/src/__tests__/agentdash-mk-profile.test.ts`

- [ ] **Step 1: Write the failing profile tests**

```ts
it("defaults existing/new companies to the default profile", async () => {
  const company = await companies.create({ name: "Standard" });
  expect(company.productProfile).toBe("default");
});

it("allows an owner to create an AgentDash-MK company", async () => {
  const company = await companies.create({
    name: "MK",
    productProfile: "agentdash_mk",
  });
  expect(company.productProfile).toBe("agentdash_mk");
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```sh
pnpm exec vitest run server/src/__tests__/agentdash-mk-profile.test.ts
```

Expected: fail because `productProfile` is absent from the schema and company contract.

- [ ] **Step 3: Add the profile contract**

```ts
export const COMPANY_PRODUCT_PROFILES = ["default", "agentdash_mk"] as const;
export type CompanyProductProfile = (typeof COMPANY_PRODUCT_PROFILES)[number];
```

```ts
productProfile: text("product_profile").notNull().default("default"),
```

Extend company create/update validators and types with
`z.enum(COMPANY_PRODUCT_PROFILES)`. Add a `requireProductProfile(company,
"agentdash_mk")` helper that throws `404` for unavailable profile-only routes.

- [ ] **Step 4: Run GREEN and regression tests**

```sh
pnpm exec vitest run server/src/__tests__/agentdash-mk-profile.test.ts
pnpm exec vitest run server/src/__tests__/company-routes.test.ts
```

Expected: both pass.

- [ ] **Step 5: Commit**

```sh
git add packages/shared packages/db/src/schema/companies.ts server/src/services/companies.ts server/src/__tests__/agentdash-mk-profile.test.ts
git commit -m "Make AgentDash-MK an explicit company profile"
```

### Task 2: Stewardship history and atomic transfer

**Files:**
- Create: `packages/db/src/schema/agent_stewardships.ts`
- Create: `packages/shared/src/types/agent-stewardship.ts`
- Create: `packages/shared/src/validators/agent-stewardship.ts`
- Create: `server/src/services/agent-stewardships.ts`
- Create: `server/src/routes/agent-stewardships.ts`
- Modify: `server/src/services/access.ts`
- Test: `server/src/__tests__/agent-stewardships.test.ts`

- [ ] **Step 1: Write failing uniqueness, transfer, and isolation tests**

```ts
it("permits only one active stewardship in both directions", async () => {
  await svc.assign(companyId, { userId, agentId }, ownerActor);
  await expect(svc.assign(companyId, { userId, agentId: otherAgentId }, ownerActor))
    .rejects.toMatchObject({ status: 409 });
  await expect(svc.assign(companyId, { userId: otherUserId, agentId }, ownerActor))
    .rejects.toMatchObject({ status: 409 });
});

it("transfers atomically and retains the previous row", async () => {
  const first = await svc.assign(companyId, { userId, agentId }, ownerActor);
  const next = await svc.transfer(companyId, agentId, { userId: otherUserId, reason: "Role change" }, ownerActor);
  expect(await svc.getById(first.id)).toMatchObject({ endedAt: expect.any(Date) });
  expect(next).toMatchObject({ userId: otherUserId, agentId, endedAt: null });
});
```

- [ ] **Step 2: Run RED**

```sh
pnpm exec vitest run server/src/__tests__/agent-stewardships.test.ts
```

Expected: module/table not found.

- [ ] **Step 3: Add the historical relation and partial unique indexes**

```ts
export const agentStewardships = pgTable("agent_stewardships", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  userId: text("user_id").notNull(),
  assignedByUserId: text("assigned_by_user_id").notNull(),
  endedByUserId: text("ended_by_user_id"),
  transferReason: text("transfer_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  activeUser: uniqueIndex("agent_stewardships_active_user_idx")
    .on(table.companyId, table.userId)
    .where(sql`${table.endedAt} IS NULL`),
  activeAgent: uniqueIndex("agent_stewardships_active_agent_idx")
    .on(table.companyId, table.agentId)
    .where(sql`${table.endedAt} IS NULL`),
}));
```

The service must lock the active agent row during transfer, verify active user
membership and same-company agent ownership, end the old row, insert the new
row, and log one `agent.stewardship_transferred` activity inside the transaction.

- [ ] **Step 4: Add routes and offboarding integration**

```ts
router.get("/companies/:companyId/me/agent", async (req, res) => {
  assertCompanyAccess(req, req.params.companyId);
  res.json(await svc.getActiveByUser(req.params.companyId, req.actor.userId!));
});
```

Owner/admin assignment and transfer routes use
`accessService.canUser(companyId, req.actor.userId, "agents:create")`. Member
archival ends active stewardship but preserves the agent.

- [ ] **Step 5: Run GREEN**

```sh
pnpm exec vitest run server/src/__tests__/agent-stewardships.test.ts server/src/__tests__/access-service.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add packages/db packages/shared server/src/services/agent-stewardships.ts server/src/routes/agent-stewardships.ts server/src/services/access.ts server/src/__tests__
git commit -m "Keep company agents continuous through steward changes"
```

### Task 3: Owner ceilings and steward configuration

**Files:**
- Create: `packages/db/src/schema/agent_governance_policies.ts`
- Create: `packages/shared/src/types/agent-governance.ts`
- Create: `packages/shared/src/validators/agent-governance.ts`
- Create: `server/src/services/agent-governance.ts`
- Create: `server/src/routes/agent-governance.ts`
- Modify: `server/src/routes/agents.ts`
- Test: `server/src/__tests__/agent-governance.test.ts`

- [ ] **Step 1: Write failing pure-policy and authorization tests**

```ts
it("intersects requested authority with the owner ceiling", () => {
  expect(computeEffectiveAgentPolicy(ceiling, requested)).toEqual({
    permissions: ["issues:read"],
    monthlyBudgetCents: 5_000,
    destructiveActions: "approval_required",
    dataScopes: ["project:alpha"],
    providers: ["telegram"],
    minimumApproval: "steward",
  });
});

it("rejects over-broad changes with a stable violation list", () => {
  expect(() => assertWithinCeiling(ceiling, requestedTooBroad)).toThrow(
    expect.objectContaining({ code: "AGENT_POLICY_CEILING_EXCEEDED" }),
  );
});
```

- [ ] **Step 2: Run RED**

```sh
pnpm exec vitest run server/src/__tests__/agent-governance.test.ts
```

- [ ] **Step 3: Implement typed, versioned policies**

```ts
export type AgentGovernancePolicy = {
  permissions: string[];
  monthlyBudgetCents: number;
  destructiveActions: "blocked" | "approval_required" | "allowed";
  dataScopes: string[];
  providers: string[];
  minimumApproval: "none" | "steward";
};
```

Persist `ownerCeiling`, `stewardRequest`, `effectivePolicy`, and `revision` per
agent. Owner/admin ceiling changes and steward request changes use separate
service methods. Both log accepted or rejected attempts with revision and
violation codes.

- [ ] **Step 4: Apply steward authorization to agent mutations**

Add one route helper:

```ts
async function requireAgentConfigurationAuthority(req: Request, agent: Agent) {
  if (await access.canUser(agent.companyId, req.actor.userId, "agents:create")) return "admin";
  if (await stewardships.isCurrentSteward(agent.companyId, agent.id, req.actor.userId)) return "steward";
  throw forbidden("Only the assigned steward or an authorized administrator can configure this agent");
}
```

Use it for instruction, connector, permissions, budget, and autonomy mutations.
Every mutation calls `assertWithinCeiling` before persistence.

- [ ] **Step 5: Run GREEN**

```sh
pnpm exec vitest run server/src/__tests__/agent-governance.test.ts server/src/__tests__/agent-routes.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add packages/db packages/shared server/src/services/agent-governance.ts server/src/routes/agent-governance.ts server/src/routes/agents.ts server/src/__tests__
git commit -m "Keep steward authority inside owner policy ceilings"
```

### Task 4: Steward-scoped approvals and emergency override

**Files:**
- Modify: `packages/db/src/schema/approvals.ts`
- Modify: `packages/shared/src/validators/approval.ts`
- Create: `server/src/services/approval-authority.ts`
- Modify: `server/src/services/approvals.ts`
- Modify: `server/src/routes/approvals.ts`
- Test: `server/src/__tests__/agentdash-mk-approval-authority.test.ts`

- [ ] **Step 1: Write failing actor, stale-revision, and idempotency tests**

```ts
it("allows the current steward and denies an ordinary member", async () => {
  await expect(decide(approvalId, stewardActor, { revision: 1, decision: "approved" }))
    .resolves.toMatchObject({ applied: true });
  await expect(decide(otherApprovalId, memberActor, { revision: 1, decision: "approved" }))
    .rejects.toMatchObject({ status: 403 });
});

it("requires an override reason and binds decisions to revisions", async () => {
  await expect(override(approvalId, ownerActor, { revision: 1, decision: "approved" }))
    .rejects.toMatchObject({ status: 400 });
  await expect(decide(approvalId, stewardActor, { revision: 0, decision: "approved" }))
    .rejects.toMatchObject({ status: 409 });
});
```

- [ ] **Step 2: Run RED**

```sh
pnpm exec vitest run server/src/__tests__/agentdash-mk-approval-authority.test.ts
```

- [ ] **Step 3: Extend approval persistence and input**

```ts
revision: integer("revision").notNull().default(1),
decisionChannel: text("decision_channel"),
decisionIdempotencyKey: text("decision_idempotency_key"),
decisionActorRole: text("decision_actor_role"),
overrideReason: text("override_reason"),
expiresAt: timestamp("expires_at", { withTimezone: true }),
supersededAt: timestamp("superseded_at", { withTimezone: true }),
```

```ts
export const resolveApprovalSchema = z.object({
  revision: z.number().int().positive(),
  decisionNote: multilineTextSchema.optional().nullable(),
  idempotencyKey: z.string().min(8).max(200),
  channel: z.enum(["web", "telegram", "teams"]),
});
```

- [ ] **Step 4: Centralize authority and decision**

The authority service loads company profile, approval, requesting agent,
membership, and active stewardship. `default` companies retain existing board
behavior. `agentdash_mk` uses the steward path. The override route is separate:

```ts
router.post("/approvals/:id/override", validate(overrideApprovalSchema), async (req, res) => {
  const actor = await authority.requireEmergencyOverride(req, req.params.id);
  res.json(await svc.decide(req.params.id, actor, req.body));
});
```

Use a conditional update on `id`, `revision`, and resolvable status. Return the
stored result for a repeated idempotency key.

- [ ] **Step 5: Run GREEN and existing approval regressions**

```sh
pnpm exec vitest run server/src/__tests__/agentdash-mk-approval-authority.test.ts server/src/__tests__/approval-routes-idempotency.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add packages/db/src/schema/approvals.ts packages/shared/src/validators/approval.ts server/src/services/approval-authority.ts server/src/services/approvals.ts server/src/routes/approvals.ts server/src/__tests__
git commit -m "Route governed decisions to each agent steward"
```

### Task 5: My Agent and server-backed personal Inbox

**Files:**
- Create: `ui/src/api/stewardships.ts`
- Create: `ui/src/api/agent-governance.ts`
- Create: `ui/src/pages/MyAgent.tsx`
- Create: `ui/src/components/agent/AgentGovernancePanel.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/Sidebar.tsx`
- Modify: `ui/src/pages/Inbox.tsx`
- Modify: `ui/src/pages/ApprovalDetail.tsx`
- Create: `server/src/routes/agentdash-mk-inbox.ts`
- Test: `ui/src/pages/MyAgent.test.tsx`
- Test: `ui/src/pages/Inbox.test.tsx`
- Test: `server/src/__tests__/agentdash-mk-inbox.test.ts`

- [ ] **Step 1: Write failing route and component tests**

```tsx
it("shows the authenticated member's stewarded agent", async () => {
  render(<MyAgent />);
  expect(await screen.findByRole("heading", { name: "My Agent" })).toBeVisible();
  expect(screen.getByText("Marketing Agent")).toBeVisible();
});
```

```ts
it("returns only approvals requested by the user's stewarded agent", async () => {
  const response = await api.get(`/api/companies/${companyId}/me/inbox`, stewardSession);
  expect(response.body.items.map((item: { approvalId: string }) => item.approvalId))
    .toEqual([ownedApprovalId]);
});
```

- [ ] **Step 2: Run RED**

```sh
pnpm exec vitest run ui/src/pages/MyAgent.test.tsx server/src/__tests__/agentdash-mk-inbox.test.ts
```

- [ ] **Step 3: Build the server query and clients**

Return a normalized inbox item with approval, requesting agent, source issue,
risk summary, revision, and decision history. Never accept a user ID query
parameter; derive it from `req.actor.userId`.

- [ ] **Step 4: Build the profile-gated UI**

```tsx
const myAgent = useQuery({
  queryKey: queryKeys.myAgent(companyId),
  queryFn: () => stewardshipsApi.getMyAgent(companyId),
});
```

Add My Agent navigation only when the selected company profile is
`agentdash_mk`. Keep override controls in a distinct owner/admin section.

- [ ] **Step 5: Run GREEN**

```sh
pnpm exec vitest run ui/src/pages/MyAgent.test.tsx ui/src/pages/Inbox.test.tsx server/src/__tests__/agentdash-mk-inbox.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add ui server/src/routes/agentdash-mk-inbox.ts server/src/__tests__/agentdash-mk-inbox.test.ts
git commit -m "Give every steward a personal agent control surface"
```

### Task 6: Stewardship and policy administration UI

**Files:**
- Create: `ui/src/components/access/StewardshipAssignments.tsx`
- Create: `ui/src/components/settings/HumanChannelBindings.tsx`
- Modify: `ui/src/pages/CompanyAccess.tsx`
- Modify: `ui/src/pages/CompanySettings.tsx`
- Test: `ui/src/pages/CompanyAccess.test.tsx`
- Test: `ui/src/pages/CompanySettings.test.tsx`

- [ ] **Step 1: Write failing administration tests**

```tsx
it("lets an owner transfer an agent and requires a reason", async () => {
  render(<CompanyAccess />);
  await user.click(await screen.findByRole("button", { name: "Transfer agent" }));
  await user.selectOptions(screen.getByLabelText("New steward"), otherUserId);
  await user.type(screen.getByLabelText("Reason"), "Role change");
  await user.click(screen.getByRole("button", { name: "Confirm transfer" }));
  expect(api.transferStewardship).toHaveBeenCalledWith(expect.objectContaining({ reason: "Role change" }));
});
```

- [ ] **Step 2: Run RED**

```sh
pnpm exec vitest run ui/src/pages/CompanyAccess.test.tsx ui/src/pages/CompanySettings.test.tsx
```

- [ ] **Step 3: Implement assignment, transfer, and ceiling editors**

Use existing member and agent queries. Show current steward, unassigned agents,
history, effective policy, and violation messages. Disable mutations for
non-owner/admin users.

- [ ] **Step 4: Run GREEN and commit**

```sh
pnpm exec vitest run ui/src/pages/CompanyAccess.test.tsx ui/src/pages/CompanySettings.test.tsx
git add ui
git commit -m "Make workforce stewardship administrable"
```

### Task 7: Shared human-channel bindings and event deduplication

**Files:**
- Create: `packages/db/src/schema/human_channel_bindings.ts`
- Create: `packages/db/src/schema/external_channel_events.ts`
- Create: `packages/shared/src/types/human-channel.ts`
- Create: `packages/shared/src/validators/human-channel.ts`
- Create: `server/src/services/human-channels.ts`
- Create: `server/src/routes/human-channels.ts`
- Test: `server/src/__tests__/human-channels.test.ts`

- [ ] **Step 1: Write failing binding/revocation/dedupe tests**

```ts
it("does not bind one provider identity to two active users in a company", async () => {
  await svc.verifyBinding(firstChallenge);
  await expect(svc.verifyBinding(secondChallengeSameExternalUser))
    .rejects.toMatchObject({ status: 409 });
});

it("claims one external event exactly once", async () => {
  expect(await svc.claimEvent("telegram", companyId, "update-42", digest)).toMatchObject({ claimed: true });
  expect(await svc.claimEvent("telegram", companyId, "update-42", digest)).toMatchObject({ claimed: false });
});
```

- [ ] **Step 2: Run RED**

```sh
pnpm exec vitest run server/src/__tests__/human-channels.test.ts
```

- [ ] **Step 3: Implement bindings and external event claims**

Persist provider, external tenant/user/conversation identifiers, active
stewardship ID, verification timestamps, revocation, and provider metadata.
Create a unique event key on `(provider, company_id, external_event_id)`.

- [ ] **Step 4: Run GREEN and commit**

```sh
pnpm exec vitest run server/src/__tests__/human-channels.test.ts
git add packages/db packages/shared server/src/services/human-channels.ts server/src/routes/human-channels.ts server/src/__tests__/human-channels.test.ts
git commit -m "Bind human messaging identities without granting authority"
```

### Task 8: Telegram chat and native approvals

**Files:**
- Create: `server/src/services/telegram-connector.ts`
- Create: `server/src/routes/telegram-connector.ts`
- Modify: `packages/shared/src/constants.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/__tests__/telegram-connector.test.ts`

- [ ] **Step 1: Write failing Telegram contract tests**

```ts
it("rejects a webhook with the wrong secret token", async () => {
  await request(app).post(webhookPath).set("X-Telegram-Bot-Api-Secret-Token", "wrong")
    .send(update).expect(401);
});

it("deduplicates update_id and binds callback decisions to the Telegram user", async () => {
  await request(app).post(webhookPath).set(secretHeader).send(callbackUpdate).expect(200);
  await request(app).post(webhookPath).set(secretHeader).send(callbackUpdate).expect(200);
  expect(approvalDecisions).toHaveLength(1);
});
```

- [ ] **Step 2: Run RED**

```sh
pnpm exec vitest run server/src/__tests__/telegram-connector.test.ts
```

- [ ] **Step 3: Implement the provider service**

Use the Telegram Bot API directly through `fetch`. `setWebhook` sets
`secret_token` and subscribes only to `message` and `callback_query`. Store
`update_id` as the external event ID. Inline keyboard `callback_data` contains
an opaque token no longer than 64 bytes. Always call `answerCallbackQuery`.

```ts
const keyboard = {
  inline_keyboard: [[
    { text: "Approve", callback_data: await tokens.issue({ approvalId, revision, decision: "approved" }) },
    { text: "Reject", callback_data: await tokens.issue({ approvalId, revision, decision: "rejected" }) },
  ]],
};
```

Messages route only through an active binding and current stewardship. Revocation
blocks inbound and outbound immediately.

- [ ] **Step 4: Run GREEN and commit**

```sh
pnpm exec vitest run server/src/__tests__/telegram-connector.test.ts server/src/__tests__/agentdash-mk-approval-authority.test.ts
git add server/src/services/telegram-connector.ts server/src/routes/telegram-connector.ts server/src/app.ts packages/shared/src/constants.ts server/src/__tests__/telegram-connector.test.ts
git commit -m "Put each stewarded agent in Telegram"
```

### Task 9: Microsoft Teams chat and Adaptive Card approvals

**Files:**
- Modify: `server/package.json`
- Create: `server/src/services/teams-connector.ts`
- Create: `server/src/routes/teams-connector.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/__tests__/teams-connector.test.ts`

- [ ] **Step 1: Add the manifest dependency** [Superseded 2026-08-03: the lockfile is now tracked; CI owns it via the refresh-lockfile bot — see DEVELOPING.md.]

```json
"@microsoft/teams.apps": "^2.0.14"
```

Run `pnpm install --lockfile-only --no-frozen-lockfile` only for local
resolution checks. Revert/leave `pnpm-lock.yaml` unstaged because CI owns it.

- [ ] **Step 2: Write failing authenticated activity and action tests**

```ts
it("rejects an unauthenticated Teams activity", async () => {
  await request(app).post("/api/connectors/teams/messages").send(activity).expect(401);
});

it("routes Action.Execute through shared approval authority", async () => {
  await teamsHarness.executeCardAction(validStewardActivity);
  expect(decideApproval).toHaveBeenCalledWith(expect.objectContaining({
    channel: "teams",
    revision: 3,
  }));
});
```

- [ ] **Step 3: Run RED**

```sh
pnpm exec vitest run server/src/__tests__/teams-connector.test.ts
```

- [ ] **Step 4: Integrate the current Teams SDK**

Use `App` and `ExpressAdapter` from `@microsoft/teams.apps`. Do not enable
`skipAuth` outside the explicit test harness. Configure app ID, tenant ID, and
encrypted client secret/federated credentials. Retain conversation references
for proactive replies.

Build Adaptive Cards with `Action.Execute`, not legacy `Action.Submit`:

```ts
new ExecuteAction({ title: "Approve" }).withData({
  action: "agentdash.approval.decide",
  token: opaqueDecisionToken,
});
```

Every action resolves the Entra/Teams actor, active binding, current
stewardship, approval revision, and terminal state through shared services.

- [ ] **Step 5: Run GREEN and commit**

```sh
pnpm exec vitest run server/src/__tests__/teams-connector.test.ts server/src/__tests__/human-channels.test.ts
git add server/package.json server/src/services/teams-connector.ts server/src/routes/teams-connector.ts server/src/app.ts server/src/__tests__/teams-connector.test.ts
git commit -m "Put each stewarded agent in Microsoft Teams"
```

### Task 10: Complete child contributions and provenance

**Files:**
- Modify: `server/src/services/issues.ts`
- Modify: `server/src/routes/issues.ts`
- Modify: `packages/shared/src/types/issue.ts`
- Test: `server/src/__tests__/agentdash-mk-delegation.test.ts`

- [ ] **Step 1: Write the failing CEO-to-three-stakeholders test**

```ts
it("returns complete child artifacts and wakes the parent once", async () => {
  const result = await scenario.completeChildren([product, engineering, marketing]);
  expect(result.parentWakeups).toHaveLength(1);
  expect(result.contributions).toEqual(expect.arrayContaining([
    expect.objectContaining({ agentId: product.agentId, workProducts: expect.any(Array) }),
    expect.objectContaining({ agentId: engineering.agentId, documents: expect.any(Array) }),
    expect.objectContaining({ agentId: marketing.agentId, sourceIssueId: marketing.id }),
  ]));
});
```

- [ ] **Step 2: Run RED**

```sh
pnpm exec vitest run server/src/__tests__/agentdash-mk-delegation.test.ts
```

- [ ] **Step 3: Add a complete contribution endpoint**

Return child issue metadata, complete comments, linked documents, attachments,
and work products with author provenance. Parent wake payload contains stable
references and contribution counts, not truncated artifact bodies.

- [ ] **Step 4: Run GREEN and commit**

```sh
pnpm exec vitest run server/src/__tests__/agentdash-mk-delegation.test.ts server/src/__tests__/issues.test.ts
git add server/src/services/issues.ts server/src/routes/issues.ts packages/shared/src/types/issue.ts server/src/__tests__/agentdash-mk-delegation.test.ts
git commit -m "Preserve complete stakeholder contributions"
```

### Task 11: Prompt and documentation synchronization

**Files:**
- Modify: `server/src/onboarding-assets/default/AGENTS.md`
- Modify: `server/src/onboarding-assets/ceo/AGENTS.md`
- Modify: `server/src/onboarding-assets/chief_of_staff/AGENTS.md`
- Modify: `server/src/services/agent-creator-from-proposal.ts`
- Modify: `doc/SPEC-implementation.md`
- Modify: `doc/DEVELOPING.md`
- Modify: `.env.example`
- Create: `docs/api/agentdash-mk.md`
- Test: `server/src/__tests__/agent-instruction-bundles.test.ts`

- [ ] **Step 1: Write the failing prompt drift assertion**

```ts
it("includes the AgentDash-MK workforce block in every prompt surface", () => {
  for (const surface of renderedPromptSurfaces) {
    expect(surface).toContain("<!-- AgentDash: agentdash-mk-workforce");
    expect(surface).toContain("current human steward");
    expect(surface).toContain("complete child contribution");
  }
});
```

- [ ] **Step 2: Run RED**

```sh
pnpm exec vitest run server/src/__tests__/agent-instruction-bundles.test.ts
```

- [ ] **Step 3: Update every prompt and operator document**

Document adapter-neutral HTTP behavior, approval revision handling, card OR
comment fallback, quota/authorization escalation, Telegram webhook variables,
Teams app variables, pairing/revocation, and P2 exclusions. Wrap prompt additions
in the required named block.

- [ ] **Step 4: Run GREEN and commit**

```sh
pnpm exec vitest run server/src/__tests__/agent-instruction-bundles.test.ts
git add server/src/onboarding-assets server/src/services/agent-creator-from-proposal.ts doc docs/api .env.example
git commit -m "Teach every agent the AgentDash-MK governance contract"
```

### Task 12: End-to-end acceptance and full verification

**Files:**
- Create: `tests/e2e/agentdash-mk-workforce.spec.ts`
- Modify: `tests/e2e/playwright-multiuser-authenticated.config.ts` if registration is required

- [ ] **Step 1: Write the complete browser/API acceptance scenario**

```ts
test("CEO consolidates three stewarded contributions with web, Telegram, and Teams approvals", async ({ request, page }) => {
  const company = await fixtures.createCompany({ productProfile: "agentdash_mk" });
  await fixtures.createAndAssignWorkforce(company, ["CEO", "Product", "Engineering", "Marketing"]);
  await fixtures.setOwnerCeilings(company);
  await fixtures.delegateBoardDeck(company);
  await fixtures.approveViaWeb("product");
  await fixtures.approveViaTelegram("engineering");
  await fixtures.approveViaTeams("marketing");
  await fixtures.completeContributions();
  await page.goto(`/companies/${company.id}/inbox`);
  await expect(page.getByText("Board deck ready")).toBeVisible();
  await expect(page.getByText("4 contributors")).toBeVisible();
});
```

- [ ] **Step 2: Run the targeted E2E RED/GREEN loop**

```sh
pnpm exec playwright test tests/e2e/agentdash-mk-workforce.spec.ts --config tests/e2e/playwright-multiuser-authenticated.config.ts
```

- [ ] **Step 3: Run the complete required verification**

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm exec playwright test tests/e2e/agentdash-mk-workforce.spec.ts --config tests/e2e/playwright-multiuser-authenticated.config.ts
```

Expected: zero failures. Record exact test counts and any provider-live tests
that require credentials.

- [ ] **Step 4: Audit every design acceptance criterion**

Create a requirement-to-evidence table in the handoff covering all fourteen
criteria from the design. Evidence must name the schema constraint, service or
route test, UI/E2E test, and relevant command output. Missing live provider
credentials are a verification gap, not an implicit pass.

- [ ] **Step 5: Final commit**

```sh
git add tests/e2e
git commit -m "Prove the AgentDash-MK workforce loop end to end"
```
