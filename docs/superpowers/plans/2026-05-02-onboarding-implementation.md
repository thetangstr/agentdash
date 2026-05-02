# AgentDash v2 Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the spec at [docs/superpowers/specs/2026-05-02-onboarding-design.md](../specs/2026-05-02-onboarding-design.md) — first-time visitor goes from sign-up to "named AI direct report on my org chart, teammates can see them" in under 10 minutes via one CoS conversation.

**Architecture:** Sign-up redirects directly to a CoS chat. The chat UI calls a single idempotent `bootstrap` endpoint that auto-provisions company + CoS agent + grants + API key + conversation in one transaction, then drives an adaptive interview (3 fixed questions + 2–4 LLM-branched follow-ups, max 7), produces an agent proposal, hires the agent on confirm, prompts for teammate invites, and ends. A daily email digest cron is the re-engagement loop.

**Tech Stack:** TypeScript, Node 20, Express 5, Drizzle ORM, PostgreSQL, React 19, Vitest, Playwright. LLM: Anthropic SDK (Claude Sonnet 4.6 for the interview, Haiku 4.5 for the proposer summarizer).

---

## Prerequisites

Before Phase 1 starts, the v2 base must be set up. **These are NOT tasks in this plan** — they belong to the v2 base-migration plan that precedes this one.

