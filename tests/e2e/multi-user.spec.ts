import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Multi-user implementation tests (local_trusted mode).
 *
 * Covers:
 *   1. Company member management API (list, update role, suspend)
 *   2. Human invite creation and acceptance API
 *   3. Company Settings UI — member list, role editing, invite creation
 *   4. Invite landing page UI
 *   5. Role-based access control (member management)
 *   6. Last-owner protection
 */

const BASE = process.env.PAPERCLIP_E2E_BASE_URL ?? "http://127.0.0.1:3104";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure the server is bootstrapped (claimed) before running tests. */
async function ensureBootstrapped(request: APIRequestContext): Promise<void> {
  const healthRes = await request.get(`${BASE}/api/health`);
  const health = await healthRes.json();
  if (health.bootstrapStatus === "ready") return;

  // If bootstrap_pending, we need to use the claim token from the bootstrap invite.
  // In local_trusted mode, just try hitting companies — that should auto-bootstrap.
  if (health.deploymentMode === "local_trusted") {
    // local_trusted should work without explicit bootstrap
    return;
  }
}

/** Create a company via the onboarding wizard API shortcut. */
async function createCompanyViaWizard(
  request: APIRequestContext,
  name: string
): Promise<{ companyId: string; agentId: string; prefix: string }> {
  await ensureBootstrapped(request);

  const createRes = await request.post(`${BASE}/api/companies`, {
    data: { name },
  });
  if (!createRes.ok()) {
    const errText = await createRes.text();
    throw new Error(
      `Failed to create company (${createRes.status()}): ${errText}`
    );
  }
  const company = await createRes.json();

  // Create a CEO agent
  const agentRes = await request.post(
    `${BASE}/api/companies/${company.id}/agents`,
    {
      data: {
        name: "CEO",
        role: "ceo",
        title: "CEO",
        adapterType: "claude_local",
      },
    }
  );
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json();

  return {
    companyId: company.id,
    agentId: agent.id,
    prefix: company.issuePrefix ?? company.id,
  };
}

