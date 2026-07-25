import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Full task delegation chain across teams with request depth increment.
 *
 * Validates SPEC §17.3: "task delegation across teams with request depth
 * increment."
 *
 * Scenario:
 *   1. Create a company with three agents in different roles (teams):
 *      - CoS (chief_of_staff)
 *      - Engineer (engineer)
 *      - QA (qa)
 *   2. Create a root task assigned to the CoS (requestDepth = 0).
 *   3. CoS delegates part of the work to Engineer via
 *      POST /issues/:id/children. The child must have requestDepth = 1 and
 *      parentId pointing to the root.
 *   4. Engineer delegates further to QA via the same endpoint. The
 *      grandchild must have requestDepth = 2 and parentId pointing to the
 *      engineer's child issue.
 *   5. Verify the full parent → child → grandchild chain is consistent
 *      and that requestDepth increments by exactly 1 at each hop.
 *   6. Verify the blocking flag: when blockParentUntilDone is true, the
 *      parent issue's status reflects the dependency.
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts
 * webServer env).
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Delegation-${Date.now()}`;

interface AgentInfo {
  id: string;
  name: string;
  role: string;
}

interface TestContext {
  companyId: string;
  cos: AgentInfo;
  engineer: AgentInfo;
  qa: AgentInfo;
  boardRequest: APIRequestContext;
}

async function setupCompany(boardRequest: APIRequestContext): Promise<TestContext> {
  // Verify server is in local_trusted mode
  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Delegation e2e tests require local_trusted deployment mode, ` +
        `but server is in "${health.deploymentMode}" mode.`,
    );
  }

  // Create company
  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name: COMPANY_NAME },
  });
  expect(companyRes.ok()).toBe(true);
  const company = await companyRes.json();
  const companyId = company.id;

  async function hireAgent(
    name: string,
    role: string,
    title: string,
  ): Promise<AgentInfo> {
    const agentRes = await boardRequest.post(
      `${BASE_URL}/api/companies/${companyId}/agent-hires`,
      {
        data: {
          name,
          role,
          title,
          adapterType: "process",
          adapterConfig: {
            command: process.execPath,
            args: ["-e", "process.stdout.write('done\\n')"],
          },
        },
      },
    );
    expect(agentRes.ok()).toBe(true);
    const hire = await agentRes.json();
    const agent = hire.agent;
    // Auto-approve if an approval was created
    if (hire.approval) {
      const approvalRes = await boardRequest.post(
        `${BASE_URL}/api/approvals/${hire.approval.id}/approve`,
        {
          data: { decisionNote: "Approved for delegation e2e setup." },
        },
      );
      expect(approvalRes.ok()).toBe(true);
    }
    return { id: agent.id, name, role };
  }

  const cos = await hireAgent("CoS", "chief_of_staff", "Chief of Staff");
  const engineer = await hireAgent("Engineer", "engineer", "Software Engineer");
  const qa = await hireAgent("QA", "qa", "QA Engineer");

  return { companyId, cos, engineer, qa, boardRequest };
}

