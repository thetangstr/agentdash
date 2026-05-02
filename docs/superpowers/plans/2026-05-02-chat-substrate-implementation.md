# Chat substrate implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement [docs/superpowers/specs/2026-05-02-chat-substrate-design.md](../specs/2026-05-02-chat-substrate-design.md) — multi-human + CoS chat with @-mention summoning, structured cards, real-time delivery, and per-participant read state.

**Architecture:** Lean on the v1 `assistant_conversations`/`assistant_messages` schema carried forward in the v2 base migration. Add `card_kind`/`card_payload` columns on messages, `last_read_message_id` on participants, plus a `assistant_conversation_participants` link table (shared with onboarding spec — this plan owns the migration). Build mention-parser, agent-summoner, cos-replier, activity-router, cos-proactive as new modules. Routes wrap the services; WS bus is reused from upstream `realtime/`. Chat panel UI replaces v1.

**Tech Stack:** TypeScript, Node 20, Express, Drizzle ORM, PostgreSQL, React 19, WebSocket bus (upstream paperclip's existing `realtime/`), Anthropic SDK, Vitest, Playwright.

---

## Prerequisites

- [ ] v2 base migration plan complete (see [v2-base-migration-implementation.md](./2026-05-02-v2-base-migration-implementation.md)).
- [ ] Specifically: `assistant_conversations` and `assistant_messages` schema ported.
- [ ] Anthropic SDK + `ANTHROPIC_API_KEY` available.
- [ ] Upstream `realtime/` WS bus operational.

---

## File Structure

**Created:**
| File | Responsibility |
|---|---|
| `packages/db/src/schema/assistant_conversation_participants.ts` | Link table with `last_read_message_id` |
| `packages/db/src/migrations/0072_chat_substrate.sql` | Adds participants table + `card_kind`/`card_payload` cols on messages |
| `server/src/services/mention-parser.ts` | Pure function: text + agent dir → mentions |
| `server/src/services/agent-summoner.ts` | One-shot agent reply on @-mention |
| `server/src/services/cos-replier.ts` | CoS reply when no mention present |
| `server/src/services/activity-router.ts` | Filter agent.activity for chat-worthiness |
| `server/src/services/cos-proactive.ts` | Post agent_status_v1 cards on chat-worthy events |
| `server/src/routes/conversations.ts` | REST endpoints for messages, read, participants |
| `server/src/realtime/conversation-events.ts` | WS event publishing for `message.created`, `message.read` |
| `ui/src/pages/ChatPanel.tsx` | Main chat surface |
| `ui/src/components/MessageList.tsx` | Renders messages with grouping |
| `ui/src/components/Composer.tsx` | Textarea + @-mention typeahead |
| `ui/src/components/cards/ProposalCard.tsx` | proposal_card_v1 renderer |
| `ui/src/components/cards/InvitePrompt.tsx` | invite_prompt_v1 renderer |
| `ui/src/components/cards/AgentStatusCard.tsx` | agent_status_v1 renderer |
| `ui/src/components/cards/InterviewQuestion.tsx` | interview_question_v1 renderer |
| `ui/src/api/conversations.ts` | Frontend client |
| `ui/src/realtime/useMessages.ts` | WS subscription hook |
| `server/src/__tests__/mention-parser.test.ts` | Unit tests |
| `server/src/__tests__/agent-summoner.test.ts` | Unit tests with mocked adapter |
| `server/src/__tests__/cos-replier.test.ts` | Unit tests with mocked LLM |
| `server/src/__tests__/activity-router.test.ts` | Filter tests |
| `server/src/__tests__/conversations-routes.test.ts` | Integration tests |
| `tests/e2e/chat-multi-human.spec.ts` | Two-browser Playwright |

**Modified:**
| File | Change |
|---|---|
| `packages/db/src/schema/assistant.ts` | Add `card_kind`, `card_payload` columns to `assistant_messages` |
| `packages/db/src/schema/index.ts` | Export new tables/columns |
| `server/src/services/assistant.ts` (carried forward) | Add `addParticipant`, `setReadPointer`, `findByCompany`, message-with-card overload |
| `server/src/app.ts` | Mount conversation routes |

---

## Phase 1 — Schema additions

### Task 1.1 — Participants table + message card columns

**Files:**
- Create: `packages/db/src/schema/assistant_conversation_participants.ts`
- Modify: `packages/db/src/schema/assistant.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the failing schema test**

```typescript
// packages/db/src/__tests__/chat-substrate-schema.test.ts
import { describe, it, expect } from "vitest";
import { assistantConversationParticipants } from "../schema/assistant_conversation_participants.js";
import { assistantMessages } from "../schema/assistant.js";

describe("chat substrate schema", () => {
  it("participants table has the required columns", () => {
    const cols = Object.keys(assistantConversationParticipants);
    for (const c of ["id", "conversationId", "userId", "role", "joinedAt", "lastReadMessageId"]) {
      expect(cols).toContain(c);
    }
  });

  it("messages table has card columns", () => {
    const cols = Object.keys(assistantMessages);
    expect(cols).toContain("cardKind");
    expect(cols).toContain("cardPayload");
  });
});
```

- [ ] **Step 2: Run, expect failure**

```sh
pnpm test:run -- chat-substrate-schema
```

- [ ] **Step 3: Add the participants schema**

```typescript
// packages/db/src/schema/assistant_conversation_participants.ts
import { pgTable, uuid, varchar, timestamp, index, unique } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { assistantConversations, assistantMessages } from "./assistant.js";

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
    lastReadMessageId: uuid("last_read_message_id").references(() => assistantMessages.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    unique("acp_conversation_user_unique").on(table.conversationId, table.userId),
    index("acp_conversation_idx").on(table.conversationId),
    index("acp_user_idx").on(table.userId),
  ],
);
```

- [ ] **Step 4: Add card columns to messages**

In `packages/db/src/schema/assistant.ts`, add to the `assistantMessages` table:

```typescript
cardKind: varchar("card_kind", { length: 32 }),
cardPayload: jsonb("card_payload"),
```

Make sure `jsonb` is imported from `drizzle-orm/pg-core`.

- [ ] **Step 5: Re-export**

Add to `packages/db/src/schema/index.ts`:

```typescript
export * from "./assistant_conversation_participants.js";
```

- [ ] **Step 6: Run schema test**

```sh
pnpm test:run -- chat-substrate-schema
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add packages/db/src/schema/assistant_conversation_participants.ts \
  packages/db/src/schema/assistant.ts packages/db/src/schema/index.ts \
  packages/db/src/__tests__/chat-substrate-schema.test.ts