/** Create a human invite and return token + invite URL. */
async function createHumanInvite(
  request: APIRequestContext,
  companyId: string,
  role: string = "member"
): Promise<{ token: string; inviteUrl: string; inviteId: string }> {
  const res = await request.post(
    `${BASE}/api/companies/${companyId}/invites`,
    {
      data: {
        allowedJoinTypes: "human",
        humanRole: role,
      },
    }
  );
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return {
    token: body.token,
    inviteUrl: body.inviteUrl,
    inviteId: body.id,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** A pending web-font fetch holds `load`; abort externals so goto can't stall. */
async function abortExternalFonts(page: Page) {
  await page.route(/fonts\.(gstatic|googleapis)\.com/, (route) => route.abort());
}

test.describe("Multi-user: API", () => {
  let companyId: string;

  test.beforeAll(async ({ request }) => {
    const result = await createCompanyViaWizard(
      request,
      `MU-API-${Date.now()}`
    );
    companyId = result.companyId;
  });

  test("GET /companies/:id/members returns member list with access info", async ({
    request,
  }) => {
    const res = await request.get(
      `${BASE}/api/companies/${companyId}/members`
    );
    expect(res.ok()).toBe(true);
    const body = await res.json();

    expect(body).toHaveProperty("members");
    expect(body).toHaveProperty("access");
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.access).toHaveProperty("currentUserRole");
    expect(body.access).toHaveProperty("canManageMembers");
    expect(body.access).toHaveProperty("canInviteUsers");
  });

  test("POST /companies/:id/invites creates a human invite with role", async ({
    request,
  }) => {
    const res = await request.post(
      `${BASE}/api/companies/${companyId}/invites`,
      {
        data: {
          allowedJoinTypes: "human",
          humanRole: "member",
        },
      }
    );
    expect(res.ok()).toBe(true);
    const body = await res.json();

    expect(body).toHaveProperty("token");
    expect(body).toHaveProperty("inviteUrl");
    expect(body.allowedJoinTypes).toBe("human");
    expect(body.inviteUrl).toContain("/invite/");
  });

  test("GET /invites/:token returns invite summary", async ({ request }) => {
    const invite = await createHumanInvite(request, companyId, "member");
    const res = await request.get(`${BASE}/api/invites/${invite.token}`);
    expect(res.ok()).toBe(true);
    const body = await res.json();

    expect(body).toHaveProperty("companyId");
    expect(body).toHaveProperty("allowedJoinTypes");
    expect(body.allowedJoinTypes).toBe("human");
    expect(body).toHaveProperty("inviteType");
    expect(body.inviteType).toBe("company_join");
  });

  test("POST /invites/:token/accept (human) creates membership", async ({
    request,
  }) => {
    const invite = await createHumanInvite(request, companyId, "member");
    const acceptRes = await request.post(
      `${BASE}/api/invites/${invite.token}/accept`,
      {
        data: { requestType: "human" },
      }
    );
    expect(acceptRes.ok()).toBe(true);
    const body = await acceptRes.json();

    // In local_trusted, human accept should succeed
    expect(body).toHaveProperty("id");
  });

  test("POST /invites/:token/accept rejects agent on human-only invite", async ({
    request,
  }) => {
    const invite = await createHumanInvite(request, companyId, "member");
    const acceptRes = await request.post(
      `${BASE}/api/invites/${invite.token}/accept`,
      {
        data: { requestType: "agent", agentName: "Rogue" },
      }
    );
    expect(acceptRes.ok()).toBe(false);
    expect(acceptRes.status()).toBe(400);
  });

  test("POST /companies/:id/invites supports both human roles", async ({
    request,
  }) => {
    for (const role of ["admin", "member"]) {
      const res = await request.post(
        `${BASE}/api/companies/${companyId}/invites`,
        {
          data: { allowedJoinTypes: "human", humanRole: role },
        }
      );
      expect(res.ok()).toBe(true);
      const body = await res.json();
      expect(body.token).toBeTruthy();
    }
  });

  test("PATCH /companies/:id/members/:memberId refuses to demote the sole admin", async ({
    request,
  }) => {
    // Create a fresh company for this test
    const fresh = await createCompanyViaWizard(
      request,
      `MU-LastAdmin-${Date.now()}`
    );

    const membersRes = await request.get(
      `${BASE}/api/companies/${fresh.companyId}/members`
    );
    const { members } = await membersRes.json();

    // Find the board member (should be the only one, and the only admin)
    const boardMember = members.find(
      (m: { principalId: string }) => m.principalId === "local-board"
    );
    if (!boardMember) {
      test.skip();
      return;
    }

    // In local_trusted the actor IS local-board, so the self-protection guard
    // fires first: a board user cannot demote or remove its own membership,
    // which is what keeps the last admin in place through this API.
    const demoteRes = await request.patch(
      `${BASE}/api/companies/${fresh.companyId}/members/${boardMember.id}`,
      { data: { membershipRole: "member" } }
    );
    expect(demoteRes.status()).toBe(403);
    const errBody = await demoteRes.json();
    expect(JSON.stringify(errBody)).toContain("cannot remove yourself");
  });

  test("POST /companies/:id/openclaw/invite-prompt creates agent invite", async ({
    request,
  }) => {
    const res = await request.post(
      `${BASE}/api/companies/${companyId}/openclaw/invite-prompt`,
      {
        data: { agentMessage: "E2E test agent invite" },
      }
    );
    expect(res.ok()).toBe(true);
    const body = await res.json();

    expect(body).toHaveProperty("token");
    expect(body).toHaveProperty("inviteUrl");
    expect(body.allowedJoinTypes).toBe("agent");
  });
});

test.describe("Multi-user: Company Settings UI", () => {
  let companyId: string;
  let companyPrefix: string;

  test.beforeEach(async ({ page }) => abortExternalFonts(page));

  test.beforeAll(async ({ request }) => {
    const result = await createCompanyViaWizard(
      request,
      `MU-UI-${Date.now()}`
    );
    companyId = result.companyId;
    companyPrefix = result.prefix;
  });

  test("shows Team and Advanced (invite) sections on settings page", async ({ page }) => {
    await page.goto(`${BASE}/${companyPrefix}/company/settings`);
    await page.waitForLoadState("networkidle");
    // Scan 4: the OpenClaw invite sits inside the collapsed Advanced section.
    await expect(page.getByTestId("company-settings-advanced")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId("company-settings-advanced").locator("summary").click();
    await expect(page.getByTestId("company-settings-invites-section")).toBeVisible();
    await expect(page.getByTestId("company-settings-team-section")).toBeVisible({
      timeout: 10_000,
    });
  });

  // Human invite creation lives on the dedicated Invites page now.
  test("shows human invite creation controls", async ({ page }) => {
    await page.goto(`${BASE}/${companyPrefix}/company/settings/invites`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Choose a role")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("radio", { name: /^Member\b/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Admin\b/ })).toBeVisible();
    await expect(page.getByText("Auto-approve on accept")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create invite" })
    ).toBeVisible();
  });

  test("can create human invite and shows URL", async ({ page }) => {
    await page.goto(`${BASE}/${companyPrefix}/company/settings/invites`);
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("button", { name: "Create invite" })
      .click();

    await expect(page.getByTestId("latest-invite-url")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("latest-invite-url")).toContainText("/invite/");
  });
});

test.describe("Multi-user: Invite Landing UI", () => {
  let companyId: string;
  let inviteToken: string;

  test.beforeEach(async ({ page }) => abortExternalFonts(page));

  test.beforeAll(async ({ request }) => {
    const result = await createCompanyViaWizard(
      request,
      `MU-Invite-${Date.now()}`
    );
    companyId = result.companyId;

    const invite = await createHumanInvite(request, companyId, "member");
    inviteToken = invite.token;
  });

  test("invite landing page loads with join options", async ({ page }) => {
    await page.goto(`${BASE}/invite/${inviteToken}`);
    await page.waitForLoadState("networkidle");

    // Should show the invite landing page heading
    await expect(
      page.getByRole("heading", { name: /join/i })
    ).toBeVisible({ timeout: 10_000 });
  });

  test("invite landing shows the invited member role, not the agent form", async ({ page }) => {
    await page.goto(`${BASE}/invite/${inviteToken}`);
    await page.waitForLoadState("networkidle");

    // For a human-only invite the landing reports the requested access as the
    // invited role and does not offer the agent-join form.
    await expect(page.getByText("Requested access")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Member").first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Submit agent details" })
    ).toHaveCount(0);
  });

  test("expired/invalid invite token returns error", async ({ page }) => {
    await page.goto(`${BASE}/invite/invalid-token-e2e-test`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("invite-error")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Multi-user: Member role management API", () => {
  let companyId: string;

  test.beforeAll(async ({ request }) => {
    const result = await createCompanyViaWizard(
      request,
      `MU-Roles-${Date.now()}`
    );
    companyId = result.companyId;
  });

  test("invite + accept creates member with correct role", async ({
    request,
  }) => {
    // Create invite for 'member' role
    const invite = await createHumanInvite(request, companyId, "member");

    // Accept the invite
    const acceptRes = await request.post(
      `${BASE}/api/invites/${invite.token}/accept`,
      { data: { requestType: "human" } }
    );
    expect(acceptRes.ok()).toBe(true);

    // Check members list
    const membersRes = await request.get(
      `${BASE}/api/companies/${companyId}/members`
    );
    const { members } = await membersRes.json();

    // Should have at least one member (the creator/local-board)
    expect(members.length).toBeGreaterThanOrEqual(1);
  });

  test("PATCH member role updates correctly", async ({ request }) => {
    // First create an invite and accept it to get a second member
    const invite = await createHumanInvite(request, companyId, "member");
    const acceptRes = await request.post(
      `${BASE}/api/invites/${invite.token}/accept`,
      { data: { requestType: "human" } }
    );
    expect(acceptRes.ok()).toBe(true);

    // List members
    const membersRes = await request.get(
      `${BASE}/api/companies/${companyId}/members`
    );
    const { members } = await membersRes.json();

    // Find a non-admin member to modify
    const nonAdmin = members.find(
      (m: { membershipRole: string }) => m.membershipRole !== "admin"
    );
    if (!nonAdmin) {
      test.skip();
      return;
    }

    // Update role to admin
    const patchRes = await request.patch(
      `${BASE}/api/companies/${companyId}/members/${nonAdmin.id}`,
      { data: { membershipRole: "admin" } }
    );
    expect(patchRes.ok()).toBe(true);
    const updated = await patchRes.json();
    expect(updated.membershipRole).toBe("admin");
  });

  test("PATCH member status to suspended works", async ({ request }) => {
    // Create another member
    const invite = await createHumanInvite(request, companyId, "member");
    await request.post(`${BASE}/api/invites/${invite.token}/accept`, {
      data: { requestType: "human" },
    });

    const membersRes = await request.get(
      `${BASE}/api/companies/${companyId}/members`
    );
    const { members } = await membersRes.json();

    const nonAdmin = members.find(
      (m: { membershipRole: string; status: string }) =>
        m.membershipRole !== "admin" && m.status === "active"
    );
    if (!nonAdmin) {
      test.skip();
      return;
    }

    const patchRes = await request.patch(
      `${BASE}/api/companies/${companyId}/members/${nonAdmin.id}`,
      { data: { status: "suspended" } }
    );
    expect(patchRes.ok()).toBe(true);
    const updated = await patchRes.json();
    expect(updated.status).toBe("suspended");
  });
});

test.describe("Multi-user: Agent invite flow", () => {
  let companyId: string;

  test.beforeAll(async ({ request }) => {
    const result = await createCompanyViaWizard(
      request,
      `MU-Agent-${Date.now()}`
    );
    companyId = result.companyId;
  });

  test("agent invite accept creates pending join request", async ({
    request,
  }) => {
    // Create agent invite
    const res = await request.post(
      `${BASE}/api/companies/${companyId}/openclaw/invite-prompt`,
      { data: {} }
    );
    expect(res.ok()).toBe(true);
    const { token } = await res.json();

    // Accept as agent
    const acceptRes = await request.post(
      `${BASE}/api/invites/${token}/accept`,
      {
        data: {
          requestType: "agent",
          agentName: "TestAgent",
          adapterType: "claude_local",
        },
      }
    );
    expect(acceptRes.ok()).toBe(true);
    const body = await acceptRes.json();
    expect(body).toHaveProperty("id");
    expect(body.status).toBe("pending_approval");
  });

  test("join requests list shows pending agent request", async ({
    request,
  }) => {
    const res = await request.get(
      `${BASE}/api/companies/${companyId}/join-requests?status=pending_approval`
    );
    expect(res.ok()).toBe(true);
    const requests = await res.json();
    expect(Array.isArray(requests)).toBe(true);
  });
});

test.describe("Multi-user: Health check integration", () => {
  test("health endpoint reports deployment mode", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("deploymentMode");
    expect(body).toHaveProperty("authReady");
    expect(body.authReady).toBe(true);
  });
});
