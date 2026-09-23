import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { assistantDigestService } from "../services/assistant-digest.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres assistant digest tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// AgentDash GH #676: the assistant digest is the "what changed" feed behind
// `whats_new`. These tests pin the three contracts the MCP tool relies on:
// the audience is the caller's agents only (accountability-scoped), totals
// and truncation are honest, and sensitive columns never reach the output.

describeEmbeddedPostgres("assistant digest service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assistant-digest-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, accountableUserId: string | null) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      autonomy: "autonomous",
      accountableUserId,
      adapterType: "process",
      adapterConfig: { cwd: "/tmp", env: { SECRET: "never-echoed" } },
    });
    return id;
  }

  async function seedIssue(
    companyId: string,
    assigneeAgentId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: `Issue ${id.slice(0, 6)}`,
      status: "done",
      priority: "medium",
      assigneeAgentId,
      completedAt: new Date(),
      ...overrides,
    } as never);
    return id;
  }

  it("scopes the digest to the agents the caller answers for", async () => {
    const companyId = await seedCompany();
    const mine = await seedAgent(companyId, "Priya", "user-1");
    const theirs = await seedAgent(companyId, "Marisol", "user-2");
    await seedIssue(companyId, mine, { title: "My shipped work" });
    await seedIssue(companyId, theirs, { title: "Their shipped work" });

    const digest = await assistantDigestService(db).digest({
      companyId,
      userId: "user-1",
      since: new Date(Date.now() - 3600_000),
    });

    expect(digest.agentsAnsweredFor).toBe(1);
    expect(digest.shipped.total).toBe(1);
    expect(digest.shipped.items[0]?.title).toBe("My shipped work");
    expect(digest.shipped.items[0]?.agentName).toBe("Priya");
  });

  it("answers for the whole company when the board actor has no user id", async () => {
    const companyId = await seedCompany();
    const mine = await seedAgent(companyId, "Priya", "user-1");
    const theirs = await seedAgent(companyId, "Marisol", "user-2");
    await seedIssue(companyId, mine);
    await seedIssue(companyId, theirs);

    const digest = await assistantDigestService(db).digest({
      companyId,
      userId: null,
      since: new Date(Date.now() - 3600_000),
    });

    expect(digest.agentsAnsweredFor).toBe(2);
    expect(digest.shipped.total).toBe(2);
  });

  it("returns an empty digest when the caller answers for nobody", async () => {
    const companyId = await seedCompany();
    const theirs = await seedAgent(companyId, "Marisol", "user-2");
    await seedIssue(companyId, theirs);

    const digest = await assistantDigestService(db).digest({
      companyId,
      userId: "user-1",
      since: new Date(Date.now() - 3600_000),
    });

    expect(digest.agentsAnsweredFor).toBe(0);
    expect(digest.shipped.total).toBe(0);
    expect(digest.decisionsWaiting.total).toBe(0);
  });

  it("respects the since window and project scope", async () => {
    const companyId = await seedCompany();
    const me = await seedAgent(companyId, "Priya", "user-1");
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Dark mode" });

    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await seedIssue(companyId, me, {
      title: "Old ship",
      projectId,
      completedAt: twoHoursAgo,
      updatedAt: twoHoursAgo,
    });
    await seedIssue(companyId, me, { title: "New ship", projectId });
    await seedIssue(companyId, me, { title: "Other project ship" });

    const digest = await assistantDigestService(db).digest({
      companyId,
      userId: "user-1",
      since: new Date(Date.now() - 3600_000),
      projectId,
    });

    expect(digest.shipped.total).toBe(1);
    expect(digest.shipped.items[0]?.title).toBe("New ship");
    expect(digest.shipped.items[0]?.project).toBe("Dark mode");
  });

  it("reports blocked items and open decisions without leaking secrets", async () => {
    const companyId = await seedCompany();
    const me = await seedAgent(companyId, "Priya", "user-1");
    await seedIssue(companyId, me, { status: "blocked", completedAt: null });

    await db.insert(approvals).values([
      {
        companyId,
        type: "connector_send",
        status: "pending",
        payload: { secret: "not-echoed", message: "hi" },
        requestedByAgentId: me,
        revision: 1,
      },
      {
        companyId,
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: me,
        revision: 1,
      },
    ]);

    const digest = await assistantDigestService(db).digest({
      companyId,
      userId: "user-1",
      since: new Date(Date.now() - 3600_000),
    });

    expect(digest.blocked.total).toBe(1);
    expect(digest.decisionsWaiting.total).toBe(1);
    expect(digest.decisionsWaiting.items[0]?.type).toBe("connector_send");
    expect(digest.decisionsWaiting.items[0]?.agentName).toBe("Priya");
    // Approvals serialize as id/type/agent/risk/waitingSince — never the payload.
    const serialized = JSON.stringify(digest);
    expect(serialized).not.toContain("not-echoed");
    expect(serialized).not.toContain("payload");
  });

  it("attaches work products to shipped items without their metadata", async () => {
    const companyId = await seedCompany();
    const me = await seedAgent(companyId, "Priya", "user-1");
    const issueId = await seedIssue(companyId, me, { title: "Shipped with PR" });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "PR #42",
      url: "https://github.com/x/y/pull/42",
      status: "merged",
      reviewState: "approved",
      summary: "Adds retries",
      metadata: { providerSecret: "never-echoed" },
    });

    const digest = await assistantDigestService(db).digest({
      companyId,
      userId: "user-1",
      since: new Date(Date.now() - 3600_000),
    });

    const wp = digest.shipped.items[0]?.workProducts?.[0];
    expect(wp?.title).toBe("PR #42");
    expect(wp?.url).toBe("https://github.com/x/y/pull/42");
    expect(wp).not.toHaveProperty("metadata");
    expect(JSON.stringify(digest)).not.toContain("providerSecret");
  });

  it("counts beyond the shown window and marks the digest truncated", async () => {
    const companyId = await seedCompany();
    const me = await seedAgent(companyId, "Priya", "user-1");
    for (let i = 0; i < 12; i += 1) {
      await seedIssue(companyId, me, { title: `Shipped ${i}` });
    }

    const digest = await assistantDigestService(db).digest({
      companyId,
      userId: "user-1",
      since: new Date(Date.now() - 3600_000),
    });

    expect(digest.shipped.total).toBe(12);
    expect(digest.shipped.shown).toBe(10);
    expect(digest.shipped.items).toHaveLength(10);
    expect(digest.truncated).toBe(true);
  });
});