git commit -m "feat(db): chat substrate schema (participants + card columns)"
```

### Task 1.2 — Generate + apply migration

- [ ] **Step 1: Generate**

```sh
pnpm db:generate
```

- [ ] **Step 2: Inspect SQL**

The generated `0072_*.sql` should include `CREATE TABLE assistant_conversation_participants` plus `ALTER TABLE assistant_messages ADD COLUMN card_kind`, `... card_payload`. Verify both.

- [ ] **Step 3: Apply**

```sh
pnpm db:migrate
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```sh
git add packages/db/src/migrations/
git commit -m "feat(db): generate chat substrate migration"
```

---

## Phase 2 — Conversation + message services (extend v1 carry-forward)

### Task 2.1 — `addParticipant` + `setReadPointer` + `findByCompany`

**Files:**
- Modify: `server/src/services/assistant.ts`
- Create: `server/src/__tests__/assistant-extensions.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// server/src/__tests__/assistant-extensions.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { assistantService } from "../services/assistant.js";
// (use the test DB harness pattern from existing server tests)

describe("assistantService extensions", () => {
  it("findByCompany returns the single conversation for a company, null otherwise", async () => {
    const svc = assistantService(db);
    expect(await svc.findByCompany(companyId)).toBeNull();
    const conv = await svc.create({ companyId });
    expect(await svc.findByCompany(companyId)).toMatchObject({ id: conv.id });
  });

  it("addParticipant is idempotent on (conversation, user) unique key", async () => {
    const svc = assistantService(db);
    const conv = await svc.create({ companyId });
    await svc.addParticipant(conv.id, userId, "owner");
    await svc.addParticipant(conv.id, userId, "owner");
    const ps = await svc.listParticipants(conv.id);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ userId, role: "owner" });
  });

  it("setReadPointer updates last_read_message_id for the participant", async () => {
    const svc = assistantService(db);
    const conv = await svc.create({ companyId });
    await svc.addParticipant(conv.id, userId, "owner");
    const msg = await svc.postMessage({
      conversationId: conv.id, authorKind: "user", authorId: userId, body: "hi",
    });
    await svc.setReadPointer(conv.id, userId, msg.id);
    const ps = await svc.listParticipants(conv.id);
    expect(ps[0].lastReadMessageId).toBe(msg.id);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```sh
pnpm test:run -- assistant-extensions
```

- [ ] **Step 3: Implement methods**

In `server/src/services/assistant.ts`, add these to the service factory:

```typescript
findByCompany: async (companyId: string) =>
  db.select().from(assistantConversations)
    .where(eq(assistantConversations.companyId, companyId))
    .orderBy(asc(assistantConversations.createdAt))
    .then(rows => rows[0] ?? null),

addParticipant: async (
  conversationId: string,
  userId: string,
  role: "owner" | "member" = "member",
) => {
  await db.insert(assistantConversationParticipants)
    .values({ conversationId, userId, role })
    .onConflictDoNothing({
      target: [
        assistantConversationParticipants.conversationId,
        assistantConversationParticipants.userId,
      ],
    });
},

listParticipants: (conversationId: string) =>
  db.select().from(assistantConversationParticipants)
    .where(eq(assistantConversationParticipants.conversationId, conversationId)),

setReadPointer: async (
  conversationId: string,
  userId: string,
  lastReadMessageId: string,
) => {
  await db.update(assistantConversationParticipants)
    .set({ lastReadMessageId })
    .where(and(
      eq(assistantConversationParticipants.conversationId, conversationId),
      eq(assistantConversationParticipants.userId, userId),
    ));
},
```

- [ ] **Step 4: Run tests**

```sh
pnpm test:run -- assistant-extensions
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/src/services/assistant.ts \
  server/src/__tests__/assistant-extensions.test.ts
git commit -m "feat(server): assistant service extensions (participants, read pointer)"
```

### Task 2.2 — `postMessage` with card support

**Files:**
- Modify: `server/src/services/assistant.ts`
- Modify: `server/src/__tests__/assistant-extensions.test.ts`

- [ ] **Step 1: Add the failing card test**

```typescript
it("postMessage stores card_kind + card_payload when provided", async () => {
  const svc = assistantService(db);
  const conv = await svc.create({ companyId });
  const msg = await svc.postMessage({
    conversationId: conv.id,
    authorKind: "agent",
    authorId: cosAgentId,
    body: "Reese — SDR. 90-day goal: 200 meetings.",
    cardKind: "proposal_card_v1",
    cardPayload: { name: "Reese", role: "SDR", oneLineOkr: "200 meetings", rationale: "ok" },
  });
  expect(msg.cardKind).toBe("proposal_card_v1");
  expect(msg.cardPayload).toMatchObject({ name: "Reese" });
});
```

- [ ] **Step 2: Implement** by extending the existing `postMessage` to accept optional `cardKind` + `cardPayload` and persist them. (Show the exact insert builder addition.)

```typescript
postMessage: async (input: {
  conversationId: string;
  authorKind: "user" | "agent";
  authorId: string;
  body: string;
  cardKind?: string | null;
  cardPayload?: Record<string, unknown> | null;
}) => {
  const [row] = await db.insert(assistantMessages).values({
    conversationId: input.conversationId,
    authorKind: input.authorKind,
    authorId: input.authorId,
    body: input.body,
    cardKind: input.cardKind ?? null,
    cardPayload: input.cardPayload ?? null,
  }).returning();
  return row;
},
```

- [ ] **Step 3: Run + commit**

```sh
pnpm test:run -- assistant-extensions
git add server/src/services/assistant.ts server/src/__tests__/assistant-extensions.test.ts
git commit -m "feat(server): postMessage with card payload support"
```

---

## Phase 3 — Mention parser

Pure function. No DB, no LLM. Lives in `packages/shared` so both server and UI typeahead can use it.

### Task 3.1 — Mention parser

**Files:**
- Create: `packages/shared/src/mention-parser.ts`
- Create: `packages/shared/src/__tests__/mention-parser.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Define the type**

