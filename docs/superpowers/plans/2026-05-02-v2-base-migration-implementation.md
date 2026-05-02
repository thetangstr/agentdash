# v2 base migration implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement the spec at [docs/superpowers/specs/2026-05-02-v2-base-migration-design.md](../specs/2026-05-02-v2-base-migration-design.md) — archive v1, create new `main` from `upstream/master`, port the surgical carry-forwards, hand off a green base for the five subsystem plans.

**Architecture:** Branch ops first (archive + new main), surgical re-application of carry-forwards as fresh commits, then verify the new base typechecks, tests, and builds. Production cutover does **not** happen in this plan — it happens only after all 5 subsystem plans land on the new main (per spec §5).

**Tech Stack:** Git, GitHub CLI, pnpm, Node 20.

---

## Phase 1 — Branch ops

### Task 1.1 — Archive v1, create new main

**Files:** none changed; this is git remote ops.

- [ ] **Step 1: Verify upstream is fetched**

```sh
git fetch upstream
git log --oneline upstream/master -3
```

Expected: recent paperclip commits visible.

- [ ] **Step 2: Create archive branch from current default**

```sh
# On the contributor's machine:
git checkout agentdash-main
git pull origin agentdash-main
git checkout -b archive/agentdash-v1
git push origin archive/agentdash-v1
```

Expected: new branch on origin with full v1 history.

- [ ] **Step 3: Create new `main` branch from upstream/master**

```sh
git checkout -b main upstream/master
git push -u origin main
```

Expected: new `main` branch on origin pointing at the same SHA as `upstream/master`.

- [ ] **Step 4: Protect archive branch**

In GitHub UI (or via `gh api`):
- Add a branch protection rule on `archive/agentdash-v1`: require pull request reviews, restrict pushes (read-only).
- Default branch stays as `agentdash-main` for now (cutover happens later, per spec §5).

- [ ] **Step 5: Smoke test the new main**

```sh
git checkout main
pnpm install
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all four pass on a clean upstream checkout. (If they don't, the issue is upstream, not us — open a digest entry and pause.)

---

## Phase 2 — Carry-forward: AgentDash onboarding fixes

These are the GH #70/#71/#72 + AGE-55 changes that landed in [PR #74](https://github.com/thetangstr/agentdash/pull/74). On the new main, the underlying paperclip code has shifted, so this is **not** a cherry-pick — it's a surgical re-apply.

### Task 2.1 — Re-apply GH #72 (`agents:create` grant on company creation)

**Files:**
- Modify: `server/src/routes/companies.ts`

- [ ] **Step 1: Locate the company POST handler on new main**

```sh
grep -n "router.post.*\"/\"\\|company.create" server/src/routes/companies.ts | head
```

- [ ] **Step 2: Read the existing handler context**

It will likely have `ensureMembership(... "owner" ...)` — find that line.

- [ ] **Step 3: Apply the grant before owner promotion**

Insert before `ensureMembership(... "owner")`:

```typescript
const ownerPrincipalId = req.actor.userId ?? "local-board";
await access.setPrincipalPermission(
  company.id,
  "user",
  ownerPrincipalId,
  "agents:create",
  true,
  ownerPrincipalId,
);
await access.ensureMembership(company.id, "user", ownerPrincipalId, "owner", "active");
```

The order matters — `setPrincipalPermission` upserts membership as `member` internally; calling `ensureMembership("owner")` *after* it stamps the correct final role. (See PR #74 commit message for the failure mode if reversed.)

- [ ] **Step 4: Re-apply the actionable error message**

Find `assertCanCreateAgentsForCompany` in `server/src/routes/agents.ts` and update the error strings:

```typescript
if (!allowed) {
  throw forbidden(
    "Missing permission: agents:create. Ask a company owner or instance admin to grant this " +
      `permission via PATCH /api/companies/${companyId}/members/:memberId/permissions.`,
  );
}
```

- [ ] **Step 5: Run typecheck**

```sh
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add server/src/routes/companies.ts server/src/routes/agents.ts
git commit -m "feat(server): grant agents:create to company creator (GH #72 carry-forward)"
```

### Task 2.2 — Re-apply GH #71 (auto API key on agent creation)

**Files:**
- Modify: `server/src/routes/agents.ts`
- Modify: `server/src/services/wizard.ts` (if present on new main; if upstream has restructured, find the equivalent)

- [ ] **Step 1: Locate the agent POST handler**

```sh
grep -n "router.post.*\"/companies/:companyId/agents\"" server/src/routes/agents.ts
```

- [ ] **Step 2: Add auto-key issuance after agent creation**

After the existing `materializeDefaultInstructionsBundleForNewAgent(createdAgent)` call (or wherever the agent is fully constructed before the response), insert:

```typescript
let apiKey: Awaited<ReturnType<typeof svc.createApiKey>> | null = null;
if (agent.status !== "pending_approval") {
  apiKey = await svc.createApiKey(agent.id, "default");
  await logActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    action: "agent.key_created",
    entityType: "agent",
    entityId: agent.id,
    details: { keyId: apiKey.id, name: apiKey.name, autoCreated: true },
  });
}

