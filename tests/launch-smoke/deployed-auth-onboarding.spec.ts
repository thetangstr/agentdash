import { expect, test, type Page } from "@playwright/test";

type CompanyRow = {
  id: string;
  name: string;
  issuePrefix?: string | null;
};

type BootstrapResult = {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
};

type ConversationMessage = {
  id: string;
  authorKind?: "user" | "agent";
  role?: "user" | "agent";
  body?: string | null;
  content?: string | null;
};

const BASE_URL = setting("AGENTDASH_LAUNCH_SMOKE_BASE_URL").replace(/\/+$/, "");
const REQUIRED = boolSetting("AGENTDASH_LAUNCH_SMOKE_REQUIRED");
const ALLOW_LOCAL = boolSetting("AGENTDASH_LAUNCH_SMOKE_ALLOW_LOCAL");
const REQUIRE_BILLING = boolSetting("AGENTDASH_LAUNCH_SMOKE_BILLING");
const EXPECT_LLM_REPLY = boolSetting("AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM");

const RUN_ID =
  process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test.skip(!BASE_URL && !REQUIRED, "Set AGENTDASH_LAUNCH_SMOKE_BASE_URL to run deployed launch smoke.");

test("deployed signup reaches CoS onboarding and optional billing gate", async ({ page }) => {
  const baseUrl = requireLaunchBaseUrl();
  const smokeUser = buildSmokeUser();

  await page.goto("/");
  await expect(page.locator("body")).toContainText(/AgentDash/i);

  await page.goto("/auth?mode=sign_up");
  await expect(page.getByRole("heading", { name: /create your workspace/i })).toBeVisible();
  await page.getByLabel("Name").fill(smokeUser.name);
  await page.getByLabel("Email").fill(smokeUser.email);
  await page.getByLabel("Password").fill(smokeUser.password);
  await page.getByRole("button", { name: /create account/i }).click();

  await page.waitForURL(/\/(company-create|assess|cos|companies|[A-Z0-9]+\/dashboard)/, { timeout: 45_000 });
  if (new URL(page.url()).pathname === "/company-create") {
    await page.getByLabel("Workspace name").fill(smokeUser.workspaceName);
    await page.getByRole("button", { name: /continue/i }).click();
    await page.waitForURL(/\/(assess|cos|companies|[A-Z0-9]+\/dashboard)/, { timeout: 45_000 });
  }

  await page.goto("/cos");
  await expect(page.getByText("Chief of Staff").first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/I'm your Chief of Staff at AgentDash/i)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByLabel("Message input")).toBeVisible();

  const bootstrap = await postJson<BootstrapResult>(page, baseUrl, "/api/onboarding/bootstrap", {});
  const companies = await getJson<CompanyRow[]>(page, baseUrl, "/api/companies");
  const company = companies.find((item) => item.id === bootstrap.companyId) ?? companies[0];
  expect(company, "launch smoke user should have a company after signup").toBeTruthy();

  await verifyComposerRoundTrip(page, baseUrl, bootstrap, company!.id);
  await verifyBillingGate(page, baseUrl, company!.id);
});

function setting(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function boolSetting(name: string): boolean {
  return /^(1|true|yes)$/i.test(setting(name));
}

function requireLaunchBaseUrl(): string {
  if (!BASE_URL) {
    throw new Error("AGENTDASH_LAUNCH_SMOKE_BASE_URL is required when AGENTDASH_LAUNCH_SMOKE_REQUIRED=true.");
  }
  const parsed = new URL(BASE_URL);
  const isLocal =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname.endsWith(".localhost");
  if (isLocal && !ALLOW_LOCAL) {
    throw new Error(
      "Refusing to run launch smoke against a local URL. Set AGENTDASH_LAUNCH_SMOKE_ALLOW_LOCAL=true for local-only dry runs.",
    );
  }
  if (parsed.protocol !== "https:" && !ALLOW_LOCAL) {
    throw new Error("Launch smoke requires an https URL unless AGENTDASH_LAUNCH_SMOKE_ALLOW_LOCAL=true.");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function buildSmokeUser() {
  const emailPattern =
    setting("AGENTDASH_LAUNCH_SMOKE_EMAIL") ||
    setting("AGENTDASH_LAUNCH_SMOKE_EMAIL_TEMPLATE") ||
    "agentdash.launch.smoke+{run}@gmail.com";
  const passwordPattern =
    setting("AGENTDASH_LAUNCH_SMOKE_PASSWORD") ||
    "AgentDashSmoke-{run}!a1";

  return {
    name: `Launch Smoke ${RUN_ID}`,
    email: replaceRunToken(emailPattern),
    password: replaceRunToken(passwordPattern),
    workspaceName: `Launch Smoke ${RUN_ID}`,
  };
}

function replaceRunToken(value: string): string {
  return value.replace(/\{run\}/g, RUN_ID);
}

async function getJson<T>(page: Page, baseUrl: string, path: string): Promise<T> {
  const response = await page.request.get(new URL(path, baseUrl).toString());
  expect(response.ok(), `${path} should return 2xx, got ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function postJson<T>(page: Page, baseUrl: string, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(new URL(path, baseUrl).toString(), { data });
  expect(response.ok(), `${path} should return 2xx, got ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function verifyComposerRoundTrip(
  page: Page,
  baseUrl: string,
  bootstrap: BootstrapResult,
  companyId: string,
) {
  const before = await getJson<ConversationMessage[]>(
    page,
    baseUrl,
    `/api/conversations/${bootstrap.conversationId}/messages?limit=100`,
  );
  const beforeAgentCount = before.filter(isAgentMessage).length;
  const smokeMessage = `Launch smoke ${RUN_ID}: confirm the CoS chat is live.`;

  await page.getByLabel("Message input").fill(smokeMessage);
  await page.getByRole("button", { name: /send message/i }).click();
  await expect(page.getByText(smokeMessage)).toBeVisible();

  if (!EXPECT_LLM_REPLY) return;

  await expect
    .poll(
      async () => {
        const messages = await getJson<ConversationMessage[]>(
          page,
          baseUrl,
          `/api/conversations/${bootstrap.conversationId}/messages?limit=100`,
        );
        return messages.filter(isAgentMessage).length;
      },
      { timeout: 60_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toBeGreaterThan(beforeAgentCount);

  const after = await getJson<ConversationMessage[]>(
    page,
    baseUrl,
    `/api/conversations/${bootstrap.conversationId}/messages?limit=100`,
  );
  const latestAgentReply = after.filter(isAgentMessage).at(-1);
  const text = latestAgentReply?.body ?? latestAgentReply?.content ?? "";
  expect(text).not.toMatch(/stub reply/i);
  expect(companyId).toBeTruthy();
}

async function verifyBillingGate(page: Page, baseUrl: string, companyId: string) {
  const status = await getJson<{ tier: string; seatsPaid: number; periodEnd: string | null }>(
    page,
    baseUrl,
    `/api/billing/status?companyId=${encodeURIComponent(companyId)}`,
  );
  expect(status.tier).toEqual(expect.any(String));

  if (!REQUIRE_BILLING) {
    test.info().annotations.push({
      type: "billing-checkout",
      description: "Set AGENTDASH_LAUNCH_SMOKE_BILLING=true to require Stripe checkout session creation.",
    });
    return;
  }

  const checkout = await postJson<{ url: string }>(page, baseUrl, "/api/billing/checkout-session", { companyId });
  expect(checkout.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
}

function isAgentMessage(message: ConversationMessage): boolean {
  return (message.authorKind ?? message.role) === "agent";
}