```typescript
// packages/shared/src/mention-parser.ts
export interface AgentDirEntry { id: string; name: string; role: string }
export interface Mention { agentId: string | null; matchText: string; startIndex: number; ambiguous?: boolean }

export function parseMentions(text: string, dir: AgentDirEntry[]): Mention[] {
  const mentions: Mention[] = [];
  // Skip mentions inside code spans (`...`) and code blocks (```...```).
  const codeBlockRanges = findCodeRanges(text);
  const re = /@([A-Za-z][A-Za-z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (codeBlockRanges.some(([s, e]) => match!.index >= s && match!.index < e)) continue;
    const token = match[1].toLowerCase();
    // Try name match first.
    const byName = dir.filter(a => a.name.toLowerCase() === token);
    if (byName.length === 1) {
      mentions.push({ agentId: byName[0].id, matchText: match[0], startIndex: match.index });
      continue;
    }
    if (byName.length > 1) {
      mentions.push({ agentId: null, matchText: match[0], startIndex: match.index, ambiguous: true });
      continue;
    }
    // Then role match.
    const byRole = dir.filter(a => a.role.toLowerCase() === token);
    if (byRole.length === 1) {
      mentions.push({ agentId: byRole[0].id, matchText: match[0], startIndex: match.index });
    } else if (byRole.length > 1) {
      mentions.push({ agentId: null, matchText: match[0], startIndex: match.index, ambiguous: true });
    } else {
      mentions.push({ agentId: null, matchText: match[0], startIndex: match.index });
    }
  }
  return mentions;
}

function findCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fenced = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
```

- [ ] **Step 2: Write tests**

```typescript
// packages/shared/src/__tests__/mention-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseMentions } from "../mention-parser.js";

const dir = [
  { id: "a1", name: "Reese", role: "SDR" },
  { id: "a2", name: "Mira", role: "SDR" },
  { id: "a3", name: "Theo", role: "ops coordinator" },
];

describe("parseMentions", () => {
  it("resolves a unique name mention", () => {
    const mentions = parseMentions("hey @reese can you check this?", dir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({ agentId: "a1", matchText: "@reese" });
  });

  it("flags ambiguous role mention", () => {
    const mentions = parseMentions("@SDR what's our pipeline?", dir);
    expect(mentions[0].ambiguous).toBe(true);
    expect(mentions[0].agentId).toBeNull();
  });

  it("returns no agentId for unknown mention", () => {
    const mentions = parseMentions("@unknown person", dir);
    expect(mentions[0].agentId).toBeNull();
    expect(mentions[0].ambiguous).toBeUndefined();
  });

  it("ignores mentions inside code blocks", () => {
    expect(parseMentions("```\n@reese\n```", dir)).toEqual([]);
    expect(parseMentions("look at `@reese` placeholder", dir)).toEqual([]);
  });

  it("returns multiple mentions in order", () => {
    const mentions = parseMentions("@reese and @theo, please coordinate", dir);
    expect(mentions).toHaveLength(2);
    expect(mentions[0].agentId).toBe("a1");
    expect(mentions[1].agentId).toBe("a3");
  });
});
```

- [ ] **Step 3: Run tests**

```sh
pnpm test:run -- mention-parser
```

Expected: PASS.

- [ ] **Step 4: Re-export + commit**

Add to `packages/shared/src/index.ts`:

```typescript
export * from "./mention-parser.js";
```

```sh
git add packages/shared/src/mention-parser.ts \
  packages/shared/src/__tests__/mention-parser.test.ts \
  packages/shared/src/index.ts
git commit -m "feat(shared): mention parser"
```

---

## Phase 4 — CoS replier

### Task 4.1 — CoS replier with mocked LLM

**Files:**
- Create: `server/src/services/cos-replier.ts`
- Create: `server/src/__tests__/cos-replier.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { cosReplier } from "../services/cos-replier.js";

const mockLlm = vi.fn();
const mockMessages = { paginate: vi.fn(), postMessage: vi.fn() };

describe("cosReplier.reply", () => {
  it("loads last 20 messages, calls LLM, posts the reply authored by CoS", async () => {
    mockMessages.paginate.mockResolvedValue([
      { role: "user", body: "What's our outbound volume?" },
    ]);
    mockLlm.mockResolvedValue("Outbound volume sits around 80/week today.");
    mockMessages.postMessage.mockResolvedValue({ id: "m1" });

    await cosReplier({ messages: mockMessages, llm: mockLlm } as any).reply({
      conversationId: "conv1",
      cosAgentId: "cos1",
    });

    expect(mockMessages.paginate).toHaveBeenCalledWith("conv1", { limit: 20 });
    expect(mockLlm).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.any(Array),
    }));
    expect(mockMessages.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv1", authorKind: "agent", authorId: "cos1",
      body: "Outbound volume sits around 80/week today.",
    }));
  });
});
```

- [ ] **Step 2: Run, expect failure**

```sh
pnpm test:run -- cos-replier
```

- [ ] **Step 3: Implement**

```typescript
// server/src/services/cos-replier.ts
interface Deps {
  messages: any;
  llm: (input: { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> }) => Promise<string>;
}

const COS_SYSTEM_PROMPT = `You are the Chief of Staff in an AgentDash workspace. Be warm, concise, and specific. When a human asks about an agent's progress, answer based on the conversation history. If you don't have the data, say so plainly. No greetings, no preamble, no markdown headings.`;

export function cosReplier(deps: Deps) {
  return {
    reply: async (input: { conversationId: string; cosAgentId: string }) => {
      const recent = await deps.messages.paginate(input.conversationId, { limit: 20 });
      const messages = recent.reverse().map((m: any) => ({
        role: m.authorKind === "agent" ? "assistant" : "user",
        content: m.body,
      }));
      const text = await deps.llm({ system: COS_SYSTEM_PROMPT, messages });
      return deps.messages.postMessage({
        conversationId: input.conversationId,
        authorKind: "agent",
        authorId: input.cosAgentId,
        body: text,
      });
    },
  };
}
```

