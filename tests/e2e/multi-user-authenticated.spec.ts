import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type Browser, type Page } from "@playwright/test";

const BASE = process.env.PAPERCLIP_E2E_BASE_URL ?? "http://127.0.0.1:3105";
const DATA_DIR = process.env.PAPERCLIP_E2E_DATA_DIR ?? process.env.PAPERCLIP_HOME;
const CONFIG_PATH = process.env.PAPERCLIP_E2E_CONFIG_PATH ?? path.resolve(process.cwd(), ".paperclip/config.json");
const BOOTSTRAP_SCRIPT_PATH = path.resolve(process.cwd(), "packages/db/scripts/create-auth-bootstrap-invite.ts");
const OWNER_PASSWORD = "paperclip-owner-password";
const INVITED_PASSWORD = "paperclip-invited-password";
const AUTH_SIGN_IN_HEADING = "Welcome back";
const AUTH_SIGN_UP_HEADING = "Create your workspace";
const BOOTSTRAP_INVITE_HEADING = "Set up Paperclip";

type HumanUser = {
  name: string;
  email: string;
  password: string;
};

type CompanySummary = {
  id: string;
  name: string;
  issuePrefix?: string | null;
};

type CompanyMember = {
  id: string;
  membershipRole: "owner" | "admin" | "operator" | "viewer";
  status: "pending" | "active" | "suspended";
  user: { id: string; email: string | null; name: string | null } | null;
};

type SessionJsonResponse<T> = {
  ok: boolean;
  status: number;
  text: string;
  json: T | null;
};

const runId = Date.now();
const companyName = `MU-Auth-${runId}`;
const ownerUser: HumanUser = {
  name: "Owner User",
  email: `owner-${runId}@paperclip.local`,
  password: OWNER_PASSWORD,
};
const invitedUser: HumanUser = {
  name: "Invited User",
  email: `invitee-${runId}@paperclip.local`,
  password: INVITED_PASSWORD,
};

