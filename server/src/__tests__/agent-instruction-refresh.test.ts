// agent-instruction-refresh-service unit tests.
//
// Pattern: mock-DB style (matches verdicts.test.ts) plus an in-memory
// fake instructions service so we can sequence reads/writes without touching
// real disk paths.
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  agentInstructionRefreshService,
  __resetAgentInstructionRefreshCache,
  type SourceArchetype,
} from "../services/agent-instruction-refresh.ts";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
  publishPluginDomainEvent: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

interface AgentFixture {
  id: string;
  companyId: string;
  name: string;
  role: string;
  status: string;
  adapterConfig: Record<string, unknown>;
}

interface DbStubOptions {
  agents?: AgentFixture[];
  /** Rows to return for refreshAllForCompany's listing query. */
  companyAgentIds?: Array<{ id: string }>;
}

/**
 * Lightweight stub mimicking drizzle's chainable select. We always pop the
 * next queued result on `.select()` — sequence matters for tests that call
 * the service multiple times.
 */
function makeDb(opts: DbStubOptions = {}) {
  const selectQueue: unknown[][] = [];

  const select = vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  });

  const db = {
    select,
    insert: vi.fn(() => ({
      values: vi.fn(async () => undefined),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };

  function queueAgent(agent: AgentFixture | null) {
    selectQueue.push(agent ? [agent] : []);
  }

  function queueCompanyAgents(ids: string[]) {
    selectQueue.push(ids.map((id) => ({ id })));
  }

  return { db, queueAgent, queueCompanyAgents };
}

/**
 * Fake instructions service: keeps the bundled AGENTS.md in memory by agent.id,
 * counts writes, and lets tests assert exact persisted content.
 */
function makeFakeInstructions(initialBundles: Record<string, string>) {
  const bundles: Record<string, string> = { ...initialBundles };
  const writes: Array<{ agentId: string; content: string }> = [];

  const readFile = vi.fn(async (agent: { id: string }, _path: string) => {
    const content = bundles[agent.id];
    if (content === undefined) {
      throw new Error("Instructions file not found");
    }
    return { path: "AGENTS.md", content, size: content.length };
  });

  const writeFile = vi.fn(async (agent: { id: string }, _path: string, content: string) => {
    bundles[agent.id] = content;
    writes.push({ agentId: agent.id, content });
    return { adapterConfig: {} };
  });

  return {
    instructions: { readFile, writeFile } as any,
    bundles,
    writes,
  };
}

const COMPANY_ID = "company-1";
const AGENT_ID = "agent-1";

const SOURCE_DEFAULT = `Worker prose.

<!-- AgentDash: goals-eval-hitl -->
## DoD v2 (current)
- new content
<!-- /AgentDash: goals-eval-hitl -->

<!-- AgentDash: agent-api-auth -->
## API auth v2
- new auth content
<!-- /AgentDash: agent-api-auth -->
`;

const SOURCE_CEO = `CEO prose.

<!-- AgentDash: goals-eval-hitl -->
## CEO DoD
- ceo content
<!-- /AgentDash: goals-eval-hitl -->
`;

const SOURCE_COS = `CoS prose.

<!-- AgentDash: goals-eval-hitl -->
## CoS DoD
- cos content
<!-- /AgentDash: goals-eval-hitl -->
`;

function makeSourceLoader(): (a: SourceArchetype) => Promise<string> {
  return async (archetype: SourceArchetype) => {
    if (archetype === "ceo") return SOURCE_CEO;
    if (archetype === "chief_of_staff") return SOURCE_COS;
    return SOURCE_DEFAULT;
  };
}

beforeEach(() => {
  mockLogActivity.mockClear();
  __resetAgentInstructionRefreshCache();
});

describe("agentInstructionRefreshService.refreshIfStale", () => {
  it("returns refreshed=false when bundle is byte-identical to source", async () => {
    const { db, queueAgent } = makeDb();
    queueAgent({
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Worker",
      role: "general",
      status: "active",
      adapterConfig: {},
    });

    // Bundle == source byte-for-byte → fast-path early return.
    const fake = makeFakeInstructions({ [AGENT_ID]: SOURCE_DEFAULT });

    const svc = agentInstructionRefreshService({
      db: db as any,
      loadSource: makeSourceLoader(),
      instructions: fake.instructions,
    });

    const result = await svc.refreshIfStale(AGENT_ID);
    expect(result).toEqual({
      refreshed: false,
      blocksUpdated: [],
      blocksAdded: [],
      blocksRemoved: [],
    });
    expect(fake.writes).toHaveLength(0);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("updates a stale block in place and writes a single activity row", async () => {
    const { db, queueAgent } = makeDb();
    queueAgent({
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Worker",
      role: "general",
      status: "active",
      adapterConfig: {},
    });

    const stale = `Worker prose.

<!-- AgentDash: goals-eval-hitl -->
## DoD v1 (OLD)
- old content
<!-- /AgentDash: goals-eval-hitl -->

<!-- AgentDash: agent-api-auth -->
## API auth v2
- new auth content
<!-- /AgentDash: agent-api-auth -->
`;
    const fake = makeFakeInstructions({ [AGENT_ID]: stale });

    const svc = agentInstructionRefreshService({
      db: db as any,
      loadSource: makeSourceLoader(),
      instructions: fake.instructions,
    });

    const result = await svc.refreshIfStale(AGENT_ID);
    expect(result.refreshed).toBe(true);
    expect(result.blocksUpdated).toEqual(["goals-eval-hitl"]);
    expect(result.blocksAdded).toEqual([]);
    expect(result.blocksRemoved).toEqual([]);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]!.content).toContain("DoD v2 (current)");
    expect(fake.writes[0]!.content).not.toContain("DoD v1 (OLD)");
    expect(fake.writes[0]!.content).toContain("Worker prose."); // surrounding prose preserved

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({
      action: "instructions_refreshed",
      actorType: "system",
      actorId: "agent-instruction-refresh-service",
      entityType: "agent",
      entityId: AGENT_ID,
      details: {
        archetype: "default",
        blocksUpdated: ["goals-eval-hitl"],
        blocksAdded: [],
        blocksRemoved: [],
      },
    });
  });

  it("appends a missing block and reports it as blocksAdded", async () => {
    const { db, queueAgent } = makeDb();
    queueAgent({
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Worker",
      role: "general",
      status: "active",
      adapterConfig: {},
    });

    const missingApiBlock = `Worker prose.

<!-- AgentDash: goals-eval-hitl -->
## DoD v2 (current)
- new content
<!-- /AgentDash: goals-eval-hitl -->
`;
    const fake = makeFakeInstructions({ [AGENT_ID]: missingApiBlock });

    const svc = agentInstructionRefreshService({
      db: db as any,
      loadSource: makeSourceLoader(),
      instructions: fake.instructions,
    });

    const result = await svc.refreshIfStale(AGENT_ID);
    expect(result.refreshed).toBe(true);
    expect(result.blocksUpdated).toEqual([]);
    expect(result.blocksAdded).toEqual(["agent-api-auth"]);
    expect(fake.writes[0]!.content).toContain("API auth v2");
  });

  it("leaves a bundle-only block alone and reports it as blocksRemoved", async () => {
    const { db, queueAgent } = makeDb();
    queueAgent({
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Worker",
      role: "general",
      status: "active",
      adapterConfig: {},
    });

    // Bundle has all source blocks AS-IS plus an extra deprecated block.
    const withExtraBlock = `${SOURCE_DEFAULT}

<!-- AgentDash: old-deprecated-block -->
## removed feature
<!-- /AgentDash: old-deprecated-block -->
`;
    const fake = makeFakeInstructions({ [AGENT_ID]: withExtraBlock });

    const svc = agentInstructionRefreshService({
      db: db as any,
      loadSource: makeSourceLoader(),
      instructions: fake.instructions,
    });

    const result = await svc.refreshIfStale(AGENT_ID);
    // No mutation: refreshed=false, blocksRemoved reports the orphan.
    expect(result.refreshed).toBe(false);
    expect(result.blocksUpdated).toEqual([]);
    expect(result.blocksAdded).toEqual([]);
    expect(result.blocksRemoved).toEqual(["old-deprecated-block"]);
    expect(fake.writes).toHaveLength(0);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("updates multiple stale blocks in a single activity_log row", async () => {
    const { db, queueAgent } = makeDb();
    queueAgent({
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Worker",
      role: "general",
      status: "active",
      adapterConfig: {},
    });

    const bothStale = `Worker prose.

<!-- AgentDash: goals-eval-hitl -->
## DoD v1 (OLD)
<!-- /AgentDash: goals-eval-hitl -->

<!-- AgentDash: agent-api-auth -->
## API auth v1 (OLD)
<!-- /AgentDash: agent-api-auth -->
`;
    const fake = makeFakeInstructions({ [AGENT_ID]: bothStale });

    const svc = agentInstructionRefreshService({
      db: db as any,
      loadSource: makeSourceLoader(),
      instructions: fake.instructions,
    });

    const result = await svc.refreshIfStale(AGENT_ID);
    expect(result.refreshed).toBe(true);
    expect(new Set(result.blocksUpdated)).toEqual(
      new Set(["goals-eval-hitl", "agent-api-auth"]),
    );
    // Single activity row, combined details.
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const details = mockLogActivity.mock.calls[0]![1].details as Record<string, unknown>;
    expect(new Set(details.blocksUpdated as string[])).toEqual(
      new Set(["goals-eval-hitl", "agent-api-auth"]),
    );
  });

  it("dispatches by archetype: ceo → ceo source, chief_of_staff → cos source, general → default source", async () => {
    const sourceCalls: SourceArchetype[] = [];
    const loader = async (a: SourceArchetype) => {
      sourceCalls.push(a);
      if (a === "ceo") return SOURCE_CEO;
      if (a === "chief_of_staff") return SOURCE_COS;
      return SOURCE_DEFAULT;
    };

    const { db, queueAgent } = makeDb();

    // worker first
    queueAgent({
      id: "w",
      companyId: COMPANY_ID,
      name: "W",
      role: "general",
      status: "active",
      adapterConfig: {},
    });
    queueAgent({
      id: "c",
      companyId: COMPANY_ID,
      name: "CEO",
      role: "ceo",
      status: "active",
      adapterConfig: {},
    });
    queueAgent({
      id: "s",
      companyId: COMPANY_ID,
      name: "CoS",
      role: "chief_of_staff",
      status: "active",
      adapterConfig: {},
    });

    const fake = makeFakeInstructions({
      w: SOURCE_DEFAULT,
      c: SOURCE_CEO,
      s: SOURCE_COS,
    });

    const svc = agentInstructionRefreshService({
      db: db as any,
      loadSource: loader,
      instructions: fake.instructions,
    });

    await svc.refreshIfStale("w");
    await svc.refreshIfStale("c");
    await svc.refreshIfStale("s");

    expect(sourceCalls).toEqual(["default", "ceo", "chief_of_staff"]);
  });

  it("is idempotent — second refresh after a successful one is a no-op", async () => {
    const { db, queueAgent } = makeDb();
    // queue twice — refreshIfStale loads the agent on each call
    const agent: AgentFixture = {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Worker",
      role: "general",
      status: "active",
      adapterConfig: {},
    };
    queueAgent(agent);
    queueAgent(agent);

    const stale = `Worker prose.

<!-- AgentDash: goals-eval-hitl -->
## DoD v1 (OLD)
<!-- /AgentDash: goals-eval-hitl -->

<!-- AgentDash: agent-api-auth -->
## API auth v2
- new auth content
<!-- /AgentDash: agent-api-auth -->
`;
    const fake = makeFakeInstructions({ [AGENT_ID]: stale });

    const svc = agentInstructionRefreshService({
      db: db as any,
      loadSource: makeSourceLoader(),
      instructions: fake.instructions,
    });

    const first = await svc.refreshIfStale(AGENT_ID);
    expect(first.refreshed).toBe(true);

    const second = await svc.refreshIfStale(AGENT_ID);
    expect(second.refreshed).toBe(false);
    expect(second.blocksUpdated).toEqual([]);
    expect(fake.writes).toHaveLength(1); // still only one write
    expect(mockLogActivity).toHaveBeenCalledTimes(1); // still only one activity row
  });

  it("preserves role-specific interpolated content (proposal-created agent's ${p.name})", async () => {
    const { db, queueAgent } = makeDb();
    queueAgent({
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Sasha",
      role: "general",
      status: "active",
      adapterConfig: {},
    });

    // Mimic the renderAgents() output: role-specific content + AgentDash blocks.
    const proposalAgentBundle = `# AGENTS.md — Sasha

## Role
Senior Marketing Strategist

## 90-day Goal
Drive 25% MoM growth in qualified leads

<!-- AgentDash: goals-eval-hitl -->
## DoD v1 (OLD)
- old content
<!-- /AgentDash: goals-eval-hitl -->

<!-- AgentDash: agent-api-auth -->
## API auth v2
- new auth content
<!-- /AgentDash: agent-api-auth -->
`;
    const fake = makeFakeInstructions({ [AGENT_ID]: proposalAgentBundle });

    const svc = agentInstructionRefreshService({
      db: db as any,
      loadSource: makeSourceLoader(),
      instructions: fake.instructions,
    });

    const result = await svc.refreshIfStale(AGENT_ID);
    expect(result.refreshed).toBe(true);
    expect(result.blocksUpdated).toEqual(["goals-eval-hitl"]);

    const persisted = fake.writes[0]!.content;
    // Role-specific content survives the refresh.
    expect(persisted).toContain("# AGENTS.md — Sasha");
    expect(persisted).toContain("Senior Marketing Strategist");
    expect(persisted).toContain("Drive 25% MoM growth in qualified leads");
    // Stale block was replaced.
    expect(persisted).toContain("DoD v2 (current)");
    expect(persisted).not.toContain("DoD v1 (OLD)");
  });
});

describe("agentInstructionRefreshService.refreshAllForCompany", () => {
  it("iterates active agents and returns per-agent results", async () => {
    const { db, queueCompanyAgents, queueAgent } = makeDb();

    // 1) Listing query returns two agent ids.
    queueCompanyAgents(["a1", "a2"]);
    // 2) Per-agent loadAgent queries (in order).
    queueAgent({
      id: "a1",
      companyId: COMPANY_ID,
      name: "A1",
      role: "general",
      status: "active",
      adapterConfig: {},
    });
    queueAgent({
      id: "a2",
      companyId: COMPANY_ID,
      name: "A2",
      role: "general",
      status: "active",
      adapterConfig: {},
    });

    const stale = `Worker prose.

<!-- AgentDash: goals-eval-hitl -->
## DoD v1 (OLD)
<!-- /AgentDash: goals-eval-hitl -->

<!-- AgentDash: agent-api-auth -->
## API auth v2
- new auth content
<!-- /AgentDash: agent-api-auth -->
`;
    const fake = makeFakeInstructions({ a1: stale, a2: SOURCE_DEFAULT });

    const svc = agentInstructionRefreshService({
      db: db as any,
      loadSource: makeSourceLoader(),
      instructions: fake.instructions,
    });

    const out = await svc.refreshAllForCompany(COMPANY_ID);
    expect(Object.keys(out).sort()).toEqual(["a1", "a2"]);
    expect(out.a1!.refreshed).toBe(true);
    expect(out.a2!.refreshed).toBe(false);
  });
});