- [ ] **Step 4: Run + commit**

```sh
pnpm test:run -- cos-replier
git add server/src/services/cos-replier.ts server/src/__tests__/cos-replier.test.ts
git commit -m "feat(server): cos-replier service"
```

---

## Phase 5 — Agent summoner

### Task 5.1 — Agent summoner

**Files:**
- Create: `server/src/services/agent-summoner.ts`
- Create: `server/src/__tests__/agent-summoner.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { agentSummoner } from "../services/agent-summoner.js";

const mockMessages = { paginate: vi.fn(), postMessage: vi.fn() };
const mockAgents = { getById: vi.fn() };
const mockAdapter = { execute: vi.fn() };

describe("agentSummoner.summon", () => {
  it("loads context, runs adapter, posts reply authored by the summoned agent", async () => {
    mockMessages.paginate.mockResolvedValue([{ authorKind: "user", body: "What's status?" }]);
    mockAgents.getById.mockResolvedValue({ id: "a1", name: "Reese", adapterType: "claude_local", adapterConfig: {} });
    mockAdapter.execute.mockResolvedValue({ output: "I have 12 drafts ready, 3 sent." });
    mockMessages.postMessage.mockResolvedValue({ id: "m1" });

    await agentSummoner({
      messages: mockMessages, agents: mockAgents, adapterFor: () => mockAdapter,
    } as any).summon({
      conversationId: "conv1", agentId: "a1", triggeringMessageId: "u1",
    });

    expect(mockAdapter.execute).toHaveBeenCalled();
    expect(mockMessages.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv1", authorKind: "agent", authorId: "a1",
      body: "I have 12 drafts ready, 3 sent.",
    }));
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// server/src/services/agent-summoner.ts
interface Deps {
  messages: any;
  agents: any;
  adapterFor: (adapterType: string) => any;
}

export function agentSummoner(deps: Deps) {
  return {
    summon: async (input: { conversationId: string; agentId: string; triggeringMessageId: string }) => {
      const recent = await deps.messages.paginate(input.conversationId, { limit: 20 });
      const agent = await deps.agents.getById(input.agentId);
      if (!agent) throw new Error(`Agent ${input.agentId} not found`);
      const adapter = deps.adapterFor(agent.adapterType);
      const result = await adapter.execute({
        agent,
        prompt: buildSummonPrompt(recent),
      });
      return deps.messages.postMessage({
        conversationId: input.conversationId,
        authorKind: "agent",
        authorId: agent.id,
        body: result.output,
      });
    },
  };
}

function buildSummonPrompt(recent: any[]): string {
  const transcript = recent.reverse().map((m) =>
    `${m.authorKind === "agent" ? "AGENT" : "USER"}: ${m.body}`
  ).join("\n");
  return `You were just @-mentioned in a team chat. Read the recent conversation, answer the question or task addressed to you, and stop. Do not start your reply with greetings.\n\nRecent conversation:\n${transcript}`;
}
```

- [ ] **Step 3: Run + commit**

```sh
pnpm test:run -- agent-summoner
git add server/src/services/agent-summoner.ts server/src/__tests__/agent-summoner.test.ts
git commit -m "feat(server): agent-summoner service"
```

---

## Phase 6 — Activity router + proactive CoS

### Task 6.1 — Activity router

**Files:**
- Create: `server/src/services/activity-router.ts`
- Create: `server/src/__tests__/activity-router.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { activityRouter } from "../services/activity-router.js";

describe("activityRouter.classify", () => {
  it("returns chat-worthy for task_completed", () => {
    const r = activityRouter().classify({ kind: "task_completed", agentId: "a1", payload: { title: "Drafted email" } });
    expect(r).toMatchObject({ chatWorthy: true, summary: expect.stringContaining("Drafted email") });
  });
  it("returns chat-worthy for blocker_raised", () => {
    expect(activityRouter().classify({ kind: "blocker_raised", agentId: "a1", payload: { reason: "API down" } }).chatWorthy).toBe(true);
  });
  it("drops heartbeat ticks", () => {
    expect(activityRouter().classify({ kind: "heartbeat_tick", agentId: "a1" }).chatWorthy).toBe(false);
  });
  it("drops noisy log lines", () => {
    expect(activityRouter().classify({ kind: "log", agentId: "a1" }).chatWorthy).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// server/src/services/activity-router.ts
type ActivityKind = "task_completed" | "blocker_raised" | "heartbeat_tick" | "log" | "approval_requested" | "agent_paused";

interface Activity { kind: string; agentId: string; payload?: Record<string, unknown> }
interface Classification { chatWorthy: boolean; summary?: string; severity?: "info" | "warn" | "blocked" }

const CHAT_WORTHY: Set<string> = new Set([
  "task_completed", "blocker_raised", "approval_requested", "agent_paused",
]);

export function activityRouter() {
  return {
    classify: (a: Activity): Classification => {
      if (!CHAT_WORTHY.has(a.kind)) return { chatWorthy: false };
      const summary = summarize(a);
      const severity = a.kind === "blocker_raised" ? "blocked" : a.kind === "agent_paused" ? "warn" : "info";
      return { chatWorthy: true, summary, severity };
    },
  };
}

function summarize(a: Activity): string {
  const p = a.payload ?? {};
  switch (a.kind) {
    case "task_completed": return `${p.title ?? "Completed a task"}.`;
    case "blocker_raised": return `Blocked: ${p.reason ?? "unknown"}.`;
    case "approval_requested": return `Needs approval: ${p.title ?? "action"}.`;
    case "agent_paused": return `Paused (${p.reason ?? "manual"}).`;
    default: return "Update.";
  }
}
```

- [ ] **Step 3: Run + commit**

