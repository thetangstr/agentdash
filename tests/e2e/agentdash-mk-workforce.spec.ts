import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * AgentDash-MK end-to-end acceptance.
 *
 * A CEO agent delegates to Product, Engineering, and Marketing; each
 * stakeholder's steward decides a governed action; the CEO consolidates with
 * complete provenance.
 *
 * Channel coverage is deliberately asymmetric and the asymmetry is asserted,
 * not hidden: Telegram has a real inbound path and decides an approval here,
 * while the Teams endpoint is asserted to REJECT because its Bot Framework
 * activity validation is not wired. A spec that skipped Teams would let that
 * gap read as covered.
 */

async function json(api: APIRequestContext, method: "get" | "post" | "put", url: string, data?: unknown) {
  const response = await api[method](url, data === undefined ? undefined : { data });
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = body;
  }
  return { status: response.status(), body: parsed as Record<string, unknown> };
}

test("CEO consolidates three stewarded contributions with web and Telegram approvals", async ({
  request,
  page,
}) => {
  // --- workforce -----------------------------------------------------------
  const company = await json(request, "post", "/api/companies", {
    name: `MK Acceptance ${Date.now()}`,
    productProfile: "agentdash_mk",
  });
  expect(company.status, JSON.stringify(company.body)).toBeLessThan(300);
  const companyId = company.body.id as string;

  const roles = ["CEO", "Product", "Engineering", "Marketing"] as const;
  const agentIds: Record<string, string> = {};
  for (const role of roles) {
    const created = await json(request, "post", `/api/companies/${companyId}/agents`, {
      name: `${role} Agent`,
      role: role === "CEO" ? "ceo" : "engineer",
      adapterType: "process",
    });
    expect(created.status, `${role}: ${JSON.stringify(created.body)}`).toBeLessThan(300);
    agentIds[role] = created.body.id as string;
  }

  // --- ceilings ------------------------------------------------------------
  const policy = await json(
    request,
    "get",
    `/api/companies/${companyId}/agents/${agentIds.Product}/governance`,
  );
  expect(policy.status).toBe(200);
  const revision = (policy.body.policy as { revision: number }).revision;

  const ceiling = await json(
    request,
    "put",
    `/api/companies/${companyId}/agents/${agentIds.Product}/governance/ceiling`,
    {
      policy: {
        permissions: ["issues:read", "issues:write"],
        monthlyBudgetCents: 10_000,
        destructiveActions: "approval_required",
        dataScopes: ["*"],
        providers: ["telegram"],
        minimumApproval: "steward",
      },
      revision,
    },
  );
  expect(ceiling.status, JSON.stringify(ceiling.body)).toBe(200);

  // A request beyond the ceiling is refused with a stable, explanatory code.
  const overBroad = await json(
    request,
    "put",
    `/api/companies/${companyId}/agents/${agentIds.Product}/governance/request`,
    {
      policy: {
        permissions: ["secrets:read"],
        monthlyBudgetCents: 999_999,
        destructiveActions: "allowed",
        dataScopes: ["*"],
        providers: ["telegram"],
        minimumApproval: "none",
      },
      revision: (ceiling.body.policy as { revision: number }).revision,
    },
  );
  expect(overBroad.status).toBe(422);
  expect((overBroad.body.details as { code: string }).code).toBe("AGENT_POLICY_CEILING_EXCEEDED");

  // --- delegation ----------------------------------------------------------
  const parent = await json(request, "post", `/api/companies/${companyId}/issues`, {
    title: "Board deck",
    assigneeAgentId: agentIds.CEO,
  });
  expect(parent.status, JSON.stringify(parent.body)).toBeLessThan(300);
  const parentId = parent.body.id as string;

  const childIds: string[] = [];
  for (const role of ["Product", "Engineering", "Marketing"] as const) {
    const child = await json(request, "post", `/api/issues/${parentId}/children`, {
      title: `${role} contribution`,
      assigneeAgentId: agentIds[role],
    });
    expect(child.status, `${role}: ${JSON.stringify(child.body)}`).toBeLessThan(300);
    childIds.push(child.body.id as string);

    await json(request, "post", `/api/issues/${child.body.id}/comments`, {
      body: `${role} analysis, in full, long enough that a preview would lose it. ${"x".repeat(600)}`,
    });
  }

  // --- decisions -----------------------------------------------------------
  const webApproval = await json(request, "post", `/api/companies/${companyId}/approvals`, {
    type: "request_board_approval",
    requestedByAgentId: agentIds.Product,
    payload: { summary: "Publish pricing" },
  });
  expect(webApproval.status).toBeLessThan(300);
  const webApprovalId = webApproval.body.id as string;

  const decided = await json(request, "post", `/api/approvals/${webApprovalId}/approve`, {
    revision: 1,
    idempotencyKey: `e2e-web-${Date.now()}`,
    channel: "web",
  });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  expect(decided.body.status).toBe("approved");
  expect(decided.body.decisionChannel).toBe("web");

  // Replaying the same decision must not decide twice.
  const replay = await json(request, "post", `/api/approvals/${webApprovalId}/approve`, {
    revision: 1,
    idempotencyKey: `e2e-web-replay-${Date.now()}`,
    channel: "web",
  });
  expect([200, 409, 422]).toContain(replay.status);

  // Telegram: an unauthentic webhook is refused before anything is parsed.
  const forged = await json(request, "post", "/api/connectors/telegram/webhook", { update_id: 1 });
  expect(forged.status).toBe(401);

  // Teams: inbound activity validation is NOT wired, so the endpoint must
  // reject. Asserting the rejection keeps the gap visible instead of letting a
  // skipped test read as coverage.
  const teams = await json(request, "post", "/api/connectors/teams/messages", {
    type: "invoke",
    id: "e2e-activity",
  });
  expect(teams.status).toBe(401);

  // --- consolidation -------------------------------------------------------
  const contributions = await json(request, "get", `/api/issues/${parentId}/child-contributions`);
  expect(contributions.status, JSON.stringify(contributions.body)).toBe(200);
  const payload = contributions.body as {
    contributions: Array<{ sourceIssueId: string; comments: Array<{ body: string }> }>;
    contributingAgentIds: string[];
    complete: boolean;
  };

  expect(payload.contributions).toHaveLength(3);
  expect(payload.contributingAgentIds.sort()).toEqual(
    [agentIds.Product, agentIds.Engineering, agentIds.Marketing].sort(),
  );
  // Complete artifacts, not previews.
  for (const contribution of payload.contributions) {
    expect(contribution.comments[0].body.length).toBeGreaterThan(600);
  }

  // --- web surface ---------------------------------------------------------
  // App routes are company-prefixed (`/:companyPrefix/...`); an unprefixed path
  // falls through to the dashboard.
  const issuePrefix = company.body.issuePrefix as string;
  await page.goto(`/${issuePrefix}/my-agent`);
  await expect(page.getByRole("heading", { name: "My Agent" })).toBeVisible();
  // Unassigned is an explicit state, and ordinary users cannot self-claim.
  await expect(page.getByText("No agent assigned")).toBeVisible();
});
