import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";

/**
 * AgentDash-MK acceptance criterion 11, agent-authenticated half.
 *
 * `agentdash-mk-workforce.spec.ts` proves the delegation and consolidation
 * scenario, but it drives every call as a board actor. The criterion says
 * "agent-authenticated execution", so the half that matters most — that an
 * agent acting with its OWN key can do its work and cannot do anyone else's —
 * was unproven end to end.
 *
 * The trap this spec is built around: in `local_trusted` mode an unrecognized
 * or absent agent key does NOT fail. `agentAuth` calls `next()` and the actor
 * falls back to the implicit local board, which is an instance admin. A spec
 * that sent `x-agent-key` and asserted 200 would pass just as happily with the
 * header misspelled, the key revoked, or the value garbage — it would be
 * asserting that the board can do things, in a file named for agents.
 *
 * So every agent context is required to prove its identity through
 * `GET /api/agents/me` before it is used. That route is the only one that
 * distinguishes the two: it 401s for a board actor and returns the agent for an
 * agent actor. `agentContext()` will not hand back a context that fails it.
 */

async function json(
  api: APIRequestContext,
  method: "get" | "post" | "put" | "patch",
  url: string,
  data?: unknown,
) {
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

test("agents execute the workforce loop under their own keys and cannot borrow each other's", async ({
  request,
  baseURL,
}) => {
  const disposable: APIRequestContext[] = [];

  /**
   * Build a request context authenticated as one agent, and refuse to return it
   * unless the server agrees it IS that agent. Without this assertion the
   * local_trusted board fallback silently satisfies every later expectation.
   */
  async function agentContext(agentId: string, token: string, label: string) {
    const context = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { "x-agent-key": token },
    });
    disposable.push(context);

    const me = await json(context, "get", "/api/agents/me");
    expect(me.status, `${label} key was not accepted as agent auth: ${JSON.stringify(me.body)}`).toBe(
      200,
    );
    expect(me.body.id, `${label} key authenticated as the wrong principal`).toBe(agentId);
    return context;
  }

  try {
    // --- setup, as the board -------------------------------------------------
    const company = await json(request, "post", "/api/companies", {
      name: `MK AgentAuth ${Date.now()}`,
      productProfile: "agentdash_mk",
    });
    expect(company.status, JSON.stringify(company.body)).toBeLessThan(300);
    const companyId = company.body.id as string;

    const roles = ["CEO", "Product", "Engineering", "Marketing"] as const;
    const agentIds: Record<string, string> = {};
    const agentApi: Record<string, APIRequestContext> = {};

    for (const role of roles) {
      const created = await json(request, "post", `/api/companies/${companyId}/agents`, {
        name: `${role} Agent`,
        role: role === "CEO" ? "ceo" : "engineer",
        adapterType: "process",
        // A process agent needs a command: without one it is rejected at creation,
        // because such an agent is accepted and then fails every run. These are
        // addressed over the API rather than executed; process.execPath is the
        // convention already used by the sibling specs.
        adapterConfig: { command: process.execPath },
      });
      expect(created.status, `${role}: ${JSON.stringify(created.body)}`).toBeLessThan(300);
      agentIds[role] = created.body.id as string;

      const key = await json(request, "post", `/api/agents/${agentIds[role]}/keys`, {
        name: `${role} e2e key`,
      });
      expect(key.status, `${role} key: ${JSON.stringify(key.body)}`).toBe(201);
      // The plaintext token is returned exactly once, at creation.
      const token = key.body.token as string;
      expect(token, `${role} key response carried no token`).toBeTruthy();

      agentApi[role] = await agentContext(agentIds[role], token, role);
    }

    // A garbage key must NOT authenticate as an agent. This is the fallback trap
    // stated as an assertion: in local_trusted the request still succeeds as the
    // board, so the only observable difference is that /agents/me refuses it.
    const impostor = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { "x-agent-key": "not-a-real-key" },
    });
    disposable.push(impostor);
    const impostorMe = await json(impostor, "get", "/api/agents/me");
    expect(impostorMe.status, "an unknown agent key was accepted as agent auth").toBe(401);

    // --- delegation, by the CEO agent ---------------------------------------
    // Assigning work is a granted authority, not an inherent one; the board
    // grants it and the CEO agent then exercises it under its own key.
    const grant = await json(request, "patch", `/api/agents/${agentIds.CEO}/permissions`, {
      canAssignTasks: true,
      canCreateAgents: false,
    });
    expect(grant.status, `grant: ${JSON.stringify(grant.body)}`).toBeLessThan(300);

    const parent = await json(request, "post", `/api/companies/${companyId}/issues`, {
      title: "Board deck",
      assigneeAgentId: agentIds.CEO,
    });
    expect(parent.status, JSON.stringify(parent.body)).toBeLessThan(300);
    const parentId = parent.body.id as string;

    const childIds: Record<string, string> = {};
    for (const role of ["Product", "Engineering", "Marketing"] as const) {
      const child = await json(agentApi.CEO, "post", `/api/issues/${parentId}/children`, {
        title: `${role} contribution`,
        assigneeAgentId: agentIds[role],
      });
      expect(
        child.status,
        `CEO agent could not delegate to ${role}: ${JSON.stringify(child.body)}`,
      ).toBeLessThan(300);
      childIds[role] = child.body.id as string;
    }

    // --- execution, by each stakeholder agent under its own key --------------
    for (const role of ["Product", "Engineering", "Marketing"] as const) {
      const comment = await json(agentApi[role], "post", `/api/issues/${childIds[role]}/comments`, {
        body: `${role} analysis, in full, long enough that a preview would lose it. ${"x".repeat(600)}`,
      });
      expect(
        comment.status,
        `${role} agent could not write to its own issue: ${JSON.stringify(comment.body)}`,
      ).toBeLessThan(300);
    }

    // The negative half. Marketing's key must not reach Engineering's issue —
    // an agent's authority is its assignment, not its company membership.
    const trespass = await json(
      agentApi.Marketing,
      "post",
      `/api/issues/${childIds.Engineering}/comments`,
      { body: "written with the wrong agent's key" },
    );
    // Pinned to the exact refusal, not a >=400 range: a 404 or a 500 would
    // satisfy a range while meaning something entirely different, and the point
    // of this assertion is *why* it was refused.
    expect(
      trespass.status,
      `Marketing's key reached Engineering's issue: ${JSON.stringify(trespass.body)}`,
    ).toBe(403);
    expect(trespass.body.error).toBe("Agent cannot mutate another agent's issue");

    // --- governed action, requested by an agent ------------------------------
    const approval = await json(agentApi.Product, "post", `/api/companies/${companyId}/approvals`, {
      type: "request_board_approval",
      payload: { summary: "Publish pricing" },
    });
    expect(approval.status, `agent-requested approval: ${JSON.stringify(approval.body)}`).toBeLessThan(
      300,
    );
    // The requester is derived from the key, never from the body.
    expect(approval.body.requestedByAgentId).toBe(agentIds.Product);
    const approvalId = approval.body.id as string;

    // An agent must not decide its own request. The decision boundary belongs to
    // the human steward regardless of which credential asks.
    const selfDecide = await json(agentApi.Product, "post", `/api/approvals/${approvalId}/approve`, {
      revision: 1,
      idempotencyKey: `e2e-agent-self-${Date.now()}`,
      channel: "web",
    });
    expect(
      selfDecide.status,
      `an agent decided its own approval: ${JSON.stringify(selfDecide.body)}`,
    ).toBe(403);
    // The refusal has to have left the approval undecided. A 403 that still
    // wrote a decision would satisfy the status assertion and defeat the point.
    const stillPending = await json(request, "get", `/api/approvals/${approvalId}`);
    expect(stillPending.body.status, "the refused agent decision was recorded anyway").toBe(
      "pending",
    );

    const decided = await json(request, "post", `/api/approvals/${approvalId}/approve`, {
      revision: 1,
      idempotencyKey: `e2e-agent-web-${Date.now()}`,
      channel: "web",
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.status).toBe("approved");

    // --- consolidation, by the CEO agent -------------------------------------
    const contributions = await json(
      agentApi.CEO,
      "get",
      `/api/issues/${parentId}/child-contributions`,
    );
    expect(contributions.status, JSON.stringify(contributions.body)).toBe(200);
    const payload = contributions.body as unknown as {
      contributions: Array<{ comments: Array<{ body: string }> }>;
      contributingAgentIds: string[];
    };
    expect(payload.contributions).toHaveLength(3);
    expect(payload.contributingAgentIds.sort()).toEqual(
      [agentIds.Product, agentIds.Engineering, agentIds.Marketing].sort(),
    );
    for (const contribution of payload.contributions) {
      // Complete artifacts, not previews — the same guarantee the board path has.
      expect(contribution.comments[0].body.length).toBeGreaterThan(600);
    }
  } finally {
    await Promise.all(disposable.map((context) => context.dispose()));
  }
});