```sh
pnpm test:run -- activity-router
git add server/src/services/activity-router.ts server/src/__tests__/activity-router.test.ts
git commit -m "feat(server): activity-router for chat-worthy event filtering"
```

### Task 6.2 — CoS proactive subscriber

**Files:**
- Create: `server/src/services/cos-proactive.ts`
- Create: `server/src/__tests__/cos-proactive.test.ts`

- [ ] **Step 1: Test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { cosProactive } from "../services/cos-proactive.js";

describe("cosProactive.onActivity", () => {
  it("posts an agent_status_v1 card authored by CoS for chat-worthy events", async () => {
    const mockPost = vi.fn().mockResolvedValue({ id: "m1" });
    const mockAgents = { getById: vi.fn().mockResolvedValue({ id: "a1", name: "Reese" }) };
    const mockConvSvc = { findByCompany: vi.fn().mockResolvedValue({ id: "conv1" }) };
    const mockCos = { findByCompany: vi.fn().mockResolvedValue({ id: "cos1" }) };

    await cosProactive({
      messages: { postMessage: mockPost },
      agents: mockAgents,
      conversations: mockConvSvc,
      cosResolver: mockCos,
      router: { classify: () => ({ chatWorthy: true, summary: "Drafted email", severity: "info" }) },
    } as any).onActivity({ kind: "task_completed", agentId: "a1", companyId: "c1" });

    expect(mockPost).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv1",
      authorKind: "agent",
      authorId: "cos1",
      cardKind: "agent_status_v1",
      cardPayload: expect.objectContaining({ agentId: "a1", agentName: "Reese", summary: "Drafted email", severity: "info" }),
    }));
  });

  it("does nothing for non-chat-worthy events", async () => {
    const mockPost = vi.fn();
    await cosProactive({
      messages: { postMessage: mockPost }, agents: {}, conversations: {},
      cosResolver: {},
      router: { classify: () => ({ chatWorthy: false }) },
    } as any).onActivity({ kind: "heartbeat_tick", agentId: "a1", companyId: "c1" });
    expect(mockPost).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// server/src/services/cos-proactive.ts
interface Deps {
  messages: any;
  agents: any;
  conversations: { findByCompany: (companyId: string) => Promise<any> };
  cosResolver: { findByCompany: (companyId: string) => Promise<any> };
  router: { classify: (a: any) => { chatWorthy: boolean; summary?: string; severity?: string } };
}

export function cosProactive(deps: Deps) {
  return {
    onActivity: async (event: { kind: string; agentId: string; companyId: string; payload?: any }) => {
      const c = deps.router.classify(event);
      if (!c.chatWorthy) return;
      const [conv, agent, cos] = await Promise.all([
        deps.conversations.findByCompany(event.companyId),
        deps.agents.getById(event.agentId),
        deps.cosResolver.findByCompany(event.companyId),
      ]);
      if (!conv || !cos) return;
      await deps.messages.postMessage({
        conversationId: conv.id,
        authorKind: "agent",
        authorId: cos.id,
        body: `${agent.name}: ${c.summary}`,
        cardKind: "agent_status_v1",
        cardPayload: {
          agentId: agent.id,
          agentName: agent.name,
          summary: c.summary,
          severity: c.severity,
        },
      });
    },
  };
}
```

- [ ] **Step 3: Run + commit**

```sh
pnpm test:run -- cos-proactive
git add server/src/services/cos-proactive.ts server/src/__tests__/cos-proactive.test.ts
git commit -m "feat(server): cos-proactive subscriber"
```

### Task 6.3 — Wire cos-proactive into the activity bus

**Files:**
- Modify: `server/src/index.ts` (or wherever the activity bus is initialized)

- [ ] **Step 1: Subscribe on startup**

```typescript
// On startup, after services are wired:
import { cosProactive } from "./services/cos-proactive.js";
const proactive = cosProactive({ /* wire deps */ });
activityBus.subscribe("agent.activity", (event) => {
  proactive.onActivity(event).catch((err) => logger.error({ err }, "cos-proactive failed"));
});
```

- [ ] **Step 2: Manual smoke test**

Trigger an `agent.activity` `task_completed` event (e.g., from a test agent run); confirm an `agent_status_v1` card appears in the conversation.

- [ ] **Step 3: Commit**

```sh
git add server/src/index.ts
git commit -m "feat(server): subscribe cos-proactive to activity bus"
```

---

## Phase 7 — Conversation routes

### Task 7.1 — `POST /messages` + dispatch

**Files:**
- Create: `server/src/routes/conversations.ts`
- Create: `server/src/__tests__/conversations-routes.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { conversationRoutes } from "../routes/conversations.js";

const mockSvc = {
  postMessage: vi.fn(),
  paginate: vi.fn(),
  setReadPointer: vi.fn(),
  listParticipants: vi.fn(),
};
const mockMentionDispatch = vi.fn();
const mockCosDispatch = vi.fn();

vi.mock("../services/index.js", () => ({
  assistantService: () => mockSvc,
  dispatchOnMessage: (...a: unknown[]) => mockMentionDispatch(...a), // façade
}));

function buildApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.actor = actor; next(); });
  app.use("/api/conversations", conversationRoutes({} as any));
  return app;
}