function createBootstrapInvite() {
  if (!DATA_DIR) {
    throw new Error("PAPERCLIP_E2E_DATA_DIR or PAPERCLIP_HOME is required for authenticated bootstrap tests");
  }
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Authenticated bootstrap config not found at ${CONFIG_PATH}`);
  }
  if (!existsSync(BOOTSTRAP_SCRIPT_PATH)) {
    throw new Error(`Authenticated bootstrap helper not found at ${BOOTSTRAP_SCRIPT_PATH}`);
  }

  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return execFileSync(
    pnpmCommand,
    [
      "--filter",
      "@paperclipai/db",
      "exec",
      "tsx",
      BOOTSTRAP_SCRIPT_PATH,
      "--config",
      CONFIG_PATH,
      "--base-url",
      BASE,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        PAPERCLIP_HOME: DATA_DIR,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  ).trim();
}

async function signUp(page: Page, user: HumanUser) {
  await page.goto(`${BASE}/auth`);
  await expect(page.getByRole("heading", { name: AUTH_SIGN_IN_HEADING })).toBeVisible();
  await page.getByRole("button", { name: "Create one" }).click();
  await expect(page.getByRole("heading", { name: AUTH_SIGN_UP_HEADING })).toBeVisible();
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function acceptBootstrapInvite(page: Page, inviteUrl: string) {
  const token = inviteUrl.split("/invite/")[1];
  expect(token).toBeTruthy();
  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: BOOTSTRAP_INVITE_HEADING })).toBeVisible();
  const acceptResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().includes(`/invites/${token}/accept`)
  );
  await page.getByRole("button", { name: "Accept invite" }).click();
  const acceptResponse = await acceptResponsePromise;
  expect(acceptResponse.status()).toBe(202);
  await expect(acceptResponse.json()).resolves.toMatchObject({
    bootstrapAccepted: true,
  });
  await page.goto(`${BASE}/`);
}

async function createCompanyForSession(page: Page, nextCompanyName: string) {
  const createRes = await sessionJsonRequest<CompanySummary>(page, `${BASE}/api/companies`, {
    method: "POST",
    data: { name: nextCompanyName },
  });
  expect(createRes.ok).toBe(true);
  expect(createRes.json).toBeTruthy();
  return createRes.json!;
}

async function createAuthenticatedInvite(page: Page, companyPrefix: string) {
  await page.goto(`${BASE}/${companyPrefix}/company/settings/invites`);
  await expect(page.getByRole("heading", { name: "Company Invites" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("radio", { name: /Operator/ }).check();
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByText("Latest invite link")).toBeVisible({ timeout: 20_000 });
  const inviteUrlButton = page.getByRole("button", { name: /\/invite\// }).first();
  await expect(inviteUrlButton).toBeVisible({ timeout: 20_000 });
  const inviteUrl = (await inviteUrlButton.textContent())?.trim() ?? "";
  expect(inviteUrl).toContain("/invite/");
  return inviteUrl;
}

async function signUpFromInvite(page: Page, inviteUrl: string, user: HumanUser) {
  await page.goto(inviteUrl);
  await expect(page.getByTestId("invite-inline-auth")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account and continue" }).click();
  await expect(page.getByTestId("invite-pending-approval")).toBeVisible({
    timeout: 20_000,
  });
}

async function approvePendingHumanJoin(page: Page, companyPrefix: string, email: string) {
  await page.goto(`${BASE}/${companyPrefix}/company/settings/access`);
  await expect(page.getByRole("heading", { name: "Company Access" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(email)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Approve human" }).click();
  await expect(page.getByRole("button", { name: "Approve human" })).toHaveCount(0, {
    timeout: 20_000,
  });
}

async function updateMemberRole(page: Page, companyPrefix: string, email: string, role: CompanyMember["membershipRole"]) {
  await page.goto(`${BASE}/${companyPrefix}/company/settings/access`);
  await expect(page.getByRole("heading", { name: "Company Access" })).toBeVisible({
    timeout: 20_000,
  });
  const memberRow = page
    .getByText(email)
    .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " grid ")][1]');
  await expect(memberRow).toBeVisible({ timeout: 20_000 });
  await memberRow.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit member" });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByLabel("Company role").selectOption(role ?? "");
  await dialog.getByRole("button", { name: "Save access" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
}

async function sessionJsonRequest<T>(
  page: Page,
  url: string,
  options: {
    method?: string;
    data?: unknown;
  } = {}
) {
  return page.evaluate(
    async ({ url: targetUrl, method, data }) => {
      const response = await fetch(targetUrl, {
        method,
        credentials: "include",
        headers: data === undefined ? undefined : { "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const text = await response.text();
      let json: unknown = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        text,
        json,
      };
    },
    {
      url,
      method: options.method ?? "GET",
      data: options.data,
    }
  ) as Promise<SessionJsonResponse<T>>;
}

async function waitForMember(page: Page, companyId: string, email: string) {
  let member: CompanyMember | null = null;
  await expect
    .poll(
      async () => {
        const membersRes = await sessionJsonRequest<{ members: CompanyMember[] }>(
          page,
          `${BASE}/api/companies/${companyId}/members`
        );
        expect(membersRes.ok).toBe(true);
        const body = membersRes.json;
        if (!body) return null;
        member = body.members.find((entry) => entry.user?.email === email) ?? null;
        return member;
      },
      {
        timeout: 20_000,
        intervals: [500, 1_000, 2_000],
      }
    )
    .toMatchObject({
      status: "active",
      membershipRole: "operator",
      user: { email },
    });
  return member!;
}

async function waitForMemberRole(
  page: Page,
  companyId: string,
  memberId: string,
  membershipRole: CompanyMember["membershipRole"]
) {
  await expect
    .poll(
      async () => {
        const membersRes = await sessionJsonRequest<{ members: CompanyMember[] }>(
          page,
          `${BASE}/api/companies/${companyId}/members`
        );
        expect(membersRes.ok).toBe(true);
        const body = membersRes.json;
        if (!body) return null;
        return body.members.find((member) => member.id === memberId) ?? null;
      },
      {
        timeout: 20_000,
        intervals: [500, 1_000, 2_000],
      }
    )
    .toMatchObject({
      id: memberId,
      membershipRole,
    });
}

async function newPage(browser: Browser) {
  const context = await browser.newContext({
    storageState: {
      cookies: [],
      origins: [],
    },
  });
  await context.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  const page = await context.newPage();
  return { context, page };
}

test.describe("Multi-user: authenticated mode", () => {
  test("authenticated humans can bootstrap, invite, join, and respect viewer restrictions", async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000);

    const healthRes = await page.request.get(`${BASE}/api/health`);
    expect(healthRes.ok()).toBe(true);
    const health = (await healthRes.json()) as {
      deploymentMode?: string;
      bootstrapStatus?: string;
    };
    expect(health.deploymentMode).toBe("authenticated");

    await signUp(page, ownerUser);
    await acceptBootstrapInvite(page, createBootstrapInvite());

    const company = await createCompanyForSession(page, companyName);
    const companyPrefix = company.issuePrefix ?? company.id;
    await page.goto(`${BASE}/${companyPrefix}/dashboard`);
    const accountMenu = page.getByRole("button", { name: "Open account menu" });
    await expect(accountMenu).toContainText(ownerUser.name);
    await accountMenu.click();
    await expect(page.getByText(ownerUser.email)).toBeVisible();
    const inviteUrl = await createAuthenticatedInvite(page, companyPrefix);

    const invited = await newPage(browser);
    try {
      await signUpFromInvite(invited.page, inviteUrl, invitedUser);

      await approvePendingHumanJoin(page, companyPrefix, invitedUser.email);
      await invited.page.reload();
      await expect(invited.page).not.toHaveURL(/\/auth/, { timeout: 10_000 });

      const joinedMember = await waitForMember(page, company.id, invitedUser.email);

      await updateMemberRole(page, companyPrefix, invitedUser.email, "viewer");
      await waitForMemberRole(page, company.id, joinedMember.id, "viewer");

      await invited.page.goto(`${BASE}/${companyPrefix}/company/settings/invites`);
      await expect(
        invited.page.getByText("You do not have permission to manage company invites.")
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        invited.page.getByRole("button", { name: "Create invite" })
      ).toHaveCount(0);

      const forbiddenInviteRes = await sessionJsonRequest(
        invited.page,
        `${BASE}/api/companies/${company.id}/invites`,
        {
          method: "POST",
          data: {
            allowedJoinTypes: "human",
            humanRole: "viewer",
          },
        }
      );
      expect(forbiddenInviteRes.status).toBe(403);
    } finally {
      await invited.context.close();
    }
  });
});