res.status(201).json({ ...agent, apiKey });
```

- [ ] **Step 3: Apply the same in the wizard service if present**

```sh
ls server/src/services/wizard.ts 2>/dev/null && grep -n "agentSvc.create" server/src/services/wizard.ts
```

If the file exists, add `const apiKey = await agentSvc.createApiKey(agent.id, "default");` after the create + materialize, and include `apiKey` in the return.

- [ ] **Step 4: Run typecheck**

```sh
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/src/routes/agents.ts server/src/services/wizard.ts
git commit -m "feat(server): auto-create default API key on agent creation (GH #71 carry-forward)"
```

### Task 2.3 — Verify GH #70 (sync instructions materialization)

GH #70 turned out to be already-fixed in upstream too (the `materializeDefaultInstructionsBundleForNewAgent(createdAgent)` call is synchronous in the upstream POST handler). Verify, don't re-apply.

- [ ] **Step 1: Confirm the call is synchronous**

```sh
grep -n "materializeDefaultInstructionsBundleForNewAgent" server/src/routes/agents.ts
```

Expected: a synchronous `await materializeDefaultInstructionsBundleForNewAgent(createdAgent)` immediately after `svc.create`. If not, replicate the v1 fix from PR #74.

- [ ] **Step 2: No commit needed if already-correct.**

### Task 2.4 — Re-apply AGE-55 + AGE-60 (email-domain + free-mail block)

**Files:**
- Modify: `server/src/routes/companies.ts`
- Possibly create: `server/src/middleware/corp-email-signup-guard.ts` (if not in upstream)

- [ ] **Step 1: Diff v1 vs new main for `companies.ts` POST handler**

```sh
git show archive/agentdash-v1:server/src/routes/companies.ts > /tmp/v1-companies.ts
diff /tmp/v1-companies.ts server/src/routes/companies.ts | head -100
```

- [ ] **Step 2: Re-apply email-domain derivation block**

Port the block of code that:
1. Looks up the creator's email from `auth_users`.
2. Derives `email_domain` via `deriveCompanyEmailDomain`.
3. Checks `findByEmailDomain` for collisions and returns 409 `domain_already_claimed`.
4. Stores `emailDomain` on the new company row.

(Refer to v1 `server/src/routes/companies.ts` for the exact block; copy it as a fresh commit on new main.)

- [ ] **Step 3: Re-apply the corp-email-signup-guard if not in upstream**

```sh
ls server/src/middleware/corp-email-signup-guard.ts 2>/dev/null || echo "missing"
```

If missing, copy the file from `archive/agentdash-v1`:

```sh
git show archive/agentdash-v1:server/src/middleware/corp-email-signup-guard.ts > server/src/middleware/corp-email-signup-guard.ts
```

Wire it in `server/src/index.ts` or `server/src/app.ts` exactly as v1 had it.

- [ ] **Step 4: Run typecheck + tests**

```sh
pnpm -r typecheck
pnpm test:run -- companies-email-domain
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/src/routes/companies.ts server/src/middleware/corp-email-signup-guard.ts \
  server/src/index.ts server/src/app.ts
git commit -m "feat(server): email-domain derivation + free-mail block (AGE-55/60 carry-forward)"
```

### Task 2.5 — Re-apply onboarding-fix tests

**Files:**
- Create: `server/src/__tests__/agent-permissions-routes.test.ts` (port from v1)
- Create: `server/src/__tests__/companies-email-domain-route.test.ts` (port from v1)
- Create: `server/src/__tests__/signup-pro-free-mail-block.test.ts` (port from v1)

- [ ] **Step 1: Copy test files from v1**

```sh
for f in agent-permissions-routes.test.ts companies-email-domain-route.test.ts signup-pro-free-mail-block.test.ts; do
  git show archive/agentdash-v1:server/src/__tests__/$f > server/src/__tests__/$f
done
```

- [ ] **Step 2: Run them**

```sh
pnpm test:run -- agent-permissions-routes companies-email-domain-route signup-pro-free-mail-block
```

Expected: PASS. If any fail because upstream has changed surface area (e.g. mock service signatures), fix the tests minimally to track upstream — do not weaken assertions.

- [ ] **Step 3: Commit**

```sh
git add server/src/__tests__/agent-permissions-routes.test.ts \
  server/src/__tests__/companies-email-domain-route.test.ts \
  server/src/__tests__/signup-pro-free-mail-block.test.ts