describe("POST /api/conversations/:id/messages", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("stores the message and triggers downstream dispatch", async () => {
    mockSvc.postMessage.mockResolvedValue({ id: "m1" });
    const app = buildApp({ type: "board", userId: "u1", source: "session" });
    const res = await request(app).post("/api/conversations/conv1/messages").send({ body: "Hello team" });
    expect(res.status).toBe(201);
    expect(mockSvc.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv1", authorKind: "user", authorId: "u1", body: "Hello team",
    }));
    expect(mockMentionDispatch).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m1" }));
  });

  it("rejects unauthenticated callers", async () => {
    const app = buildApp({ type: "none", source: "none" });
    const res = await request(app).post("/api/conversations/conv1/messages").send({ body: "hi" });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// server/src/routes/conversations.ts
import { Router } from "express";
import type { Db } from "@agentdash/db";
import { unauthorized, badRequest } from "../errors.js";
import { assistantService } from "../services/index.js";

export function conversationRoutes(db: Db) {
  const router = Router();
  const svc = assistantService(db);

  router.post("/:id/messages", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Sign-in required");
    const { body } = req.body as { body: string };
    if (!body?.trim()) throw badRequest("Message body required");
    const msg = await svc.postMessage({
      conversationId: req.params.id,
      authorKind: "user",
      authorId: req.actor.userId,
      body,
    });
    // Fire-and-forget downstream dispatch (mention resolution + CoS reply).
    dispatchOnMessage({ messageId: msg.id, conversationId: req.params.id, authorUserId: req.actor.userId, body });
    res.status(201).json(msg);
  });

  router.get("/:id/messages", async (req, res) => {
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
    const messages = await svc.paginate(req.params.id, { before, limit });
    res.json(messages);
  });

  router.patch("/:id/read", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Sign-in required");
    const { lastReadMessageId } = req.body as { lastReadMessageId: string };
    await svc.setReadPointer(req.params.id, req.actor.userId, lastReadMessageId);
    res.status(204).end();
  });

  router.get("/:id/participants", async (req, res) => {
    const ps = await svc.listParticipants(req.params.id);
    res.json(ps);
  });

  return router;
}

// dispatchOnMessage is a façade exported from services/index.ts that:
// 1. parses mentions
// 2. if any unambiguous agent mention → agentSummoner.summon(...)
// 3. else → cosReplier.reply(...)
function dispatchOnMessage(input: { messageId: string; conversationId: string; authorUserId: string; body: string }) {
  // Implementation lives in services/index.ts; exported as a single function so the route doesn't need to know about the LLM.
}
```

- [ ] **Step 3: Run + commit**

```sh
pnpm test:run -- conversations-routes
git add server/src/routes/conversations.ts server/src/__tests__/conversations-routes.test.ts
git commit -m "feat(server): conversation routes — messages, read, participants"
```

### Task 7.2 — `dispatchOnMessage` façade

**Files:**
- Modify: `server/src/services/index.ts`

- [ ] **Step 1: Wire the façade**

```typescript
// In services/index.ts
import { parseMentions } from "@agentdash/shared";

export async function dispatchOnMessage(input: {
  messageId: string;
  conversationId: string;
  authorUserId: string;
  body: string;
}, deps: { agents: any; mentionParser?: typeof parseMentions; summoner: any; replier: any }) {
  const dir = await loadAgentDirectory(deps.agents, input.conversationId);
  const mentions = (deps.mentionParser ?? parseMentions)(input.body, dir);
  const resolved = mentions.find(m => m.agentId);
  if (resolved) {
    return deps.summoner.summon({
      conversationId: input.conversationId,
      agentId: resolved.agentId!,
      triggeringMessageId: input.messageId,
    });
  }
  // No actionable mention — CoS responds.
  const cosId = await resolveCosAgentId(deps.agents, input.conversationId);
  return deps.replier.reply({ conversationId: input.conversationId, cosAgentId: cosId });
}
```

- [ ] **Step 2: Add a test for routing logic**

```typescript
// server/src/__tests__/dispatch-on-message.test.ts
it("routes to summoner when message has an unambiguous mention", async () => { ... });
it("routes to replier (CoS) when message has no mention", async () => { ... });
it("routes to replier (CoS) when mention is ambiguous (CoS clarifies)", async () => { ... });
```

- [ ] **Step 3: Run + commit**

```sh
pnpm test:run -- dispatch-on-message
git add server/src/services/index.ts server/src/__tests__/dispatch-on-message.test.ts
git commit -m "feat(server): dispatchOnMessage façade (mentions vs CoS)"
```

### Task 7.3 — Wire routes into app

**Files:**
- Modify: `server/src/app.ts`

- [ ] **Step 1: Mount**

```typescript
import { conversationRoutes } from "./routes/conversations.js";
app.use("/api/conversations", conversationRoutes(db));
```

- [ ] **Step 2: Commit**

```sh
git add server/src/app.ts
git commit -m "feat(server): wire conversation routes"
```

---

## Phase 8 — WS event publishing

### Task 8.1 — Emit `message.created` on every message

**Files:**
- Create: `server/src/realtime/conversation-events.ts`
- Modify: `server/src/services/assistant.ts`

- [ ] **Step 1: Write the event emitter**

```typescript
// server/src/realtime/conversation-events.ts
import { wsBus } from "./bus.js"; // upstream paperclip's bus

export function emitMessageCreated(message: any) {
  wsBus.publish(`conversation:${message.conversationId}`, {
    type: "message.created",
    message,
  });
}

export function emitMessageRead(input: { conversationId: string; userId: string; lastReadMessageId: string }) {
  wsBus.publish(`conversation:${input.conversationId}`, {
    type: "message.read",
    ...input,
  });
}
```

- [ ] **Step 2: Hook into `postMessage`**

In `server/src/services/assistant.ts`, after the insert in `postMessage`:

```typescript
emitMessageCreated(row);
return row;
```

And after `setReadPointer`, emit `emitMessageRead({...})`.

- [ ] **Step 3: Add a test confirming the bus receives the event**

```typescript
// In assistant-extensions.test.ts:
it("emits message.created on the WS bus when postMessage runs", async () => {
  const events: any[] = [];
  wsBus.subscribe("conversation:conv1", (e) => events.push(e));
  await assistantService(db).postMessage({ conversationId: "conv1", ... });
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("message.created");
});
```

- [ ] **Step 4: Run + commit**

```sh
pnpm test:run -- assistant-extensions
git add server/src/realtime/conversation-events.ts server/src/services/assistant.ts
git commit -m "feat(server): WS bus events for messages"
```

---

## Phase 9 — UI: chat panel + cards

### Task 9.1 — API client

**Files:**
- Create: `ui/src/api/conversations.ts`

- [ ] **Step 1: Implement**

```typescript
// ui/src/api/conversations.ts
import { api } from "./client";

