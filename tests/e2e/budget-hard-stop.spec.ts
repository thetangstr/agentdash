/**
 * E2E: budget hard-stop auto-pauses an agent.
 *
 * SPEC §17.3 requires this end-to-end test:
 *   "agent reports cost -> budget threshold reached -> auto-pause occurs"
 *
 * Scenario:
 *   1. Create a fresh company and a "Worker" agent (process adapter — no LLM).
 *   2. Create a tiny monthly budget for that agent via the budgets/policies
 *      API (amount = 100 cents, hardStopEnabled = true).
 *   3. Have the agent POST a cost event that drives observed spend past the
 *      threshold (150 cents reported).
 *   4. Assert:
 *        a) The agent's status is "paused" with pauseReason "budget".
 *        b) GET /companies/:companyId/budgets/overview shows the agent policy
 *           paused + status "hard_stop".
 *        c) An open hard-type budget incident exists for the policy.
 *        d) Attempting to invoke another heartbeat run returns 423
 *           (locked / "agent is paused because its budget hard-stop was
 *           reached") — proving new invocations are blocked, matching
 *           SPEC §19 acceptance criterion #6.
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts
 * webServer env) and a throwaway PAPERCLIP_HOME (also from the config).
 */

import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
} from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const COMPANY_NAME = `E2E-BudgetHardStop-${Date.now()}`;
const AGENT_NAME = "BudgetWorker";
const AGENT_ROLE = "engineer";
const AGENT_TITLE = "Engineer";
const BUDGET_AMOUNT_CENTS = 100;
const COST_EVENT_CENTS = 150;

interface AgentAuth {
  agentId: string;
  token: string;
  keyId: string;
  request: APIRequestContext;
}

interface BudgetPolicySummary {
  policyId: string;
  scopeType: "company" | "agent" | "project";
  scopeId: string;
  scopeName: string;
  amount: number;
  observedAmount: number;
  hardStopEnabled: boolean;
  status: "ok" | "warning" | "hard_stop";
  paused: boolean;
  pauseReason: "manual" | "budget" | "system" | null;
}

interface BudgetOverview {
  companyId: string;
  policies: BudgetPolicySummary[];
  activeIncidents: Array<{
    id: string;
    policyId: string;
    scopeType: string;
    scopeId: string;
    thresholdType: "soft" | "hard";
    amountLimit: number;
    amountObserved: number;
    status: "open" | "resolved";
  }>;
  pausedAgentCount: number;
  pausedProjectCount: number;
  pendingApprovalCount: number;
}