git commit -m "test(server): port onboarding-fix tests from v1"
```

---

## Phase 3 — Carry-forward: assets and skills

### Task 3.1 — Default Chief of Staff bundle

**Files:**
- Create: `server/src/onboarding-assets/chief_of_staff/SOUL.md`
- Create: `server/src/onboarding-assets/chief_of_staff/AGENTS.md`
- Create: `server/src/onboarding-assets/chief_of_staff/HEARTBEAT.md`

- [ ] **Step 1: Copy the bundle from v1**

```sh
mkdir -p server/src/onboarding-assets/chief_of_staff
for f in SOUL.md AGENTS.md HEARTBEAT.md; do
  git show archive/agentdash-v1:server/src/onboarding-assets/chief_of_staff/$f > server/src/onboarding-assets/chief_of_staff/$f
done
```

- [ ] **Step 2: Verify the loader code references this path**

```sh
grep -rn "onboarding-assets/chief_of_staff" server/src/
```

The `loadDefaultAgentInstructionsBundle` (or equivalent) function should resolve this path.

- [ ] **Step 3: Commit**

```sh
git add server/src/onboarding-assets/chief_of_staff/
git commit -m "feat(server): port default Chief of Staff SOUL/AGENTS/HEARTBEAT bundle"
```

### Task 3.2 — Slash commands (skills)

**Files:**
- Create: `.claude/commands/{workon,pm,builder,tester,tpm,admin,upstream-digest,README}.md`

- [ ] **Step 1: Copy all commands from v1**

```sh
mkdir -p .claude/commands
for f in workon.md pm.md builder.md tester.md tpm.md admin.md upstream-digest.md README.md; do
  git show archive/agentdash-v1:.claude/commands/$f > .claude/commands/$f 2>/dev/null || echo "$f missing in v1"
done
```

- [ ] **Step 2: Verify they load**

In a fresh Claude Code session against the new main, run `/workon` and `/upstream-digest`. They should be discoverable.

- [ ] **Step 3: Commit**

```sh
git add .claude/commands/
git commit -m "feat(tooling): port MAW slash commands + /upstream-digest"
```

### Task 3.3 — Upstream digest script + policy doc

**Files:**
- Create: `scripts/upstream-digest.sh`
- Create: `doc/UPSTREAM-POLICY.md`
- Create: `doc/upstream-digests/2026-05-02.md`

- [ ] **Step 1: Copy script + docs**

```sh
git show archive/agentdash-v1:scripts/upstream-digest.sh > scripts/upstream-digest.sh
chmod +x scripts/upstream-digest.sh
git show archive/agentdash-v1:doc/UPSTREAM-POLICY.md > doc/UPSTREAM-POLICY.md
mkdir -p doc/upstream-digests
git show archive/agentdash-v1:doc/upstream-digests/2026-05-02.md > doc/upstream-digests/2026-05-02.md
```

- [ ] **Step 2: Run the digest fresh on new main**

```sh
bash scripts/upstream-digest.sh
```

Expected: produces a fresh `doc/upstream-digests/<today>.md`. The total commits-ahead count should now be **near zero** because we just branched from upstream.

- [ ] **Step 3: Commit**

```sh
git add scripts/upstream-digest.sh doc/UPSTREAM-POLICY.md doc/upstream-digests/
git commit -m "feat(tooling): port upstream-digest skill + policy doc"
```

---

## Phase 4 — Carry-forward: assistant_conversations schema

### Task 4.1 — Port assistant tables

**Files:**
- Create: `packages/db/src/schema/assistant.ts` (if absent on new main)
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Check if upstream has these tables**

```sh
ls packages/db/src/schema/assistant.ts 2>/dev/null || echo "missing — port from v1"
```

- [ ] **Step 2: If missing, port from v1**

```sh
git show archive/agentdash-v1:packages/db/src/schema/assistant.ts > packages/db/src/schema/assistant.ts
```

- [ ] **Step 3: Re-export**

Add to `packages/db/src/schema/index.ts`:

```typescript
export * from "./assistant.js";
```

- [ ] **Step 4: Generate the migration**

```sh
pnpm db:generate
```

Inspect the generated SQL — should be a single `CREATE TABLE assistant_conversations` + `CREATE TABLE assistant_messages` (assuming upstream's schema doesn't already have a colliding table).

- [ ] **Step 5: Apply + typecheck**

```sh
pnpm db:migrate
pnpm -r typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/db/src/schema/assistant.ts packages/db/src/schema/index.ts \
  packages/db/src/migrations/