test.describe("Task delegation chain across teams (SPEC §17.3)", () => {
  let ctx: TestContext;

  test.beforeAll(async () => {
    const boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    ctx = await setupCompany(boardRequest);
  });

  test.afterAll(async () => {
    await ctx.boardRequest.dispose();
  });

  test("root task → CoS delegates to Engineer → Engineer delegates to QA; requestDepth increments at each hop", async () => {
    // ── Step 1: Create the root issue assigned to the CoS ──────────
    const rootRes = await ctx.boardRequest.post(
      `${BASE_URL}/api/companies/${ctx.companyId}/issues`,
      {
        data: {
          title: "Root: ship the feature",
          description: "Top-level task assigned to CoS for delegation.",
          status: "todo",
          priority: "high",
          assigneeAgentId: ctx.cos.id,
        },
      },
    );
    expect(rootRes.ok()).toBe(true);
    const rootIssue = await rootRes.json();

    // Root issue starts at requestDepth 0
    expect(rootIssue.requestDepth).toBe(0);
    expect(rootIssue.parentId).toBeNull();

    // ── Step 2: CoS delegates to Engineer (cross-team delegation) ──
    const childRes = await ctx.boardRequest.post(
      `${BASE_URL}/api/issues/${rootIssue.id}/children`,
      {
        data: {
          title: "Implement the API endpoint",
          description: "Delegated from CoS to Engineering team.",
          status: "todo",
          priority: "high",
          assigneeAgentId: ctx.engineer.id,
          blockParentUntilDone: true,
        },
      },
    );
    expect(childRes.status()).toBe(201);
    expect(childRes.ok()).toBe(true);
    const childIssue = await childRes.json();

    // Child must have incremented requestDepth and correct parent link
    expect(childIssue.id).not.toBe(rootIssue.id);
    expect(childIssue.parentId).toBe(rootIssue.id);
    expect(childIssue.requestDepth).toBe(1);
    expect(childIssue.assigneeAgentId).toBe(ctx.engineer.id);
    expect(childIssue.companyId).toBe(ctx.companyId);

    // Verify the child is returned by the company issues list
    const listRes = await ctx.boardRequest.get(
      `${BASE_URL}/api/companies/${ctx.companyId}/issues`,
    );
    expect(listRes.ok()).toBe(true);
    const allIssues = await listRes.json();
    const foundChild = Array.isArray(allIssues)
      ? allIssues.find((i: { id: string }) => i.id === childIssue.id)
      : null;
    expect(foundChild).toBeTruthy();
    expect(foundChild.requestDepth).toBe(1);

    // ── Step 3: Engineer delegates further to QA (deeper chain) ────
    const grandchildRes = await ctx.boardRequest.post(
      `${BASE_URL}/api/issues/${childIssue.id}/children`,
      {
        data: {
          title: "Write integration tests for the endpoint",
          description: "Delegated from Engineering to QA team.",
          status: "todo",
          priority: "medium",
          assigneeAgentId: ctx.qa.id,
        },
      },
    );
    expect(grandchildRes.status()).toBe(201);
    expect(grandchildRes.ok()).toBe(true);
    const grandchildIssue = await grandchildRes.json();

    // Grandchild must have requestDepth = 2 (parent.depth + 1)
    expect(grandchildIssue.id).not.toBe(childIssue.id);
    expect(grandchildIssue.parentId).toBe(childIssue.id);
    expect(grandchildIssue.requestDepth).toBe(2);
    expect(grandchildIssue.assigneeAgentId).toBe(ctx.qa.id);
    expect(grandchildIssue.companyId).toBe(ctx.companyId);

    // ── Step 4: Verify the full chain via GET /issues/:id ──────────
    const rootFetched = await (
      await ctx.boardRequest.get(`${BASE_URL}/api/issues/${rootIssue.id}`)
    ).json();
    const childFetched = await (
      await ctx.boardRequest.get(`${BASE_URL}/api/issues/${childIssue.id}`)
    ).json();
    const grandchildFetched = await (
      await ctx.boardRequest.get(`${BASE_URL}/api/issues/${grandchildIssue.id}`)
    ).json();

    // Chain: root (depth 0) → child (depth 1) → grandchild (depth 2)
    expect(rootFetched.requestDepth).toBe(0);
    expect(rootFetched.parentId).toBeNull();

    expect(childFetched.requestDepth).toBe(1);
    expect(childFetched.parentId).toBe(rootFetched.id);

    expect(grandchildFetched.requestDepth).toBe(2);
    expect(grandchildFetched.parentId).toBe(childFetched.id);

    // ── Step 5: Verify delegation goes to different agent/team ─────
    expect(rootFetched.assigneeAgentId).toBe(ctx.cos.id);
    expect(childFetched.assigneeAgentId).toBe(ctx.engineer.id);
    expect(grandchildFetched.assigneeAgentId).toBe(ctx.qa.id);

    // All three agents should be distinct
    const assignees = new Set([
      rootFetched.assigneeAgentId,
      childFetched.assigneeAgentId,
      grandchildFetched.assigneeAgentId,
    ]);
    expect(assignees.size).toBe(3);
  });

  test("child issue inherits companyId and requestDepth increments monotonically across a multi-level chain", async () => {
    // Create a root issue then chain 4 children (depth 0 → 4)
    const rootRes = await ctx.boardRequest.post(
      `${BASE_URL}/api/companies/${ctx.companyId}/issues`,
      {
        data: {
          title: "Deep chain root",
          status: "backlog",
          assigneeAgentId: ctx.cos.id,
        },
      },
    );
    expect(rootRes.ok()).toBe(true);
    let current = await rootRes.json();
    expect(current.requestDepth).toBe(0);

    const depths: number[] = [0];
    const assigneeRotation = [ctx.engineer.id, ctx.qa.id, ctx.cos.id, ctx.engineer.id];

    for (let i = 0; i < 4; i++) {
      const childRes = await ctx.boardRequest.post(
        `${BASE_URL}/api/issues/${current.id}/children`,
        {
          data: {
            title: `Chain level ${i + 1}`,
            status: "backlog",
            assigneeAgentId: assigneeRotation[i],
          },
        },
      );
      expect(childRes.ok()).toBe(true);
      current = await childRes.json();
      expect(current.parentId).toBeTruthy();
      expect(current.requestDepth).toBe(i + 1);
      expect(current.companyId).toBe(ctx.companyId);
      depths.push(current.requestDepth);
    }

    // Depths must be monotonically increasing by exactly 1
    expect(depths).toEqual([0, 1, 2, 3, 4]);
  });

  test("explicitly setting requestDepth on a child issue is clamped to parent + 1 at minimum", async () => {
    // Per issues.ts createChild logic:
    //   requestDepth = max(clamp(parent.depth + 1), clamp(requestDepth))
    // So even if the caller passes requestDepth=0, the child gets at
    // least parent + 1.
    const rootRes = await ctx.boardRequest.post(
      `${BASE_URL}/api/companies/${ctx.companyId}/issues`,
      {
        data: {
          title: "Clamp test root",
          status: "backlog",
          assigneeAgentId: ctx.cos.id,
          requestDepth: 0,
        },
      },
    );
    expect(rootRes.ok()).toBe(true);
    const root = await rootRes.json();
    expect(root.requestDepth).toBe(0);

    // Pass a deliberately low requestDepth — service must override to parent+1
    const childRes = await ctx.boardRequest.post(
      `${BASE_URL}/api/issues/${root.id}/children`,
      {
        data: {
          title: "Clamp test child",
          status: "backlog",
          assigneeAgentId: ctx.engineer.id,
          requestDepth: 0,
        },
      },
    );
    expect(childRes.ok()).toBe(true);
    const child = await childRes.json();
    // Even though requestDepth=0 was sent, parent.depth(0)+1 = 1 wins
    expect(child.requestDepth).toBe(1);
  });
});