export interface Message {
  id: string;
  conversationId: string;
  authorKind: "user" | "agent";
  authorId: string;
  body: string;
  cardKind?: string | null;
  cardPayload?: Record<string, unknown> | null;
  createdAt: string;
}

export const conversationsApi = {
  paginate: (id: string, opts: { before?: string; limit?: number } = {}) =>
    api.get<Message[]>(`/conversations/${id}/messages`, { params: opts }),
  post: (id: string, body: string) =>
    api.post<Message>(`/conversations/${id}/messages`, { body }),
  read: (id: string, lastReadMessageId: string) =>
    api.patch(`/conversations/${id}/read`, { lastReadMessageId }),
  participants: (id: string) =>
    api.get(`/conversations/${id}/participants`),
};
```

- [ ] **Step 2: Commit**

```sh
git add ui/src/api/conversations.ts
git commit -m "feat(ui): conversations API client"
```

### Task 9.2 — `useMessages` WS subscription hook

**Files:**
- Create: `ui/src/realtime/useMessages.ts`

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useState } from "react";
import { conversationsApi, type Message } from "../api/conversations";
import { wsClient } from "./ws-client"; // existing upstream client

export function useMessages(conversationId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    conversationsApi.paginate(conversationId, { limit: 50 }).then((rows) => {
      if (!cancelled) setMessages(rows.reverse()); // server returns desc; UI shows asc
    });
    const unsub = wsClient.subscribe(`conversation:${conversationId}`, (event: any) => {
      if (event.type === "message.created") {
        setMessages((prev) => [...prev, event.message]);
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [conversationId]);

  return messages;
}
```

- [ ] **Step 2: Commit**

```sh
git add ui/src/realtime/useMessages.ts
git commit -m "feat(ui): useMessages WS subscription hook"
```

### Task 9.3 — Card components

**Files:**
- Create: `ui/src/components/cards/{ProposalCard,InvitePrompt,AgentStatusCard,InterviewQuestion}.tsx`

- [ ] **Step 1: Each card is a small typed component**

```tsx
// ui/src/components/cards/ProposalCard.tsx
import type { ProposalPayload } from "@agentdash/shared/cards";

export function ProposalCard({
  payload,
  onConfirm,
  onReject,
}: {
  payload: ProposalPayload;
  onConfirm: () => void;
  onReject: (reason?: string) => void;
}) {
  return (
    <div className="card card--proposal">
      <div className="card__title">{payload.name} — {payload.role}</div>
      <div className="card__body">{payload.oneLineOkr}</div>
      <div className="card__body card__body--muted">{payload.rationale}</div>
      <div className="card__actions">
        <button onClick={onConfirm}>Looks good →</button>
        <button onClick={() => onReject()}>Try again</button>
      </div>
    </div>
  );
}
```

(Similar for InvitePrompt, AgentStatusCard, InterviewQuestion. Define payload types in `packages/shared/src/cards.ts`.)

- [ ] **Step 2: Define shared card types**

```typescript
// packages/shared/src/cards.ts
export interface ProposalPayload { name: string; role: string; oneLineOkr: string; rationale: string }
export interface InvitePromptPayload { companyId: string; conversationId: string }
export interface AgentStatusPayload { agentId: string; agentName: string; summary: string; severity: "info" | "warn" | "blocked" }
export interface InterviewQuestionPayload { question: string; fixedIndex?: number }
```

- [ ] **Step 3: Write a card-render dispatch**

```tsx
// ui/src/components/cards/index.tsx
import { ProposalCard } from "./ProposalCard";
// ... other imports

export function CardRenderer({
  cardKind,
  payload,
  context,
}: {
  cardKind: string;
  payload: any;
  context: { onProposalConfirm?: () => void; onProposalReject?: (r?: string) => void; /* ... */ };
}) {
  switch (cardKind) {
    case "proposal_card_v1":
      return <ProposalCard payload={payload} onConfirm={context.onProposalConfirm!} onReject={context.onProposalReject!} />;
    case "invite_prompt_v1":
      return <InvitePrompt {...payload} {...context} />;
    case "agent_status_v1":
      return <AgentStatusCard payload={payload} />;
    case "interview_question_v1":
      return <div className="card card--interview">{payload.question}</div>;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Component test**

```tsx
// ui/src/components/cards/__tests__/ProposalCard.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { ProposalCard } from "../ProposalCard";

it("renders payload fields and fires onConfirm", () => {
  const onConfirm = vi.fn();
  render(<ProposalCard payload={{ name: "Reese", role: "SDR", oneLineOkr: "200 meetings", rationale: "ok" }} onConfirm={onConfirm} onReject={() => {}} />);
  expect(screen.getByText("Reese — SDR")).toBeInTheDocument();
  fireEvent.click(screen.getByText(/looks good/i));
  expect(onConfirm).toHaveBeenCalled();
});
```

- [ ] **Step 5: Commit**

```sh
git add ui/src/components/cards/ packages/shared/src/cards.ts
git commit -m "feat(ui): typed card components for chat substrate"
```

### Task 9.4 — `MessageList` + `Composer` + `ChatPanel`

**Files:**
- Create: `ui/src/components/MessageList.tsx`
- Create: `ui/src/components/Composer.tsx`
- Create: `ui/src/pages/ChatPanel.tsx`

- [ ] **Step 1: MessageList**

```tsx
// ui/src/components/MessageList.tsx
import type { Message } from "../api/conversations";
import { CardRenderer } from "./cards";