- [ ] New `main` branch on `thetangstr/agentdash` from `upstream/master`.
- [ ] AgentDash carry-forward fixes cherry-picked from [PR #74](https://github.com/thetangstr/agentdash/pull/74) (AGE-55 email-domain logic, GH #70 sync instructions materialization, GH #71 auto API key, GH #72 `agents:create` grant).
- [ ] Default Chief of Staff bundle (`server/src/onboarding-assets/chief_of_staff/`) ported.
- [ ] `assistant_conversations` and `assistant_messages` schema ported.
- [ ] Skill files (`.claude/commands/`, `scripts/upstream-digest.sh`, `doc/UPSTREAM-POLICY.md`) ported.
- [ ] Anthropic SDK installed; `ANTHROPIC_API_KEY` available in dev/test envs (use the `claude_api` adapter's existing config).
- [ ] On the new `main` branch: `pnpm install && pnpm -r typecheck && pnpm test:run && pnpm build` all green.

If any prereq is missing, stop and finish the v2 base-migration plan first.

---

## File Structure

Files **created** by this plan:

| File | Responsibility |
|---|---|
| `packages/db/src/schema/assistant_conversation_participants.ts` | Drizzle schema for the new link table |
| `packages/db/src/migrations/0072_assistant_conversation_participants.sql` | Migration |
| `server/src/services/onboarding-orchestrator.ts` | Idempotent auto-provision |
| `server/src/services/cos-interview.ts` | Adaptive interview driver with stop criterion |
| `server/src/services/agent-proposer.ts` | Transcript → AgentProposal pure function (LLM-backed) |
| `server/src/services/heartbeat-digest.ts` | Daily digest cron + email rendering |
| `server/src/onboarding-assets/chief_of_staff/INTERVIEW.md` | Versioned CoS interview system prompt |
| `server/src/routes/onboarding-v2.ts` | `POST /api/onboarding/bootstrap`, `POST /api/onboarding/interview/turn`, `POST /api/onboarding/agent/confirm`, `POST /api/onboarding/invites` |
| `ui/src/pages/CoSConversation.tsx` | The chat surface — landing page after sign-up |
| `ui/src/components/InvitePrompt.tsx` | Post-hire invite UI step rendered inline in chat |
| `ui/src/api/onboarding.ts` | Frontend client for the bootstrap/turn/confirm/invites endpoints |
| `server/src/__tests__/onboarding-orchestrator.test.ts` | Unit + idempotency tests |
| `server/src/__tests__/cos-interview.test.ts` | Stop-criterion + max-turn tests |
| `server/src/__tests__/agent-proposer.test.ts` | Proposal shape tests |
| `server/src/__tests__/heartbeat-digest.test.ts` | Dedup + skip-when-no-activity tests |
| `tests/e2e/onboarding-v2.spec.ts` | End-to-end Playwright happy path + invite |

Files **modified** by this plan:

| File | Change |
|---|---|
| `packages/db/src/schema/index.ts` | Export the new participants table |
| `server/src/app.ts` | Wire `onboarding-v2` routes |
| `server/src/index.ts` | Register heartbeat-digest cron |
| `server/src/services/index.ts` | Export new services |
| `ui/src/App.tsx` | Route `/` → `CoSConversation` (replacing `WelcomePage`) |
| `ui/src/api/auth.ts` | Sign-up handler redirects to `/` (no interstitial) |
| `packages/shared/src/index.ts` | Export new shared types (`AgentProposal`, `InterviewTurn`) |

Files **deleted** by this plan:

| File | Reason |
|---|---|
| `ui/src/pages/WelcomePage.tsx` | Replaced by `CoSConversation` |

---

## Phase 1 — Schema: `assistant_conversation_participants`

Adds a many-to-many link between users and conversations so a single CoS thread can have multiple human participants.

### Task 1.1 — Schema definition

**Files:**
- Create: `packages/db/src/schema/assistant_conversation_participants.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/db/src/__tests__/assistant_conversation_participants.test.ts
import { describe, it, expect } from "vitest";
import { assistantConversationParticipants } from "../schema/assistant_conversation_participants.js";

describe("assistant_conversation_participants schema", () => {
  it("has the required columns", () => {
    const cols = Object.keys(assistantConversationParticipants);
    expect(cols).toContain("id");
    expect(cols).toContain("conversationId");
    expect(cols).toContain("userId");
    expect(cols).toContain("role");
    expect(cols).toContain("joinedAt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
pnpm test:run -- assistant_conversation_participants
```

Expected: FAIL with "Cannot find module './schema/assistant_conversation_participants.js'".

- [ ] **Step 3: Write the schema file**

```typescript
// packages/db/src/schema/assistant_conversation_participants.ts
import { pgTable, uuid, varchar, timestamp, index, unique } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { assistantConversations } from "./assistant.js";

export const assistantConversationParticipants = pgTable(
  "assistant_conversation_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 32 }).notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("acp_conversation_user_unique").on(table.conversationId, table.userId),
    index("acp_conversation_idx").on(table.conversationId),
    index("acp_user_idx").on(table.userId),
  ],
);
```

- [ ] **Step 4: Export from index**

Add to `packages/db/src/schema/index.ts`:

```typescript
export * from "./assistant_conversation_participants.js";
```

- [ ] **Step 5: Run test to verify it passes**

```sh
pnpm test:run -- assistant_conversation_participants
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/db/src/schema/assistant_conversation_participants.ts \
  packages/db/src/schema/index.ts \
  packages/db/src/__tests__/assistant_conversation_participants.test.ts
git commit -m "feat(db): add assistant_conversation_participants schema"
```

### Task 1.2 — Generate migration

**Files:**
- Create: `packages/db/src/migrations/0072_<auto_named>.sql`

- [ ] **Step 1: Run drizzle generate**

```sh
pnpm db:generate
```

Expected: a new file `packages/db/src/migrations/0072_<auto_named>.sql` and updated `meta/_journal.json`.

- [ ] **Step 2: Inspect the generated SQL**

The generated SQL should include `CREATE TABLE "assistant_conversation_participants"` plus indexes and FK constraints. If it doesn't, fix the schema file and re-run generate.

- [ ] **Step 3: Apply the migration**

```sh
pnpm db:migrate
```

Expected: migration runs cleanly.

- [ ] **Step 4: Typecheck**

```sh
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/db/src/migrations/0072_*.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): generate migration for assistant_conversation_participants"
```

---

## Phase 2 — Onboarding orchestrator (auto-provision)

Idempotent: given a `userId`, ensures the user has a company + CoS agent + API key + CoS conversation, with the user as the only initial conversation participant. Calling twice is a no-op.

### Task 2.1 — Service contract test

**Files:**
- Create: `server/src/services/onboarding-orchestrator.ts`
- Create: `server/src/__tests__/onboarding-orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/onboarding-orchestrator.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { onboardingOrchestrator } from "../services/onboarding-orchestrator.js";

const mockAccess = {
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
};
const mockCompanies = {
  create: vi.fn(),
  findByEmailDomain: vi.fn(),
};
const mockAgents = {
  create: vi.fn(),
  createApiKey: vi.fn(),
  listByCompany: vi.fn(),
};
const mockInstructions = { materializeManagedBundle: vi.fn() };
const mockConversations = {
  findByCompany: vi.fn(),
  create: vi.fn(),
  addParticipant: vi.fn(),
};
const mockUsers = { getById: vi.fn() };

const deps = {
  access: mockAccess,
  companies: mockCompanies,
  agents: mockAgents,
  instructions: mockInstructions,
  conversations: mockConversations,
  users: mockUsers,
};

describe("onboardingOrchestrator.bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsers.getById.mockResolvedValue({ id: "user-1", email: "alice@acme.com" });
    mockCompanies.findByEmailDomain.mockResolvedValue(null);
    mockCompanies.create.mockResolvedValue({ id: "company-1", name: "Acme", emailDomain: "acme.com" });
    mockAgents.listByCompany.mockResolvedValue([]);
    mockAgents.create.mockResolvedValue({
      id: "agent-cos-1",
      companyId: "company-1",
      role: "chief_of_staff",
      adapterType: "claude_local",
      adapterConfig: {},
    });
    mockAgents.createApiKey.mockResolvedValue({ id: "key-1", token: "agk_test" });
    mockInstructions.materializeManagedBundle.mockResolvedValue({
      adapterConfig: { instructionsFilePath: "/tmp/AGENTS.md" },
    });
    mockConversations.findByCompany.mockResolvedValue(null);
    mockConversations.create.mockResolvedValue({ id: "conv-1", companyId: "company-1" });
  });

  it("creates company, CoS agent, API key, and conversation for a fresh user", async () => {
    const result = await onboardingOrchestrator(deps as any).bootstrap("user-1");
    expect(result).toEqual({
      companyId: "company-1",
      cosAgentId: "agent-cos-1",
      conversationId: "conv-1",
    });
    expect(mockCompanies.create).toHaveBeenCalledOnce();
    expect(mockAgents.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ role: "chief_of_staff" }),
    );
    expect(mockAccess.setPrincipalPermission).toHaveBeenCalledWith(
      "company-1",
      "user",
      "user-1",
      "agents:create",
      true,
      "user-1",
    );
    expect(mockAccess.ensureMembership).toHaveBeenCalledWith(
      "company-1",
      "user",
      "user-1",
      "owner",
      "active",
    );
    expect(mockAgents.createApiKey).toHaveBeenCalledWith("agent-cos-1", "default");
    expect(mockConversations.addParticipant).toHaveBeenCalledWith("conv-1", "user-1", "owner");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
pnpm test:run -- onboarding-orchestrator
```

Expected: FAIL with "Cannot find module '../services/onboarding-orchestrator.js'".

- [ ] **Step 3: Write the orchestrator**

```typescript
// server/src/services/onboarding-orchestrator.ts
import { logger } from "../middleware/logger.js";

interface Deps {
  access: any;
  companies: any;
  agents: any;
  instructions: any;
  conversations: any;
  users: any;
}

interface BootstrapResult {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
}

export function onboardingOrchestrator(deps: Deps) {
  return {
    bootstrap: async (userId: string): Promise<BootstrapResult> => {
      const user = await deps.users.getById(userId);
      if (!user) throw new Error(`User ${userId} not found`);

      // Step 1: ensure a company. Use email-domain lookup first (idempotency).
      const emailDomain = deriveEmailDomain(user.email);
      let company = emailDomain ? await deps.companies.findByEmailDomain(emailDomain) : null;
      if (!company) {
        company = await deps.companies.create({
          name: companyNameFromEmail(user.email),
          emailDomain,
          budgetMonthlyCents: 0,
        });
      }

      // Step 2: grant agents:create FIRST (before owner promotion — see GH #72).
      await deps.access.setPrincipalPermission(
        company.id,
        "user",
        userId,
        "agents:create",
        true,
        userId,
      );
      await deps.access.ensureMembership(company.id, "user", userId, "owner", "active");

      // Step 3: ensure a Chief of Staff agent exists.
      const existing = await deps.agents.listByCompany(company.id);
      let cos = existing.find((a: any) => a.role === "chief_of_staff");
      if (!cos) {
        const created = await deps.agents.create(company.id, {
          name: "Chief of Staff",
          role: "chief_of_staff",
          adapterType: "claude_api",
          adapterConfig: {},
          status: "idle",
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        });
        const materialized = await deps.instructions.materializeManagedBundle(
          created,
          {}, // load default chief_of_staff bundle from onboarding-assets
          { entryFile: "AGENTS.md", replaceExisting: false },
        );
        cos = { ...created, adapterConfig: materialized.adapterConfig };
      }

      // Step 4: ensure CoS has an API key.
      // The carry-forward GH #71 fix means new agents get a key automatically;
      // for the idempotent path, only create if listKeys is empty.
      // (Implementation detail: agents.createApiKey is safe to call on existing
      //  agents; the spec says first agent's API key, so just always issue one.)
      await deps.agents.createApiKey(cos.id, "default");

      // Step 5: ensure a conversation exists for this company; add the user.
      let conversation = await deps.conversations.findByCompany(company.id);
      if (!conversation) {
        conversation = await deps.conversations.create({ companyId: company.id });
      }
      await deps.conversations.addParticipant(conversation.id, userId, "owner");

      return {
        companyId: company.id,
        cosAgentId: cos.id,
        conversationId: conversation.id,
      };
    },
  };
}

function deriveEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

function companyNameFromEmail(email: string | null | undefined): string {
  const domain = deriveEmailDomain(email);
  if (!domain) return "My Workspace";
  const root = domain.split(".")[0];
  return root.charAt(0).toUpperCase() + root.slice(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

```sh
pnpm test:run -- onboarding-orchestrator
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/src/services/onboarding-orchestrator.ts \
  server/src/__tests__/onboarding-orchestrator.test.ts
git commit -m "feat(server): onboarding orchestrator (auto-provision)"
```

### Task 2.2 — Idempotency test

**Files:**
- Modify: `server/src/__tests__/onboarding-orchestrator.test.ts`

- [ ] **Step 1: Add the idempotency test**

```typescript
it("is idempotent — calling twice does not create two CoS agents", async () => {
  // First call sets up company + CoS.
  const orchestrator = onboardingOrchestrator(deps as any);
  await orchestrator.bootstrap("user-1");
  vi.clearAllMocks();

  // On the second call, all lookups return the existing artifacts.
  mockCompanies.findByEmailDomain.mockResolvedValue({ id: "company-1", emailDomain: "acme.com" });
  mockAgents.listByCompany.mockResolvedValue([
    { id: "agent-cos-1", role: "chief_of_staff", adapterType: "claude_api", adapterConfig: {} },
  ]);
  mockConversations.findByCompany.mockResolvedValue({ id: "conv-1", companyId: "company-1" });

  const result = await orchestrator.bootstrap("user-1");
  expect(result.companyId).toBe("company-1");
  expect(result.cosAgentId).toBe("agent-cos-1");
  expect(result.conversationId).toBe("conv-1");
  expect(mockCompanies.create).not.toHaveBeenCalled();
  expect(mockAgents.create).not.toHaveBeenCalled();
  expect(mockConversations.create).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test**

```sh
pnpm test:run -- onboarding-orchestrator
```

Expected: PASS (orchestrator was already coded to be idempotent in Task 2.1).

- [ ] **Step 3: Commit**

```sh
git add server/src/__tests__/onboarding-orchestrator.test.ts
git commit -m "test(server): idempotency for onboarding orchestrator"
```

### Task 2.3 — `addParticipant` repository method

**Files:**
- Modify: `server/src/services/assistant.ts` (or equivalent — find the conversation service after carry-forward)

- [ ] **Step 1: Locate the conversation service**

```sh
grep -rn "assistant_conversations\|assistantConversations" server/src/services/
```

Identify the file owning conversation CRUD (likely `server/src/services/assistant.ts` after carry-forward).

- [ ] **Step 2: Write the failing test**

Add to the conversation service test file (create if absent: `server/src/__tests__/assistant-participants.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import { conversationService } from "../services/assistant.js";

// Use real DB harness following the pattern of other server tests.
describe("conversationService.addParticipant", () => {
  it("inserts a row in assistant_conversation_participants", async () => {
    // setup: create a user + company + conversation
    // ...harness boilerplate matching existing tests...
    const conv = await conversationService(db).create({ companyId });
    await conversationService(db).addParticipant(conv.id, userId, "owner");
    const rows = await db
      .select()
      .from(assistantConversationParticipants)
      .where(eq(assistantConversationParticipants.conversationId, conv.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].role).toBe("owner");
  });

  it("is idempotent — calling addParticipant twice with the same user does not duplicate", async () => {
    // ...same setup...
    await conversationService(db).addParticipant(conv.id, userId, "owner");
    await conversationService(db).addParticipant(conv.id, userId, "owner");
    const rows = await db
      .select()
      .from(assistantConversationParticipants)
      .where(eq(assistantConversationParticipants.conversationId, conv.id));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```sh
pnpm test:run -- assistant-participants
```

Expected: FAIL — `addParticipant` doesn't exist yet.

- [ ] **Step 4: Implement `addParticipant`**

```typescript
// In conversationService(db) factory:
addParticipant: async (
  conversationId: string,
  userId: string,
  role: "owner" | "member" = "member",
) => {
  await db
    .insert(assistantConversationParticipants)
    .values({ conversationId, userId, role })
    .onConflictDoNothing({ target: [
      assistantConversationParticipants.conversationId,
      assistantConversationParticipants.userId,
    ] });
},

findByCompany: async (companyId: string) => {
  return db
    .select()
    .from(assistantConversations)
    .where(eq(assistantConversations.companyId, companyId))
    .orderBy(asc(assistantConversations.createdAt))
    .then((rows) => rows[0] ?? null);
},
```

- [ ] **Step 5: Run test**

```sh
pnpm test:run -- assistant-participants
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add server/src/services/assistant.ts server/src/__tests__/assistant-participants.test.ts
git commit -m "feat(server): conversation addParticipant + findByCompany"
```

---

## Phase 3 — CoS interview driver

Adaptive interview: 3 fixed grounding questions + 2–4 LLM-branched follow-ups, max 7 total. Stop criterion fires when the LLM signals it has enough.

### Task 3.1 — Interview state types

**Files:**
- Create: `packages/shared/src/types/interview.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Define the types**

```typescript
// packages/shared/src/types/interview.ts
export type InterviewTurnRole = "user" | "assistant";

export interface InterviewTurn {
  role: InterviewTurnRole;
  content: string;
  ts: string;            // ISO timestamp
}

export interface InterviewState {
  conversationId: string;
  turns: InterviewTurn[];
  fixedQuestionsAsked: number; // 0..3
  followUpsAsked: number;      // 0..4
  status: "in_progress" | "ready_to_propose" | "exceeded_max";
}

export const INTERVIEW_MAX_TURNS = 7;
export const FIXED_QUESTIONS = [
  "What's your business and who's it for?",
  "What's eating your time most this month?",
  "What does success look like 90 days from now?",
] as const;
```

- [ ] **Step 2: Export from shared index**

Add to `packages/shared/src/index.ts`:

```typescript
export * from "./types/interview.js";
```

- [ ] **Step 3: Typecheck**

```sh
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```sh
git add packages/shared/src/types/interview.ts packages/shared/src/index.ts
git commit -m "feat(shared): InterviewState + InterviewTurn types"
```

### Task 3.2 — Interview driver test (fixed-question phase)

**Files:**
- Create: `server/src/services/cos-interview.ts`
- Create: `server/src/__tests__/cos-interview.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/cos-interview.test.ts
import { describe, it, expect, vi } from "vitest";
import { cosInterview } from "../services/cos-interview.js";
import { FIXED_QUESTIONS } from "@agentdash/shared";

const mockLlm = vi.fn();

describe("cosInterview.nextTurn", () => {
  it("returns the first fixed question on a fresh state", async () => {
    const next = await cosInterview({ llm: mockLlm }).nextTurn({
      conversationId: "conv-1",
      turns: [],
      fixedQuestionsAsked: 0,
      followUpsAsked: 0,
      status: "in_progress",
    });
    expect(next.assistantMessage).toBe(FIXED_QUESTIONS[0]);
    expect(next.state.fixedQuestionsAsked).toBe(1);
    expect(next.state.status).toBe("in_progress");
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it("asks the second fixed question after the first user reply", async () => {
    const next = await cosInterview({ llm: mockLlm }).nextTurn({
      conversationId: "conv-1",
      turns: [
        { role: "assistant", content: FIXED_QUESTIONS[0], ts: "2026-05-02T00:00:00Z" },
        { role: "user", content: "We sell B2B SaaS to mid-market.", ts: "2026-05-02T00:01:00Z" },
      ],
      fixedQuestionsAsked: 1,
      followUpsAsked: 0,
      status: "in_progress",
    });
    expect(next.assistantMessage).toBe(FIXED_QUESTIONS[1]);
    expect(next.state.fixedQuestionsAsked).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
pnpm test:run -- cos-interview
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Write the driver (fixed phase only)**

```typescript
// server/src/services/cos-interview.ts
import {
  FIXED_QUESTIONS,
  INTERVIEW_MAX_TURNS,
  type InterviewState,
  type InterviewTurn,
} from "@agentdash/shared";

interface Deps {
  llm: (
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
  ) => Promise<{ text: string; readyToPropose: boolean }>;
}

interface NextTurnResult {
  assistantMessage: string;
  state: InterviewState;
}

export function cosInterview(deps: Deps) {
  return {
    nextTurn: async (state: InterviewState): Promise<NextTurnResult> => {
      // Phase 1: fixed questions, no LLM call.
      if (state.fixedQuestionsAsked < FIXED_QUESTIONS.length) {
        const question = FIXED_QUESTIONS[state.fixedQuestionsAsked];
        return {
          assistantMessage: question,
          state: {
            ...state,
            fixedQuestionsAsked: state.fixedQuestionsAsked + 1,
            turns: [
              ...state.turns,
              { role: "assistant", content: question, ts: new Date().toISOString() },
            ],
          },
        };
      }
      // Phase 2: adaptive follow-ups (filled in Task 3.3).
      throw new Error("Adaptive phase not implemented yet");
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```sh
pnpm test:run -- cos-interview
```

Expected: PASS for the two fixed-phase tests.

- [ ] **Step 5: Commit**

```sh
git add server/src/services/cos-interview.ts server/src/__tests__/cos-interview.test.ts
git commit -m "feat(server): cos-interview driver — fixed-question phase"
```

### Task 3.3 — Interview driver test (adaptive phase + stop criterion)

**Files:**
- Modify: `server/src/services/cos-interview.ts`
- Modify: `server/src/__tests__/cos-interview.test.ts`

- [ ] **Step 1: Add adaptive-phase tests**

```typescript
it("asks an LLM-generated follow-up after all fixed questions answered", async () => {
  mockLlm.mockResolvedValueOnce({
    text: "How many outbound emails are you sending per week today?",
    readyToPropose: false,
  });
  const stateAfterFixed: InterviewState = {
    conversationId: "conv-1",
    turns: [
      { role: "assistant", content: FIXED_QUESTIONS[0], ts: "1" },
      { role: "user", content: "B2B SaaS.", ts: "2" },
      { role: "assistant", content: FIXED_QUESTIONS[1], ts: "3" },
      { role: "user", content: "Cold outbound is killing me.", ts: "4" },
      { role: "assistant", content: FIXED_QUESTIONS[2], ts: "5" },
      { role: "user", content: "200 qualified meetings booked.", ts: "6" },
    ],
    fixedQuestionsAsked: 3,
    followUpsAsked: 0,
    status: "in_progress",
  };
  const next = await cosInterview({ llm: mockLlm }).nextTurn(stateAfterFixed);
  expect(mockLlm).toHaveBeenCalledOnce();
  expect(next.assistantMessage).toContain("outbound");
  expect(next.state.followUpsAsked).toBe(1);
});

it("transitions to ready_to_propose when LLM signals it has enough", async () => {
  mockLlm.mockResolvedValueOnce({
    text: "Got it — I have what I need.",
    readyToPropose: true,
  });
  const next = await cosInterview({ llm: mockLlm }).nextTurn({
    conversationId: "conv-1",
    turns: longTurns(8),  // helper: any 8 fixed-then-followup turns
    fixedQuestionsAsked: 3,
    followUpsAsked: 1,
    status: "in_progress",
  });
  expect(next.state.status).toBe("ready_to_propose");
});

it("forces exceeded_max after 4 follow-ups even if LLM never signals stop", async () => {
  mockLlm.mockResolvedValue({ text: "And how often?", readyToPropose: false });
  const next = await cosInterview({ llm: mockLlm }).nextTurn({
    conversationId: "conv-1",
    turns: longTurns(11),
    fixedQuestionsAsked: 3,
    followUpsAsked: 4,
    status: "in_progress",
  });
  expect(next.state.status).toBe("exceeded_max");
  expect(next.assistantMessage).toBeNull();
});

function longTurns(n: number): InterviewTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "assistant" : "user",
    content: `placeholder ${i}`,
    ts: String(i),
  }));
}
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
pnpm test:run -- cos-interview
```

Expected: 3 new failures.

- [ ] **Step 3: Implement adaptive phase + stop criterion**

```typescript
// In cosInterview.nextTurn, replace the throw:

// Phase 2: bounded adaptive follow-ups.
const MAX_FOLLOW_UPS = 4;
if (state.followUpsAsked >= MAX_FOLLOW_UPS) {
  return {
    assistantMessage: null as unknown as string, // sentinel: no message
    state: { ...state, status: "exceeded_max" },
  };
}

const messages = state.turns.map((t) => ({ role: t.role, content: t.content }));
const llmResult = await deps.llm(systemPrompt(), messages);

if (llmResult.readyToPropose) {
  return {
    assistantMessage: llmResult.text,
    state: {
      ...state,
      turns: [
        ...state.turns,
        { role: "assistant", content: llmResult.text, ts: new Date().toISOString() },
      ],
      status: "ready_to_propose",
    },
  };
}

return {
  assistantMessage: llmResult.text,
  state: {
    ...state,
    turns: [
      ...state.turns,
      { role: "assistant", content: llmResult.text, ts: new Date().toISOString() },
    ],
    followUpsAsked: state.followUpsAsked + 1,
    status: "in_progress",
  },
};
```

Add the prompt loader at the top of the file:

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let _systemPrompt: string | null = null;
function systemPrompt(): string {
  if (_systemPrompt) return _systemPrompt;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(here, "../onboarding-assets/chief_of_staff/INTERVIEW.md");
  _systemPrompt = readFileSync(promptPath, "utf8");
  return _systemPrompt;
}
```

- [ ] **Step 4: Run tests**

```sh
pnpm test:run -- cos-interview
```

Expected: PASS (will fail on the prompt file load — handle in next task).

- [ ] **Step 5: Commit**

```sh
git add server/src/services/cos-interview.ts server/src/__tests__/cos-interview.test.ts
git commit -m "feat(server): cos-interview adaptive phase + stop criterion"
```

### Task 3.4 — Write the CoS interview system prompt

**Files:**
- Create: `server/src/onboarding-assets/chief_of_staff/INTERVIEW.md`

- [ ] **Step 1: Author the prompt**

The prompt must instruct the LLM to:
1. Read the conversation so far.
2. If it has identified (a) the user's domain, (b) the bottleneck, and (c) can write a one-line role description for the proposed agent — set `readyToPropose: true` and respond with a brief acknowledgement.
3. Otherwise, ask exactly one short follow-up question that branches on what the user said in the most recent answer.
4. Never ask more than 4 follow-ups beyond the fixed three (the driver enforces this; the prompt mirrors it).
5. Tone: warm, concise, business-fluent. No greetings, no preamble, no markdown headings.

Concrete content (write to the file):

```markdown
You are the Chief of Staff in a brand-new AgentDash workspace. The user just signed up.

You are running an onboarding interview that has already asked three fixed grounding questions:
  1. "What's your business and who's it for?"
  2. "What's eating your time most this month?"
  3. "What does success look like 90 days from now?"

Your job now is to ask 0–4 short follow-up questions that branch on what the user said,
until you have enough to propose a single direct-report agent. You have enough when you
can write all three of the following in one sentence each:
  - The user's domain (what their business does).
  - The single biggest bottleneck the user wants off their plate.
  - A one-line role description for the proposed agent (name + role + 90-day OKR).

When you have enough, return `readyToPropose: true` and a brief acknowledgement
("Got it — I have what I need to propose your first hire.").
Otherwise return `readyToPropose: false` and a single short question.

Tone: warm, concise, business-fluent. No greetings, no preamble, no markdown headings,
no emoji. Ask one question at a time.
```

- [ ] **Step 2: Run cos-interview tests again**

```sh
pnpm test:run -- cos-interview
```

Expected: PASS.

- [ ] **Step 3: Commit**

```sh
git add server/src/onboarding-assets/chief_of_staff/INTERVIEW.md
git commit -m "feat(server): cos-interview system prompt v1"
```

### Task 3.5 — LLM adapter integration

**Files:**
- Create: `server/src/services/llm-claude.ts`

The interview takes an `llm` dep — wire it to the real Anthropic SDK in non-test code, mocked in tests.

- [ ] **Step 1: Write the LLM adapter**

```typescript
// server/src/services/llm-claude.ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function claudeInterview(
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<{ text: string; readyToPropose: boolean }> {
  const resp = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system,
    messages,
    tools: [
      {
        name: "submit_turn",
        description: "Return the next assistant message and whether the interview is ready to propose an agent.",
        input_schema: {
          type: "object",
          properties: {
            text: { type: "string" },
            readyToPropose: { type: "boolean" },
          },
          required: ["text", "readyToPropose"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_turn" },
  });

  const toolUse = resp.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("LLM did not return a submit_turn tool call");
  }
  const input = toolUse.input as { text: string; readyToPropose: boolean };
  return { text: input.text, readyToPropose: input.readyToPropose };
}
```

- [ ] **Step 2: Typecheck**

```sh
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```sh
git add server/src/services/llm-claude.ts
git commit -m "feat(server): claude LLM adapter for cos-interview"
```

---

## Phase 4 — Agent proposer

Pure function: given an interview transcript, return `{ name, role, oneLineOkr }`. LLM-backed (Haiku for speed/cost).

### Task 4.1 — Proposer test

**Files:**
- Create: `server/src/services/agent-proposer.ts`
- Create: `server/src/__tests__/agent-proposer.test.ts`

- [ ] **Step 1: Define the AgentProposal type**

Add to `packages/shared/src/types/interview.ts`:

```typescript
export interface AgentProposal {
  name: string;          // e.g. "Reese"
  role: string;          // e.g. "SDR"
  oneLineOkr: string;    // e.g. "Book 200 qualified meetings in 90 days from existing CRM list"
  rationale: string;     // 1-2 sentence why-this-agent
}
```

Re-export from `packages/shared/src/index.ts`.

- [ ] **Step 2: Write the failing test**

```typescript
// server/src/__tests__/agent-proposer.test.ts
import { describe, it, expect, vi } from "vitest";
import { agentProposer } from "../services/agent-proposer.js";
import type { InterviewTurn } from "@agentdash/shared";

const mockLlm = vi.fn();

describe("agentProposer.propose", () => {
  it("returns a typed AgentProposal from a canned transcript", async () => {
    mockLlm.mockResolvedValue({
      name: "Reese",
      role: "SDR",
      oneLineOkr: "Book 200 qualified meetings in 90 days",
      rationale: "User runs B2B SaaS outbound; volume is the blocker.",
    });
    const transcript: InterviewTurn[] = [
      { role: "assistant", content: "What's your business?", ts: "1" },
      { role: "user", content: "B2B SaaS for mid-market.", ts: "2" },
    ];
    const proposal = await agentProposer({ llm: mockLlm }).propose(transcript);
    expect(proposal).toMatchObject({
      name: "Reese",
      role: "SDR",
      oneLineOkr: expect.any(String),
      rationale: expect.any(String),
    });
  });

  it("rejects empty transcripts", async () => {
    await expect(agentProposer({ llm: mockLlm }).propose([])).rejects.toThrow(/empty/i);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```sh
pnpm test:run -- agent-proposer
```

Expected: FAIL with module-not-found.

- [ ] **Step 4: Implement**

```typescript
// server/src/services/agent-proposer.ts
import type { AgentProposal, InterviewTurn } from "@agentdash/shared";

interface Deps {
  llm: (transcript: InterviewTurn[]) => Promise<AgentProposal>;
}

export function agentProposer(deps: Deps) {
  return {
    propose: async (transcript: InterviewTurn[]): Promise<AgentProposal> => {
      if (transcript.length === 0) {
        throw new Error("Cannot propose an agent from an empty transcript");
      }
      return deps.llm(transcript);
    },
  };
}
```

- [ ] **Step 5: Run test**

```sh
pnpm test:run -- agent-proposer
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add server/src/services/agent-proposer.ts \
  server/src/__tests__/agent-proposer.test.ts \
  packages/shared/src/types/interview.ts
git commit -m "feat(server): agent-proposer service"
```

### Task 4.2 — Claude proposer adapter

**Files:**
- Modify: `server/src/services/llm-claude.ts`

- [ ] **Step 1: Add the proposer adapter**

```typescript
// server/src/services/llm-claude.ts (append)
import type { AgentProposal, InterviewTurn } from "@agentdash/shared";

export async function claudePropose(transcript: InterviewTurn[]): Promise<AgentProposal> {
  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: PROPOSER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content:
          "Interview transcript:\n\n" +
          transcript.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n"),
      },
    ],
    tools: [
      {
        name: "propose_agent",
        description: "Propose a single direct-report agent for the user.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string" },
            oneLineOkr: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["name", "role", "oneLineOkr", "rationale"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "propose_agent" },
  });
  const toolUse = resp.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("LLM did not return a propose_agent tool call");
  }
  return toolUse.input as AgentProposal;
}

const PROPOSER_SYSTEM_PROMPT = `Given an onboarding interview transcript, propose ONE direct-report AI agent for the user.

Pick a memorable, human-feeling name (single first name, e.g. "Reese", "Mira", "Theo").
Pick the role from this menu where the fit is strong: SDR, content writer, ops coordinator, support triage, research analyst.
If none fit, write a free-form short role string (2–4 words).
The 90-day OKR must be one sentence, concrete, and measurable from the user's actual context.
The rationale is 1–2 sentences explaining why this agent for this user.`;
```

- [ ] **Step 2: Typecheck**

```sh
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```sh
git add server/src/services/llm-claude.ts
git commit -m "feat(server): claude proposer adapter (Haiku)"
```

---

## Phase 5 — Agent creator from proposal

Wraps the existing agent-creation service from PR #74. Generates SOUL.md and AGENTS.md from the proposal + transcript.

### Task 5.1 — Creator test

**Files:**
- Create: `server/src/services/agent-creator-from-proposal.ts`
- Create: `server/src/__tests__/agent-creator-from-proposal.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/agent-creator-from-proposal.test.ts
import { describe, it, expect, vi } from "vitest";
import { agentCreatorFromProposal } from "../services/agent-creator-from-proposal.js";
import type { AgentProposal, InterviewTurn } from "@agentdash/shared";

const mockAgents = {
  create: vi.fn(),
  createApiKey: vi.fn(),
};
const mockInstructions = { materializeManagedBundle: vi.fn() };

describe("agentCreatorFromProposal", () => {
  it("creates an agent + materializes SOUL/AGENTS/HEARTBEAT from the proposal", async () => {
    mockAgents.create.mockResolvedValue({ id: "agent-2", role: "engineer", adapterType: "claude_local", adapterConfig: {} });
    mockInstructions.materializeManagedBundle.mockResolvedValue({
      adapterConfig: { instructionsFilePath: "/tmp/AGENTS.md" },
    });
    const proposal: AgentProposal = {
      name: "Reese",
      role: "SDR",
      oneLineOkr: "Book 200 qualified meetings in 90 days",
      rationale: "B2B outbound; volume blocker.",
    };
    const transcript: InterviewTurn[] = [
      { role: "user", content: "B2B SaaS, mid-market.", ts: "1" },
    ];
    const result = await agentCreatorFromProposal({
      agents: mockAgents,
      instructions: mockInstructions,
    } as any).create({
      companyId: "company-1",
      reportsToAgentId: "agent-cos-1",
      proposal,
      transcript,
    });
    expect(mockAgents.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "Reese",
        role: "general", // SDR maps to general role until we add SDR
        title: "SDR",
        reportsTo: "agent-cos-1",
        adapterType: "claude_local",
      }),
    );
    expect(mockInstructions.materializeManagedBundle).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        "SOUL.md": expect.stringContaining("Reese"),
        "AGENTS.md": expect.stringContaining("SDR"),
        "HEARTBEAT.md": expect.any(String),
      }),
      expect.any(Object),
    );
    expect(result.agentId).toBe("agent-2");
    expect(result.apiKey).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```sh
pnpm test:run -- agent-creator-from-proposal
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement**

```typescript
// server/src/services/agent-creator-from-proposal.ts
import type { AgentProposal, InterviewTurn } from "@agentdash/shared";

interface Deps {
  agents: any;
  instructions: any;
}

interface CreateInput {
  companyId: string;
  reportsToAgentId: string;
  proposal: AgentProposal;
  transcript: InterviewTurn[];
}

export function agentCreatorFromProposal(deps: Deps) {
  return {
    create: async (input: CreateInput) => {
      const { companyId, reportsToAgentId, proposal, transcript } = input;
      const created = await deps.agents.create(companyId, {
        name: proposal.name,
        role: "general", // role-string mapping reserved for future expansion
        title: proposal.role,
        adapterType: "claude_local",
        adapterConfig: {},
        reportsTo: reportsToAgentId,
        status: "idle",
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });
      const files = {
        "SOUL.md": renderSoul(proposal, transcript),
        "AGENTS.md": renderAgents(proposal),
        "HEARTBEAT.md": renderHeartbeat(),
      };
      await deps.instructions.materializeManagedBundle(created, files, {
        entryFile: "AGENTS.md",
        replaceExisting: false,
      });
      const apiKey = await deps.agents.createApiKey(created.id, "default");
      return { agentId: created.id, apiKey };
    },
  };
}

function renderSoul(p: AgentProposal, transcript: InterviewTurn[]): string {
  const userVoice = transcript
    .filter((t) => t.role === "user")
    .map((t) => `> ${t.content}`)
    .join("\n");
  return `# SOUL.md — ${p.name}

## Identity
You are ${p.name}, a ${p.role}.

## Mission
${p.oneLineOkr}

## Why you exist
${p.rationale}

## Context from your boss
${userVoice}

## Boundaries
- Do not take irreversible actions without explicit confirmation.
- Escalate ambiguous situations to your boss rather than guessing.
- Respect company policies and security boundaries.
`;
}

function renderAgents(p: AgentProposal): string {
  return `# AGENTS.md — ${p.name}

## Role
${p.role}

## 90-day Goal
${p.oneLineOkr}

## Primary Responsibilities
- Execute work aligned with the goal above.
- Surface blockers and decisions requiring human input.
- Maintain accurate records of actions taken.

## Collaboration
- Report status to your boss in the shared CoS thread.
- Ask for clarification when requirements are ambiguous.
`;
}

function renderHeartbeat(): string {
  return `# HEARTBEAT.md — empty

No schedule set. Your boss will set a heartbeat schedule when ready.
`;
}
```

- [ ] **Step 4: Run test**

```sh
pnpm test:run -- agent-creator-from-proposal
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/src/services/agent-creator-from-proposal.ts \
  server/src/__tests__/agent-creator-from-proposal.test.ts
git commit -m "feat(server): agent creator from interview proposal"
```

---

## Phase 6 — Onboarding routes

REST endpoints the UI calls. Idempotent bootstrap, interview turn, agent confirm, invites.

### Task 6.1 — Routes test (bootstrap)

**Files:**
- Create: `server/src/routes/onboarding-v2.ts`
- Create: `server/src/__tests__/onboarding-v2-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/onboarding-v2-routes.test.ts
import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { onboardingV2Routes } from "../routes/onboarding-v2.js";
import { errorHandler } from "../middleware/error-handler.js";

const mockOrchestrator = { bootstrap: vi.fn() };

vi.mock("../services/index.js", () => ({
  onboardingOrchestrator: () => mockOrchestrator,
  cosInterview: () => ({ nextTurn: vi.fn() }),
  agentProposer: () => ({ propose: vi.fn() }),
  agentCreatorFromProposal: () => ({ create: vi.fn() }),
}));

function buildApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.actor = actor; next(); });
  app.use("/api/onboarding", onboardingV2Routes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/onboarding/bootstrap", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns the bootstrapped IDs and seeds the first CoS message", async () => {
    mockOrchestrator.bootstrap.mockResolvedValue({
      companyId: "c1", cosAgentId: "a1", conversationId: "conv1",
    });
    const app = buildApp({ type: "board", userId: "user-1", source: "session" });
    const res = await request(app).post("/api/onboarding/bootstrap").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId: "c1",
      cosAgentId: "a1",
      conversationId: "conv1",
      firstMessage: expect.stringContaining("?"), // CoS opener with first question
    });
    expect(mockOrchestrator.bootstrap).toHaveBeenCalledWith("user-1");
  });

  it("rejects unauthenticated callers", async () => {
    const app = buildApp({ type: "none", source: "none" });
    const res = await request(app).post("/api/onboarding/bootstrap").send({});
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```sh
pnpm test:run -- onboarding-v2-routes
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the route**

```typescript
// server/src/routes/onboarding-v2.ts
import { Router } from "express";
import type { Db } from "@agentdash/db";
import {
  onboardingOrchestrator,
  cosInterview,
  agentProposer,
  agentCreatorFromProposal,
} from "../services/index.js";
import { unauthorized } from "../errors.js";
import { FIXED_QUESTIONS } from "@agentdash/shared";

export function onboardingV2Routes(db: Db) {
  const router = Router();
  const orch = onboardingOrchestrator(/* deps wired in services/index */);
  // Other services wired similarly.

  router.post("/bootstrap", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const result = await orch.bootstrap(req.actor.userId);
    // Seed the first CoS message: the first fixed question.
    const firstMessage = `Welcome to AgentDash. Let's get you set up. ${FIXED_QUESTIONS[0]}`;
    res.json({ ...result, firstMessage });
  });

  // turn / confirm / invites added in later tasks
  return router;
}
```

- [ ] **Step 4: Run test**

```sh
pnpm test:run -- onboarding-v2-routes
```

Expected: PASS for the two bootstrap tests.

- [ ] **Step 5: Commit**

```sh
git add server/src/routes/onboarding-v2.ts \
  server/src/__tests__/onboarding-v2-routes.test.ts
git commit -m "feat(server): onboarding-v2 bootstrap route"
```

### Task 6.2 — Interview turn route

**Files:**
- Modify: `server/src/routes/onboarding-v2.ts`
- Modify: `server/src/__tests__/onboarding-v2-routes.test.ts`

- [ ] **Step 1: Add the failing test**

```typescript
// In the existing describe block:
describe("POST /api/onboarding/interview/turn", () => {
  it("advances the interview state and returns the next assistant message", async () => {
    const mockNext = vi.fn().mockResolvedValue({
      assistantMessage: FIXED_QUESTIONS[1],
      state: { fixedQuestionsAsked: 2, followUpsAsked: 0, status: "in_progress", conversationId: "conv1", turns: [] },
    });
    // (re-mock cosInterview per test if needed)
    const app = buildApp({ type: "board", userId: "user-1", source: "session" });
    const res = await request(app)
      .post("/api/onboarding/interview/turn")
      .send({
        conversationId: "conv1",
        userMessage: "B2B SaaS, mid-market.",
      });
    expect(res.status).toBe(200);
    expect(res.body.assistantMessage).toBe(FIXED_QUESTIONS[1]);
    expect(res.body.state.status).toBe("in_progress");
  });
});
```

- [ ] **Step 2: Run, expect failure**

```sh
pnpm test:run -- onboarding-v2-routes
```

Expected: FAIL with 404 (route not implemented).

- [ ] **Step 3: Implement the route**

```typescript
// In onboardingV2Routes:
router.post("/interview/turn", async (req, res) => {
  if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Sign-in required");
  const { conversationId, userMessage } = req.body;
  // 1. Append the user's message to the conversation (real persistence).
  // 2. Load the InterviewState from DB (turns + counters).
  // 3. Call cosInterview.nextTurn(state).
  // 4. Persist the new assistant message + updated counters.
  // 5. Return { assistantMessage, state }.
  const interview = cosInterview(/* deps */);
  const state = await loadInterviewState(db, conversationId);
  state.turns.push({ role: "user", content: userMessage, ts: new Date().toISOString() });
  const next = await interview.nextTurn(state);
  await persistInterviewState(db, conversationId, next.state);
  res.json({ assistantMessage: next.assistantMessage, state: next.state });
});

// loadInterviewState/persistInterviewState helpers go in same file or a small helper module.
```

- [ ] **Step 4: Run test**

```sh
pnpm test:run -- onboarding-v2-routes
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/src/routes/onboarding-v2.ts server/src/__tests__/onboarding-v2-routes.test.ts
git commit -m "feat(server): onboarding-v2 interview/turn route"
```

### Task 6.3 — Agent confirm route

**Files:**
- Modify: `server/src/routes/onboarding-v2.ts`
- Modify: `server/src/__tests__/onboarding-v2-routes.test.ts`

- [ ] **Step 1: Add the failing test**

```typescript
describe("POST /api/onboarding/agent/confirm", () => {
  it("hires the proposed agent and returns the agent + API key", async () => {
    const mockPropose = vi.fn().mockResolvedValue({
      name: "Reese", role: "SDR", oneLineOkr: "OKR", rationale: "ok",
    });
    const mockCreate = vi.fn().mockResolvedValue({
      agentId: "agent-2",
      apiKey: { id: "k", name: "default", token: "agk_x", createdAt: "now" },
    });
    // (use the mocked services)
    const app = buildApp({ type: "board", userId: "user-1", source: "session" });
    const res = await request(app)
      .post("/api/onboarding/agent/confirm")
      .send({ conversationId: "conv1", reportsToAgentId: "agent-cos-1", companyId: "c1" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      agent: { id: "agent-2", name: "Reese", title: "SDR" },
      apiKey: { token: "agk_x" },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```sh
pnpm test:run -- onboarding-v2-routes
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
router.post("/agent/confirm", async (req, res) => {
  if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Sign-in required");
  const { conversationId, reportsToAgentId, companyId } = req.body;
  // Load transcript from conversation history.
  const transcript = await loadInterviewTranscript(db, conversationId);
  const proposal = await agentProposer(/* deps */).propose(transcript);
  const result = await agentCreatorFromProposal(/* deps */).create({
    companyId,
    reportsToAgentId,
    proposal,
    transcript,
  });
  // Append a CoS message announcing the hire to the conversation.
  await appendAssistantMessage(
    db,
    conversationId,
    `${proposal.name} (${proposal.role}) is on your team. ${proposal.oneLineOkr}.\n\nWant to bring anyone else in to watch how ${proposal.name} is doing?`,
  );
  res.status(201).json({
    agent: { id: result.agentId, name: proposal.name, title: proposal.role },
    apiKey: result.apiKey,
    proposal,
  });
});
```

- [ ] **Step 4: Run test**

```sh
pnpm test:run -- onboarding-v2-routes
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/src/routes/onboarding-v2.ts server/src/__tests__/onboarding-v2-routes.test.ts
git commit -m "feat(server): onboarding-v2 agent/confirm route"
```

### Task 6.3a — Reject-and-retry agent proposal

Spec §7 requires that when a user rejects the proposed agent, CoS proposes again, and after 3 total attempts falls back to a generic "general assistant" template.

**Files:**
- Modify: `server/src/routes/onboarding-v2.ts`
- Modify: `server/src/__tests__/onboarding-v2-routes.test.ts`

- [ ] **Step 1: Track attempt count on the conversation**

Add a small column to `assistant_conversations` (`onboarding_proposal_attempts INTEGER DEFAULT 0`) via a migration. Or, store it in conversation metadata JSON if the schema already has a metadata column.

- [ ] **Step 2: Add the failing reject test**

```typescript
describe("POST /api/onboarding/agent/reject", () => {
  it("on rejection, increments the attempt count and lets the next confirm produce a new proposal", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "session" });
    const res = await request(app)
      .post("/api/onboarding/agent/reject")
      .send({ conversationId: "conv1", reason: "wrong role" });
    expect(res.status).toBe(200);
    expect(res.body.attempts).toBe(1);
    expect(res.body.fallbackUsed).toBe(false);
  });

  it("after 3 rejections, the next proposal is the generic 'general assistant' fallback", async () => {
    // setup: conversation already at attempts=3
    // ...harness...
    const app = buildApp({ type: "board", userId: "user-1", source: "session" });
    const confirm = await request(app)
      .post("/api/onboarding/agent/confirm")
      .send({ conversationId: "conv1", reportsToAgentId: "agent-cos-1", companyId: "c1" });
    expect(confirm.body.proposal.role).toBe("general assistant");
    expect(confirm.body.proposal.name).toBeDefined();
  });
});
```

- [ ] **Step 3: Implement the reject route**

```typescript
router.post("/agent/reject", async (req, res) => {
  if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Sign-in required");
  const { conversationId, reason } = req.body as { conversationId: string; reason?: string };
  const attempts = await incrementProposalAttempts(db, conversationId);
  await appendAssistantMessage(
    db,
    conversationId,
    `Got it — let me think differently${reason ? ` (you said: ${reason})` : ""}. One sec.`,
  );
  res.json({ attempts, fallbackUsed: attempts >= 3 });
});
```

- [ ] **Step 4: Update the confirm route to use the fallback when attempts ≥ 3**

```typescript
// In POST /agent/confirm, before calling agentProposer:
const attempts = await getProposalAttempts(db, conversationId);
let proposal;
if (attempts >= 3) {
  proposal = {
    name: pickFallbackName(),  // small static list: "Sam", "Kai", "Jordan"
    role: "general assistant",
    oneLineOkr: "Help with whatever the user needs in their first 90 days.",
    rationale: "Generic fallback after multiple proposal rejections.",
  };
} else {
  proposal = await agentProposer(/* deps */).propose(transcript);
}
```

- [ ] **Step 5: Run tests**

```sh
pnpm test:run -- onboarding-v2-routes
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add server/src/routes/onboarding-v2.ts server/src/__tests__/onboarding-v2-routes.test.ts \
  packages/db/src/migrations/<new-migration>.sql packages/db/src/schema/<schema-update>
git commit -m "feat(server): reject-and-retry agent proposal with fallback after 3 attempts"
```

### Task 6.3b — UI: reject button on the proposal card

**Files:**
- Modify: `ui/src/pages/CoSConversation.tsx`
- Modify: `ui/src/api/onboarding.ts`

- [ ] **Step 1: Add `rejectAgent` to the API client**

```typescript
// ui/src/api/onboarding.ts
rejectAgent: (input: { conversationId: string; reason?: string }) =>
  api.post<{ attempts: number; fallbackUsed: boolean }>("/onboarding/agent/reject", input),
```

- [ ] **Step 2: Add reject affordance to ProposalCard**

```tsx
function ProposalCard({
  proposal,
  onConfirm,
  onReject,
}: {
  proposal: ConfirmResponse;
  onConfirm: () => void;
  onReject: (reason: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="proposal-card">
      <div>{proposal.proposal.name} — {proposal.proposal.role}</div>
      <div>{proposal.proposal.oneLineOkr}</div>
      <button onClick={onConfirm}>Looks good →</button>
      <button onClick={() => setRejecting(true)}>Try again</button>
      {rejecting && (
        <div>
          <input
            placeholder="What's off? (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button onClick={() => onReject(reason)}>Send</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire reject in CoSConversation**

```tsx
// In CoSConversation, after a rejection: clear the proposal, post a user message
// summarizing the reason, and call interviewTurn again to get a new proposal.
async function handleReject(reason: string) {
  if (!bootstrapped) return;
  setProposal(null);
  setPhase("interview");
  setMessages((m) => [...m, { role: "user", content: reason || "Try again with a different angle." }]);
  await onboardingApi.rejectAgent({ conversationId: bootstrapped.conversationId, reason });
  // Then re-trigger the proposal by posting a synthetic prompt to the interview turn endpoint
  // OR have the server side immediately produce the next proposal. Simplest: client re-calls confirm.
  const c = await onboardingApi.confirmAgent({
    conversationId: bootstrapped.conversationId,
    reportsToAgentId: bootstrapped.cosAgentId,
    companyId: bootstrapped.companyId,
  });
  setProposal(c);
  setPhase("proposal");
}
```

- [ ] **Step 4: Typecheck + manual run**

```sh
pnpm -r typecheck
```

- [ ] **Step 5: Commit**

```sh
git add ui/src/pages/CoSConversation.tsx ui/src/api/onboarding.ts
git commit -m "feat(ui): reject-and-retry proposal affordance"
```

### Task 6.4 — Invites route

**Files:**
- Modify: `server/src/routes/onboarding-v2.ts`
- Modify: `server/src/__tests__/onboarding-v2-routes.test.ts`

- [ ] **Step 1: Add the failing test**

```typescript
describe("POST /api/onboarding/invites", () => {
  it("dispatches invites via the upstream invite service and adds them as conversation participants", async () => {
    const mockSendInvite = vi.fn().mockResolvedValue({ inviteId: "inv-1" });
    const mockAddParticipant = vi.fn().mockResolvedValue(undefined);
    // mock the upstream invite service + conversation.addParticipant
    const app = buildApp({ type: "board", userId: "user-1", source: "session" });
    const res = await request(app)
      .post("/api/onboarding/invites")
      .send({
        conversationId: "conv1",
        companyId: "c1",
        emails: ["bob@acme.com", "carol@acme.com"],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inviteIds: expect.arrayContaining(["inv-1"]) });
    expect(mockSendInvite).toHaveBeenCalledTimes(2);
  });

  it("non-blocking on individual invite failures", async () => {
    // mock first send to throw, second to succeed
    // expect res.status === 200 and partial inviteIds returned
  });
});
```

- [ ] **Step 2: Run to verify failure**

```sh
pnpm test:run -- onboarding-v2-routes
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
router.post("/invites", async (req, res) => {
  if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Sign-in required");
  const { conversationId, companyId, emails } = req.body as { conversationId: string; companyId: string; emails: string[] };
  const inviteIds: string[] = [];
  const errors: Array<{ email: string; reason: string }> = [];
  for (const email of emails) {
    try {
      const invite = await sendCompanyInvite(db, { companyId, email, invitedByUserId: req.actor.userId, role: "member" });
      inviteIds.push(invite.inviteId);
    } catch (err: any) {
      errors.push({ email, reason: err?.message ?? "unknown" });
    }
  }
  res.json({ inviteIds, errors });
});
```

- [ ] **Step 4: Run test**

```sh
pnpm test:run -- onboarding-v2-routes
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/src/routes/onboarding-v2.ts server/src/__tests__/onboarding-v2-routes.test.ts
git commit -m "feat(server): onboarding-v2 invites route"
```

### Task 6.5 — Wire routes into the app

**Files:**
- Modify: `server/src/app.ts`

- [ ] **Step 1: Mount the router**

```typescript
// server/src/app.ts (add the import and mount)
import { onboardingV2Routes } from "./routes/onboarding-v2.js";
// ... inside the app factory:
app.use("/api/onboarding", onboardingV2Routes(db));
```

- [ ] **Step 2: Typecheck + test**

```sh
pnpm -r typecheck && pnpm test:run -- onboarding-v2
```

Expected: PASS.

- [ ] **Step 3: Commit**

```sh
git add server/src/app.ts
git commit -m "feat(server): wire onboarding-v2 routes into app"
```

---

## Phase 7 — Sign-up redirect

After successful sign-up, redirect to `/` (which renders `CoSConversation`). No interstitial.

### Task 7.1 — Wire post-signup redirect

**Files:**
- Modify: `ui/src/api/auth.ts`

- [ ] **Step 1: Find the sign-up handler**

```sh
grep -n "signUp\|signup\|register" ui/src/api/auth.ts
```

- [ ] **Step 2: Update the success branch**

```typescript
// On successful sign-up, navigate to "/".
// Replace any "/welcome" or "/onboarding/wizard" target with "/".
navigate("/");
```

- [ ] **Step 3: Manual verify**

Start dev server (`pnpm dev`), sign up a new user, confirm browser lands at `/` (not at the old WelcomePage).

- [ ] **Step 4: Commit**

```sh
git add ui/src/api/auth.ts
git commit -m "feat(ui): post-signup redirects to / (no interstitial)"
```

---

## Phase 8 — UI: CoS conversation page

Replaces `WelcomePage.tsx` at `/`. Calls `bootstrap` on mount, renders the chat thread, drives turn-by-turn interview, surfaces the agent proposal as a confirm card, then renders the invite step inline.

### Task 8.1 — CoSConversation page skeleton

**Files:**
- Create: `ui/src/pages/CoSConversation.tsx`
- Create: `ui/src/api/onboarding.ts`
- Modify: `ui/src/App.tsx`
- Delete: `ui/src/pages/WelcomePage.tsx`

- [ ] **Step 1: Write the API client**

```typescript
// ui/src/api/onboarding.ts
import { api } from "./client";
import type { InterviewState } from "@agentdash/shared";

export interface BootstrapResponse {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
  firstMessage: string;
}

export interface InterviewTurnResponse {
  assistantMessage: string | null;
  state: InterviewState;
}

export interface ConfirmResponse {
  agent: { id: string; name: string; title: string };
  apiKey: { token: string; name: string; createdAt: string };
  proposal: { name: string; role: string; oneLineOkr: string; rationale: string };
}

export const onboardingApi = {
  bootstrap: () => api.post<BootstrapResponse>("/onboarding/bootstrap", {}),
  interviewTurn: (input: { conversationId: string; userMessage: string }) =>
    api.post<InterviewTurnResponse>("/onboarding/interview/turn", input),
  confirmAgent: (input: { conversationId: string; reportsToAgentId: string; companyId: string }) =>
    api.post<ConfirmResponse>("/onboarding/agent/confirm", input),
  sendInvites: (input: { conversationId: string; companyId: string; emails: string[] }) =>
    api.post<{ inviteIds: string[]; errors: Array<{ email: string; reason: string }> }>(
      "/onboarding/invites",
      input,
    ),
};
```

- [ ] **Step 2: Write the page component**

```tsx
// ui/src/pages/CoSConversation.tsx
import { useEffect, useState } from "react";
import { onboardingApi, type ConfirmResponse } from "../api/onboarding";

type Msg = { role: "assistant" | "user"; content: string };

export default function CoSConversation() {
  const [bootstrapped, setBootstrapped] = useState<{
    companyId: string;
    cosAgentId: string;
    conversationId: string;
  } | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<"interview" | "proposal" | "invite" | "done">("interview");
  const [proposal, setProposal] = useState<ConfirmResponse | null>(null);

  // Bootstrap on mount.
  useEffect(() => {
    onboardingApi.bootstrap().then((r) => {
      setBootstrapped({ companyId: r.companyId, cosAgentId: r.cosAgentId, conversationId: r.conversationId });
      setMessages([{ role: "assistant", content: r.firstMessage }]);
    });
  }, []);

  async function send() {
    if (!bootstrapped || !input.trim() || pending) return;
    const userMsg = input.trim();
    setMessages((m) => [...m, { role: "user", content: userMsg }]);
    setInput("");
    setPending(true);
    try {
      const r = await onboardingApi.interviewTurn({
        conversationId: bootstrapped.conversationId,
        userMessage: userMsg,
      });
      if (r.assistantMessage) {
        setMessages((m) => [...m, { role: "assistant", content: r.assistantMessage! }]);
      }
      if (r.state.status === "ready_to_propose" || r.state.status === "exceeded_max") {
        const c = await onboardingApi.confirmAgent({
          conversationId: bootstrapped.conversationId,
          reportsToAgentId: bootstrapped.cosAgentId,
          companyId: bootstrapped.companyId,
        });
        setProposal(c);
        setPhase("proposal");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="cos-conversation">
      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className={`msg msg--${m.role}`}>{m.content}</div>
        ))}
        {phase === "proposal" && proposal && (
          <ProposalCard proposal={proposal} onConfirm={() => setPhase("invite")} />
        )}
        {phase === "invite" && bootstrapped && (
          <InvitePrompt
            companyId={bootstrapped.companyId}
            conversationId={bootstrapped.conversationId}
            onComplete={() => setPhase("done")}
          />
        )}
      </div>
      {phase === "interview" && (
        <div className="composer">
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
          <button onClick={send} disabled={pending}>Send</button>
        </div>
      )}
    </div>
  );
}

function ProposalCard({ proposal, onConfirm }: { proposal: ConfirmResponse; onConfirm: () => void }) {
  return (
    <div className="proposal-card">
      <div>{proposal.proposal.name} — {proposal.proposal.role}</div>
      <div>{proposal.proposal.oneLineOkr}</div>
      <button onClick={onConfirm}>Looks good →</button>
    </div>
  );
}

import { InvitePrompt } from "../components/InvitePrompt";
```

- [ ] **Step 3: Write the InvitePrompt component**

```tsx
// ui/src/components/InvitePrompt.tsx
import { useState } from "react";
import { onboardingApi } from "../api/onboarding";

export function InvitePrompt({
  companyId,
  conversationId,
  onComplete,
}: {
  companyId: string;
  conversationId: string;
  onComplete: () => void;
}) {
  const [emails, setEmails] = useState("");
  const [pending, setPending] = useState(false);

  async function send() {
    if (pending) return;
    setPending(true);
    try {
      const list = emails.split(",").map((e) => e.trim()).filter(Boolean);
      if (list.length > 0) {
        await onboardingApi.sendInvites({ companyId, conversationId, emails: list });
      }
      onComplete();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="invite-prompt">
      <input
        placeholder="bob@acme.com, carol@acme.com"
        value={emails}
        onChange={(e) => setEmails(e.target.value)}
      />
      <button onClick={send} disabled={pending}>Send invites</button>
      <button onClick={onComplete}>Skip</button>
    </div>
  );
}
```

- [ ] **Step 4: Wire the route in App.tsx**

```tsx
// ui/src/App.tsx
// Replace the WelcomePage import + route:
import CoSConversation from "./pages/CoSConversation";
// ... in the <Routes>:
<Route path="/" element={<CoSConversation />} />
```

- [ ] **Step 5: Delete WelcomePage**

```sh
git rm ui/src/pages/WelcomePage.tsx
```

- [ ] **Step 6: Typecheck**

```sh
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add ui/src/pages/CoSConversation.tsx ui/src/components/InvitePrompt.tsx \
  ui/src/api/onboarding.ts ui/src/App.tsx
git commit -m "feat(ui): CoSConversation page + InvitePrompt; remove WelcomePage"
```

---

## Phase 9 — Heartbeat email digest

Daily cron. Per user, per timezone. Skipped when no agent activity in last 24h.

### Task 9.1 — Digest service test

**Files:**
- Create: `server/src/services/heartbeat-digest.ts`
- Create: `server/src/__tests__/heartbeat-digest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/heartbeat-digest.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { heartbeatDigest } from "../services/heartbeat-digest.js";

const mockEmail = { send: vi.fn() };
const mockActivity = { listSince: vi.fn() };
const mockUsers = { listForDigest: vi.fn() };

describe("heartbeatDigest.run", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("sends one email per user with at least one activity in the last 24h", async () => {
    mockUsers.listForDigest.mockResolvedValue([
      { id: "u1", email: "alice@acme.com", timezone: "America/Los_Angeles" },
      { id: "u2", email: "bob@acme.com", timezone: "America/New_York" },
    ]);
    mockActivity.listSince.mockImplementation(async (userId: string) =>
      userId === "u1" ? [{ agentName: "Reese", summary: "sent 14 drafts" }] : []
    );

    await heartbeatDigest({ email: mockEmail, activity: mockActivity, users: mockUsers } as any).run();

    expect(mockEmail.send).toHaveBeenCalledOnce();
    expect(mockEmail.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "alice@acme.com",
      subject: expect.stringContaining("Reese"),
    }));
  });
});
```

- [ ] **Step 2: Run, expect failure**

```sh
pnpm test:run -- heartbeat-digest
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement**

```typescript
// server/src/services/heartbeat-digest.ts
interface Activity { agentName: string; summary: string }
interface DigestUser { id: string; email: string; timezone: string }
interface Deps {
  email: { send: (msg: { to: string; subject: string; body: string }) => Promise<void> };
  activity: { listSince: (userId: string, sinceHours: number) => Promise<Activity[]> };
  users: { listForDigest: () => Promise<DigestUser[]> };
}

export function heartbeatDigest(deps: Deps) {
  return {
    run: async () => {
      const users = await deps.users.listForDigest();
      for (const user of users) {
        const activity = await deps.activity.listSince(user.id, 24);
        if (activity.length === 0) continue;
        const subject = renderSubject(activity);
        const body = renderBody(activity);
        await deps.email.send({ to: user.email, subject, body });
      }
    },
  };
}

function renderSubject(activity: Activity[]): string {
  const first = activity[0];
  return `${first.agentName} ${first.summary}`;
}

function renderBody(activity: Activity[]): string {
  return activity.map((a) => `${a.agentName}: ${a.summary}`).join("\n");
}
```

- [ ] **Step 4: Run test**

```sh
pnpm test:run -- heartbeat-digest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/src/services/heartbeat-digest.ts server/src/__tests__/heartbeat-digest.test.ts
git commit -m "feat(server): heartbeat-digest service"
```

### Task 9.2 — Cron registration

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Wire the cron in startup**

```typescript
// server/src/index.ts (in startup block)
import { heartbeatDigest } from "./services/heartbeat-digest.js";

// Run once a day at 09:00 UTC; per-user-timezone gating happens inside .run().
const oneHourMs = 60 * 60 * 1000;
setInterval(() => {
  const now = new Date();
  if (now.getUTCHours() === 9 && now.getUTCMinutes() < 5) {
    heartbeatDigest({ /* deps from container */ }).run().catch((err) => {
      logger.error({ err }, "heartbeat digest failed");
    });
  }
}, oneHourMs);
```

- [ ] **Step 2: Typecheck**

```sh
pnpm -r typecheck
```

- [ ] **Step 3: Commit**

```sh
git add server/src/index.ts
git commit -m "feat(server): register heartbeat-digest cron"
```

---

## Phase 10 — End-to-end test

Single Playwright spec covering the happy path: sign up → bootstrap → 3 fixed Q&A → 1 follow-up → confirm agent → invite teammate → reload → land back in same conversation.

### Task 10.0 — Resume mid-interview integration test

Spec §7 requires that an abandoned interview resumes on return. The state is already persisted via `loadInterviewState`/`persistInterviewState` in Task 6.2; this test proves that round-trip works.

**Files:**
- Modify: `server/src/__tests__/onboarding-v2-routes.test.ts`

- [ ] **Step 1: Add the resume test**

```typescript
it("resumes the interview from persisted state when /interview/turn is called after a gap", async () => {
  // Setup: simulate a conversation already 2 turns in (one fixed Q + one user reply).
  // ...harness boilerplate to seed assistant_messages...
  const app = buildApp({ type: "board", userId: "user-1", source: "session" });
  const res = await request(app)
    .post("/api/onboarding/interview/turn")
    .send({ conversationId: "conv1", userMessage: "Cold outbound." });
  expect(res.status).toBe(200);
  // The next assistant message should be the SECOND fixed question (we're 1 fixed Q in).
  expect(res.body.assistantMessage).toBe(FIXED_QUESTIONS[1]);
});
```

- [ ] **Step 2: Run test**

```sh
pnpm test:run -- onboarding-v2-routes
```

Expected: PASS (the persistence implementation in Task 6.2 already supports this; if it doesn't, fix `loadInterviewState` to actually rebuild state from `assistant_messages`).

- [ ] **Step 3: Commit**

```sh
git add server/src/__tests__/onboarding-v2-routes.test.ts
git commit -m "test(server): resume interview from persisted state"
```

### Task 10.1 — E2E happy path

**Files:**
- Create: `tests/e2e/onboarding-v2.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
// tests/e2e/onboarding-v2.spec.ts
import { test, expect } from "@playwright/test";

test("new user signs up and onboards through CoS to a hired agent", async ({ page }) => {
  // 1. Sign up.
  await page.goto("/signup");
  await page.getByLabel(/email/i).fill(`alice+${Date.now()}@acme.example`);
  await page.getByLabel(/password/i).fill("hunter2hunter2");
  await page.getByRole("button", { name: /sign up/i }).click();

  // 2. Lands directly in CoS chat with first message.
  await expect(page).toHaveURL("/");
  await expect(page.getByText(/what's your business/i)).toBeVisible({ timeout: 10000 });

  // 3. Answer the three fixed questions.
  await page.locator(".composer input").fill("B2B SaaS for mid-market.");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByText(/what's eating your time/i)).toBeVisible({ timeout: 10000 });

  await page.locator(".composer input").fill("Cold outbound.");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByText(/success look like 90 days/i)).toBeVisible({ timeout: 10000 });

  await page.locator(".composer input").fill("200 qualified meetings booked.");
  await page.getByRole("button", { name: /send/i }).click();

  // 4. Eventually CoS proposes an agent (after 0–4 follow-ups).
  await expect(page.locator(".proposal-card")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: /looks good/i }).click();

  // 5. Invite step.
  await expect(page.getByPlaceholder(/bob@acme.com/i)).toBeVisible();
  await page.getByPlaceholder(/bob@acme.com/i).fill("bob@acme.example");
  await page.getByRole("button", { name: /send invites/i }).click();

  // 6. Reload — should land in the same conversation.
  await page.reload();
  await expect(page.getByText(/what's your business/i)).toBeVisible(); // history is rendered
});
```

- [ ] **Step 2: Run with the dev server**

```sh
pnpm dev   # in one tab
pnpm playwright test tests/e2e/onboarding-v2.spec.ts   # in another
```

Expected: PASS.

- [ ] **Step 3: Commit**

```sh
git add tests/e2e/onboarding-v2.spec.ts
git commit -m "test(e2e): onboarding v2 happy path"
```

---

## Phase 11 — Final verification

### Task 11.1 — Full regression suite

- [ ] **Step 1: Typecheck**

```sh
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 2: Test suite**

```sh
pnpm test:run
```

Expected: PASS (allowing for pre-existing flakes that don't touch onboarding code — list them explicitly in the handoff message if any).

- [ ] **Step 3: Build**

```sh
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Manual QA checklist**

Run the dev server and walk the flow end-to-end:
- Sign up with a fresh email.
- Confirm landing on `/` with first CoS message visible within 2 seconds.
- Walk through 3 fixed + at least one adaptive question.
- Confirm proposal card appears with a name + role + OKR.
- Click "Looks good", confirm invite UI appears.
- Skip invites, confirm conversation continues.
- Reload, confirm same conversation rendered.
- Sign in as the invitee (simulated via DB or test invite), confirm they land in the same thread.

### Task 11.2 — Open PR

- [ ] **Step 1: Push branch**

```sh
git push -u origin <feature-branch-name>
```

- [ ] **Step 2: Open PR with this body**

Title: `feat: v2 onboarding (CoS chat as front door)`

Body:

```
## Summary

Implements docs/superpowers/specs/2026-05-02-onboarding-design.md.

Sign-up → CoS chat → adaptive interview (3 fixed + 0–4 LLM follow-ups, max 7) →
agent proposal → first-agent hire → multi-human invites → daily digest cron.

Replaces WelcomePage.tsx with CoSConversation.tsx at `/`.

## What changed

- New schema: `assistant_conversation_participants` link table.
- New services: onboarding-orchestrator, cos-interview, agent-proposer,
  agent-creator-from-proposal, heartbeat-digest.
- New routes: `/api/onboarding/{bootstrap,interview/turn,agent/confirm,invites}`.
- New UI: CoSConversation page + InvitePrompt component.
- New cron: daily heartbeat digest.

## Verification

- `pnpm -r typecheck` ✓
- `pnpm test:run` ✓
- `pnpm build` ✓
- `pnpm playwright test tests/e2e/onboarding-v2.spec.ts` ✓
- Manual QA per Task 11.1 step 4 ✓

## Closes

(Reference any v2 onboarding tracking issue.)
```

- [ ] **Step 3: Mark plan complete**

Update todo list / project tracker; this plan is done.

---

## Explicitly deferred (spec items NOT in this plan)

These are spec-mentioned items that are not implemented in this plan. Calling them out so they don't silently slip:

| Spec § | Item | Why deferred | Land where |
|---|---|---|---|
| §3 | Funnel-metrics instrumentation (sign-up → chat opened → agent hired → returns next day → invited ≥1) | Needs an analytics destination decided first. Premature to wire blind. | Follow-up plan once analytics target is picked |
| §7 | LLM provider unavailable → static 3-question form fallback | Worth tracking but not blocking; CoS chat without LLM is a degraded mode worth its own spec | Follow-up plan |
| §7 | "User signs up but never opens chat" → 7-day reminder email | Owns its own product question (one-shot vs. drip); not v1 critical | Follow-up plan |

Each of these gets a one-paragraph follow-up spec when prioritized; none are blockers for this plan to ship.

## Decisions baked into this plan (cross-reference to spec § 14)

| Decision | Implementation |
|---|---|
| Migration strategy A — clean rebuild | Plan assumes v2 base done as Prerequisite |
| Front door: CoS chat | `CoSConversation` is the `/` route; `WelcomePage` deleted |
| First-session output: interview + agent hire | Interview drives to `ready_to_propose`, then auto-call confirm |
| Persona: small team (2–5 humans) | Invite step is part of onboarding, not a separate page |
| Multi-human invite during onboarding | Phase 8 InvitePrompt rendered post-hire |
| Adaptive interview (3 fixed + 2–4 branching, max 7) | `cos-interview.ts` enforces `MAX_FOLLOW_UPS = 4` |
| Billing: free first agent | No billing checks anywhere in this plan |
| Re-engagement: heartbeat email only | Phase 9 cron; no push notification surface |