async function createAgentRequest(token: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function setupCompanyAndAgent(
  boardRequest: APIRequestContext,
): Promise<{ companyId: string; agent: AgentAuth; budgetPolicyId: string }> {
  // Sanity-check deployment mode.
  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = (await healthRes.json()) as { deploymentMode?: string };
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Budget hard-stop e2e requires local_trusted deployment mode, ` +
        `but server is in "${health.deploymentMode}" mode.`,
    );
  }

  // 1. Create company.
  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name: COMPANY_NAME },
  });
  if (!companyRes.ok()) {
    throw new Error(
      `POST /api/companies → ${companyRes.status()}: ${await companyRes.text()}`,
    );
  }
  const company = (await companyRes.json()) as { id: string };
  const companyId = company.id;

  // 2. Hire a process-adapter worker so the test runs without an LLM.
  const agentHireRes = await boardRequest.post(
    `${BASE_URL}/api/companies/${companyId}/agent-hires`,
    {
      data: {
        name: AGENT_NAME,
        role: AGENT_ROLE,
        title: AGENT_TITLE,
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
      },
    },
  );
  expect(agentHireRes.ok()).toBe(true);
  const hire = (await agentHireRes.json()) as {
    agent: { id: string };
    approval?: { id: string };
  };
  const agentId = hire.agent.id;

  // Some companies require board approval before the agent becomes active.
  if (hire.approval) {
    const approvalRes = await boardRequest.post(
      `${BASE_URL}/api/approvals/${hire.approval.id}/approve`,
      { data: { decisionNote: "Approved for budget hard-stop e2e." } },
    );
    expect(approvalRes.ok()).toBe(true);
  }

  // 3. Create an API key so the agent can POST its own cost event.
  const keyRes = await boardRequest.post(`${BASE_URL}/api/agents/${agentId}/keys`, {
    data: { name: `e2e-${AGENT_NAME.toLowerCase()}` },
  });
  expect(keyRes.ok()).toBe(true);
  const keyData = (await keyRes.json()) as { id: string; token: string };

  const agent: AgentAuth = {
    agentId,
    token: keyData.token,
    keyId: keyData.id,
    request: await createAgentRequest(keyData.token),
  };

  // 4. Install a tight agent-scoped budget policy with hard-stop enabled.
  //    POST /companies/:companyId/budgets/policies (board-only) — see
  //    server/src/routes/costs.ts.
  const policyRes = await boardRequest.post(
    `${BASE_URL}/api/companies/${companyId}/budgets/policies`,
    {
      data: {
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: BUDGET_AMOUNT_CENTS,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: false,
        isActive: true,
      },
    },
  );
  expect(policyRes.ok()).toBe(true);
  const policy = (await policyRes.json()) as { policyId: string };
  const budgetPolicyId = policy.policyId;

  return { companyId, agent, budgetPolicyId };
}

async function teardown(
  companyId: string,
  agent: AgentAuth,
  boardRequest: APIRequestContext,
): Promise<void> {
  await agent.request.dispose().catch(() => {});
  await boardRequest
    .delete(`${BASE_URL}/api/agents/${agent.agentId}/keys/${agent.keyId}`)
    .catch(() => {});
  // Delete the company first (which cascades to cost_events, budget_incidents,
  // etc.) so individual agent deletion doesn't hit FK constraints.
  await boardRequest.delete(`${BASE_URL}/api/companies/${companyId}`).catch(() => {});
}

test.describe("Budget hard-stop auto-pause (SPEC §17.3)", () => {
  let boardRequest: APIRequestContext;
  let companyId: string;
  let agent: AgentAuth;
  let budgetPolicyId: string;

  test.beforeAll(async () => {
    boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    const ctx = await setupCompanyAndAgent(boardRequest);
    companyId = ctx.companyId;
    agent = ctx.agent;
    budgetPolicyId = ctx.budgetPolicyId;
  });

  test.afterAll(async () => {
    if (companyId && agent && boardRequest) {
      await teardown(companyId, agent, boardRequest);
      await boardRequest.dispose();
    }
  });

  test("agent reports cost -> budget threshold reached -> agent is auto-paused", async () => {
    // Sanity: the policy is active and the agent is not paused yet.
    const overviewBeforeRes = await boardRequest.get(
      `${BASE_URL}/api/companies/${companyId}/budgets/overview`,
    );
    expect(overviewBeforeRes.ok()).toBe(true);
    const overviewBefore = (await overviewBeforeRes.json()) as BudgetOverview;
    const policyBefore = overviewBefore.policies.find(
      (p) => p.policyId === budgetPolicyId,
    );
    expect(policyBefore, "policy should appear in overview").toBeTruthy();
    expect(policyBefore!.paused).toBe(false);
    expect(policyBefore!.status).toBe("ok");
    expect(overviewBefore.pausedAgentCount).toBe(0);

    const agentBeforeRes = await boardRequest.get(
      `${BASE_URL}/api/agents/${agent.agentId}`,
    );
    expect(agentBeforeRes.ok()).toBe(true);
    const agentBefore = (await agentBeforeRes.json()) as {
      status: string;
      pauseReason: string | null;
    };
    expect(agentBefore.status).not.toBe("paused");
    expect(agentBefore.pauseReason).toBeNull();

    // Agent POSTs its own cost event (over-budget by 50 cents on a 100-cent cap).
    // See server/src/routes/costs.ts → POST /companies/:companyId/cost-events.
    // The route requires the agent's own bearer token; the costService then
    // calls budgetService.evaluateCostEvent, which fires the hard-stop.
    const costEventRes = await agent.request.post(
      `${BASE_URL}/api/companies/${companyId}/cost-events`,
      {
        data: {
          agentId: agent.agentId,
          provider: "anthropic",
          model: "claude-sonnet-test",
          inputTokens: 1_000_000,
          outputTokens: 0,
          costCents: COST_EVENT_CENTS,
          occurredAt: new Date().toISOString(),
        },
      },
    );
    expect(
      costEventRes.ok(),
      `POST cost-event failed: ${costEventRes.status()} ${await costEventRes.text()}`,
    ).toBe(true);

    // Assertion (a): the agent row itself is paused with pauseReason = budget.
    const agentAfterRes = await boardRequest.get(
      `${BASE_URL}/api/agents/${agent.agentId}`,
    );
    expect(agentAfterRes.ok()).toBe(true);
    const agentAfter = (await agentAfterRes.json()) as {
      status: string;
      pauseReason: string | null;
      pausedAt: string | null;
    };
    expect(agentAfter.status).toBe("paused");
    expect(agentAfter.pauseReason).toBe("budget");
    expect(agentAfter.pausedAt).toBeTruthy();

    // Assertion (b): budget overview shows the agent policy in hard_stop state.
    const overviewAfterRes = await boardRequest.get(
      `${BASE_URL}/api/companies/${companyId}/budgets/overview`,
    );
    expect(overviewAfterRes.ok()).toBe(true);
    const overviewAfter = (await overviewAfterRes.json()) as BudgetOverview;
    const policyAfter = overviewAfter.policies.find(
      (p) => p.policyId === budgetPolicyId,
    );
    expect(policyAfter, "policy should still appear in overview").toBeTruthy();
    expect(policyAfter!.status).toBe("hard_stop");
    expect(policyAfter!.paused).toBe(true);
    expect(policyAfter!.pauseReason).toBe("budget");
    expect(policyAfter!.observedAmount).toBeGreaterThanOrEqual(policyAfter!.amount);
    expect(overviewAfter.pausedAgentCount).toBe(1);

    // Assertion (c): an open hard-type incident exists for the policy.
    const hardIncidents = overviewAfter.activeIncidents.filter(
      (i) =>
        i.policyId === budgetPolicyId &&
        i.thresholdType === "hard" &&
        i.status === "open",
    );
    expect(hardIncidents.length, "open hard incident should exist").toBeGreaterThan(
      0,
    );
    const incident = hardIncidents[0]!;
    expect(incident.amountLimit).toBe(BUDGET_AMOUNT_CENTS);
    expect(incident.amountObserved).toBeGreaterThanOrEqual(incident.amountLimit);
    expect(incident.scopeType).toBe("agent");
    expect(incident.scopeId).toBe(agent.agentId);

    // Assertion (d): new invocations are blocked. SPEC §19 #6 says "Budget
    // hard limit auto-pauses an agent and prevents new invocations."
    // The cleanest public signal in local_trusted mode is the
    // /agents/:id/heartbeat/invoke endpoint returning a 4xx error when
    // the agent is paused — this is the same code path
    // budgetService.getInvocationBlock backs.
    const invokeRes = await boardRequest.post(
      `${BASE_URL}/api/agents/${agent.agentId}/heartbeat/invoke`,
    );
    expect(
      invokeRes.status() >= 400,
      `heartbeat/invoke should reject paused agent, got ${invokeRes.status()}`,
    ).toBe(true);
  });
});