export function MessageList({
  messages,
  onProposalConfirm,
  onProposalReject,
}: {
  messages: Message[];
  onProposalConfirm: () => void;
  onProposalReject: (reason?: string) => void;
}) {
  return (
    <div className="message-list">
      {messages.map((m) => (
        <div key={m.id} className={`msg msg--${m.authorKind}`}>
          <div className="msg__meta">{m.authorKind === "agent" ? "Agent" : "You"} · {m.createdAt}</div>
          {m.cardKind ? (
            <CardRenderer cardKind={m.cardKind} payload={m.cardPayload} context={{ onProposalConfirm, onProposalReject }} />
          ) : (
            <div className="msg__body">{m.body}</div>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Composer with @-mention typeahead**

```tsx
// ui/src/components/Composer.tsx
import { useState } from "react";

export function Composer({
  onSend,
  agentDirectory,
}: {
  onSend: (body: string) => void;
  agentDirectory: Array<{ id: string; name: string; role: string }>;
}) {
  const [value, setValue] = useState("");
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  // (typeahead implementation: when value ends with @<token>, filter directory and show a small dropdown)

  function send() {
    if (!value.trim()) return;
    onSend(value.trim());
    setValue("");
    setShowMentionMenu(false);
  }

  return (
    <div className="composer">
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setShowMentionMenu(/@[A-Za-z][A-Za-z0-9_-]*$/.test(e.target.value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Type a message…  Tip: @reese to talk to an agent directly"
      />
      <button onClick={send}>↑</button>
      {showMentionMenu && (
        <div className="mention-menu">
          {agentDirectory.map((a) => (
            <button key={a.id} onClick={() => setValue(value.replace(/@\w*$/, "@" + a.name + " "))}>
              @{a.name} · {a.role}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: ChatPanel**

```tsx
// ui/src/pages/ChatPanel.tsx
import { useMessages } from "../realtime/useMessages";
import { MessageList } from "../components/MessageList";
import { Composer } from "../components/Composer";
import { conversationsApi } from "../api/conversations";
import { useEffect, useState } from "react";

export default function ChatPanel({ conversationId, agentDirectory }: { conversationId: string; agentDirectory: any[] }) {
  const messages = useMessages(conversationId);
  // (read-pointer effect: throttle PATCH /read on scroll-into-view of latest)

  function send(body: string) {
    conversationsApi.post(conversationId, body);
  }

  return (
    <div className="chat-panel">
      <MessageList
        messages={messages}
        onProposalConfirm={() => { /* call onboarding API confirm */ }}
        onProposalReject={(r) => { /* call onboarding API reject */ }}
      />
      <Composer onSend={send} agentDirectory={agentDirectory} />
    </div>
  );
}
```

- [ ] **Step 4: Component tests**

(Standard React Testing Library tests for MessageList rendering messages and cards, Composer firing onSend, ChatPanel composing the two.)

- [ ] **Step 5: Commit**

```sh
git add ui/src/components/MessageList.tsx ui/src/components/Composer.tsx \
  ui/src/pages/ChatPanel.tsx
git commit -m "feat(ui): ChatPanel + MessageList + Composer"
```

---

## Phase 10 — Multi-human E2E

### Task 10.1 — Two-browser Playwright

**Files:**
- Create: `tests/e2e/chat-multi-human.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
import { test, expect } from "@playwright/test";

test("two humans see each other's messages over WS within 2 seconds", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  // Sign in as Alice (or use a test fixture that pre-authenticates her).
  await alice.goto("/");
  // Simulate Bob already in the same company conversation.
  await bob.goto("/");

  await alice.locator(".composer textarea").fill("Hi Bob");
  await alice.getByRole("button", { name: "↑" }).click();

  await expect(bob.getByText("Hi Bob")).toBeVisible({ timeout: 2000 });
});

test("@reese mention surfaces a reply authored by Reese", async ({ page }) => {
  await page.goto("/");
  await page.locator(".composer textarea").fill("@reese what's up?");
  await page.getByRole("button", { name: "↑" }).click();
  // Reply should be authored by Reese, not CoS.
  await expect(page.locator(".msg--agent .msg__meta", { hasText: /Reese/ })).toBeVisible({ timeout: 30000 });
});
```

- [ ] **Step 2: Run**

```sh
pnpm dev   # one tab
pnpm playwright test tests/e2e/chat-multi-human.spec.ts   # other tab
```

- [ ] **Step 3: Commit**

```sh
git add tests/e2e/chat-multi-human.spec.ts
git commit -m "test(e2e): chat multi-human + @-mention"
```

---

## Phase 11 — Final verification

### Task 11.1 — Regression suite

- [ ] **Step 1: Typecheck + test + build**

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: PASS.

- [ ] **Step 2: Manual QA**

- Two browsers, same company. Post messages back and forth; both see updates within 2s.
- @-mention an agent; reply lands authored by that agent.
- Trigger a `task_completed` event for an agent; CoS posts an `agent_status_v1` card.
- Refresh; conversation history loads correctly.

### Task 11.2 — Open the PR

Title: `feat: multi-human + CoS chat substrate`

Body should reference the spec and summarize what's new (cards, mentions, WS, read state).

```sh
git push -u origin <branch>
gh pr create --base main --head <branch> --title "feat: multi-human + CoS chat substrate" --body "$(cat << 'EOF'
Implements docs/superpowers/specs/2026-05-02-chat-substrate-design.md.

- assistant_conversation_participants link table (multi-human)
- card_kind / card_payload columns on assistant_messages (typed cards)
- mention parser, agent summoner, cos replier, activity router, cos proactive
- conversation routes (POST/GET messages, PATCH read, GET participants)
- WS bus events (message.created, message.read)
- ChatPanel UI with MessageList, Composer, typed card renderer

Verification: pnpm -r typecheck ✓, pnpm test:run ✓, pnpm build ✓, e2e ✓.
EOF
)"
```

---

## What this plan does NOT do

- **The onboarding flow itself** lives in the onboarding plan; this plan provides the substrate it sits on.
- **Direct-report multi-turn sub-conversations** — out of scope (spec § 11).
- **File attachments, threads, search, edit/delete** — all v1.1+.

## Decisions baked in (cross-reference to spec § 14)

| Decision | Implementation |
|---|---|
| Hybrid agent presence (CoS by default, others when @-mentioned) | Phase 7.2 dispatch façade |
| One conversation per company | `findByCompany` returns single row |
| Cards as first-class messages | Phase 1 schema + Phase 9.3 UI |
| WS bus delivery (no polling) | Phase 8 |
| Per-participant read pointer | Phase 1.1 column + Phase 7.1 PATCH /read |
| Last-20-message context window for summons | Phase 5 `paginate(limit: 20)` |
| One-shot summons (no multi-turn) | Phase 5 `summon` posts one reply and returns |