git commit -m "feat(db): port assistant_conversations + assistant_messages schema"
```

> **Note:** the chat-substrate spec (sub-project #5) will add the `assistant_conversation_participants` link table on top of this. That's a separate plan; this task only ports the v1 base.

---

## Phase 5 — Documentation refresh

### Task 5.1 — Update CLAUDE.md for v2

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the v1 CLAUDE.md inventory section**

Concretely:
- Update the project description to "AgentDash v2: lean fork of paperclip with 5 added subsystems" instead of the v1 "86 schema tables" list.
- Update the "Key Rules" to reflect v2's lean surface (drop CRM/HubSpot/AutoResearch/etc. from any feature lists).
- Keep the `pnpm` / dev commands section.
- Keep the regression-testing-before-handoff section.
- Update the "MAW commands" section to point at the carried-forward slash commands.
- Update "Branding" section if needed.
- Reference [doc/UPSTREAM-POLICY.md](../UPSTREAM-POLICY.md) for the upstream relationship.

- [ ] **Step 2: Commit**

```sh
git add CLAUDE.md
git commit -m "docs: refresh CLAUDE.md for v2 lean surface"
```

### Task 5.2 — Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace v1 feature pitch with v2 framing**

Frame v2 as: "AgentDash — a CoS-led, multi-human AI workspace built on Paperclip." Keep install/quickstart sections; refresh the feature bullets to match the 5 keep-list subsystems.

- [ ] **Step 2: Commit**

```sh
git add README.md
git commit -m "docs: refresh README for v2"
```

---

## Phase 6 — Final verification

### Task 6.1 — Full regression on new main

- [ ] **Step 1: Typecheck**

```sh
pnpm -r typecheck
```

Expected: PASS (all packages).

- [ ] **Step 2: Test suite**

```sh
pnpm test:run
```

Expected: PASS, modulo any pre-existing upstream flakes. Document any flakes in the PR body.

- [ ] **Step 3: Build**

```sh
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Run the dev server**

```sh
pnpm dev
```

Expected: server starts on `:3100`, UI on whatever port upstream uses, no startup errors.

### Task 6.2 — Open the migration PR

- [ ] **Step 1: Push the new main**

The new main was pushed in Task 1.1. Confirm.

```sh
git fetch origin
git log --oneline origin/main -10
```

- [ ] **Step 2: Open a tracking PR (informational)**

This is a non-merging PR for review purposes; the new main is the target trunk for the 5 subsystem PRs.

```sh
gh pr create --repo thetangstr/agentdash --base archive/agentdash-v1 --head main \
  --title "v2 base migration — new main from upstream/master" \
  --body "$(cat <<'EOF'
## Summary

Implements docs/superpowers/specs/2026-05-02-v2-base-migration-design.md.

The new `main` branch is branched from `upstream/master`. Carry-forwards re-applied
as fresh commits:

- GH #70/#71/#72 onboarding fixes (PR #74)
- AGE-55/AGE-60 email-domain + free-mail block
- Default Chief of Staff bundle
- assistant_conversations + assistant_messages schema
- Slash commands (workon, pm, builder, tester, tpm, admin, upstream-digest)
- doc/UPSTREAM-POLICY.md + scripts/upstream-digest.sh

Dropped from v2 (per spec §4):
- HubSpot stub, AutoResearch stub, Action Proposals stub
- CRM, Inbox, Operator Feed, Skills Registry workflow, Smart Model Routing
- Pipeline Orchestrator (load-bearing in v1, dropped from keep-list)
- Budget + Capacity (load-bearing in v1, dropped from keep-list)

## Verification

- `pnpm -r typecheck` ✓
- `pnpm test:run` ✓
- `pnpm build` ✓

## Next

Five subsystem PRs land on this branch over the next several hours:
1. Multi-human + CoS chat substrate
2. Onboarding (rescoped)
3. Subscription + billing
4. UI redesign with Claude design (port + apply)
5. Assess + agent research (port)

After all 5 land green, this branch becomes the new `agentdash-main`
(per spec §5 cutover criteria).

This PR is informational — it does NOT merge. The new main IS the target.
EOF
)"
```

- [ ] **Step 3: Mark plan complete**

The five subsystem plans now have a green base to land against.

---

## What this plan does NOT do

- **Cutover.** Default branch stays as `agentdash-main` (the v1 branch) until all 5 subsystem PRs land. Cutover is a separate operational task per spec §5.
- **Production data migration.** v1 production DB is not touched. Out of scope.
- **CI/CD pipeline updates.** Tracked alongside cutover, not here.

## Decisions baked in (cross-reference to spec § 8)

| Decision | Implementation |
|---|---|
| Same repo, branch ops only | Phase 1 |
| New trunk = `main`, eventually renamed at cutover | Phase 1.1 |
| Surgical re-application, not bulk merge | Phases 2–4 (each port is a fresh commit) |
| Pipelines + Budget dropped | Not ported (intentional omission) |
| All 5 subsystems get their own specs/plans | Out of scope here; their plans land on the new main |
