/**
 * E2E: AgentDash onboarding flow — sign-up → CoS chat → 4-message welcome → reply
 *
 * Must be run with playwright-onboarding-flow.config.ts which boots a fresh
 * server in `authenticated` mode on port 3198.
 *
 * Pattern mirrors multi-user-authenticated.spec.ts:
 *   beforeAll runs the bootstrap-ceo invite script and accepts the invite so
 *   that regular sign-up is unlocked on the fresh instance.
 *
 * Test isolation: each test signs up with a unique email; no global state is
 * shared between tests (unique emails + separate browser contexts where needed).
 *
 * Set E2E_REQUIRE_REAL_LLM=true to fail when the dispatch-llm stub reply is
 * returned (i.e. no ANTHROPIC_API_KEY). Without that flag Test 3 accepts the
 * stub and emits a console.warn.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type Browser, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

// When running via playwright-onboarding-flow.config.ts the config file sets
// PAPERCLIP_E2E_BASE_URL and PAPERCLIP_E2E_PORT via process.env mutations at
// config-file evaluation time. Tests workers inherit the process env.
const BASE =
  process.env.PAPERCLIP_E2E_BASE_URL ??
  `http://127.0.0.1:${process.env.PAPERCLIP_E2E_PORT ?? 3198}`;

// Home dir and generated config path from the playwright config
const DATA_DIR = process.env.PAPERCLIP_E2E_HOME ?? process.env.PAPERCLIP_HOME;
const CONFIG_PATH =
  process.env.PAPERCLIP_E2E_CONFIG_PATH ??
  (DATA_DIR
    ? path.join(DATA_DIR, "instances", "playwright-onboarding-e2e", "config.json")
    : null);

const BOOTSTRAP_SCRIPT_PATH = path.resolve(
  process.cwd(),
  "packages/db/scripts/create-auth-bootstrap-invite.ts",
);

// Must match packages/shared/src/types/interview.ts FIXED_QUESTIONS[0]
const FIXED_QUESTION_0 = "What's your business and who's it for?";

// Must match server/src/services/anthropic-llm.ts STUB_REPLY
const LLM_STUB_REPLY = "Got it. (stub reply — set ANTHROPIC_API_KEY to wire real Claude)";

const REQUIRE_REAL_LLM = process.env.E2E_REQUIRE_REAL_LLM === "true";

// ---------------------------------------------------------------------------
// Bootstrap helpers (mirrors multi-user-authenticated.spec.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Run the DB bootstrap-invite script and return the invite URL.
 * This script inserts a bootstrap_ceo invite into the DB and prints the URL.
 */
function createBootstrapInvite(): string {
  if (!DATA_DIR) {
    throw new Error(
      "PAPERCLIP_E2E_HOME (or PAPERCLIP_HOME) is required. " +
        "Run this spec via playwright-onboarding-flow.config.ts.",
    );
  }
  if (!CONFIG_PATH || !existsSync(CONFIG_PATH)) {
    throw new Error(
      `Bootstrap config not found at ${CONFIG_PATH ?? "(null)"}. ` +
        "The webServer must have started successfully first.",
    );
  }
  if (!existsSync(BOOTSTRAP_SCRIPT_PATH)) {
    throw new Error(`Bootstrap helper not found at ${BOOTSTRAP_SCRIPT_PATH}`);
  }

  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return execFileSync(
    pnpmCmd,
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
    },
  ).trim();
}

/**
 * Accept the bootstrap invite as an admin user.
 * This is the Paperclip "bootstrap_ceo" gate that must be cleared before
 * regular sign-up is available in authenticated mode.
 */
/**
 * Accept the bootstrap_ceo invite.
 *
 * In authenticated mode with a fresh DB there is no session yet, so the invite
 * landing page (InviteLanding.tsx) shows an inline account-creation form first.
 * After creating the bootstrap account the page transitions to a signed-in
 * "Accept bootstrap invite" panel. We click that and wait for "Bootstrap complete".
 */
/**
 * Accept the bootstrap_ceo invite.
 *
 * InviteLanding.tsx auto-accepts the bootstrap_ceo invite immediately after
 * account creation (authMutation.onSuccess runs acceptMutation then navigates
 * to "/"). So we just need to fill the inline sign-up form and click submit —
 * after that the page auto-navigates away from /invite/.
 */
async function acceptBootstrapInvite(page: Page, inviteUrl: string) {
  await page.goto(inviteUrl);

  // Wait for the invite page to render (h1 = "Set up Paperclip" for bootstrap_ceo)
  await expect(
    page.getByRole("heading", { name: "Set up Paperclip" }),
  ).toBeVisible({ timeout: 15_000 });

  // Fill the inline sign-up form (shown when no session exists)
  const inlineAuthForm = page.getByTestId("invite-inline-auth");
  await expect(inlineAuthForm).toBeVisible({ timeout: 10_000 });

  // The form has Name, Email, Password fields in sign_up mode
  await page.locator('[data-testid="invite-inline-auth"] input[name="name"]').fill("Bootstrap Admin");
  await page.locator('[data-testid="invite-inline-auth"] input[name="email"]').fill(
    `bootstrap-admin-${Date.now()}@agentdash.local`
  );
  await page.locator('[data-testid="invite-inline-auth"] input[name="password"]').fill("bootstrap-admin-password");
  await page.getByRole("button", { name: "Create account and continue" }).click();

  // For bootstrap_ceo invites, InviteLanding auto-accepts after sign-up and
  // navigates away. Just wait for the page to leave /invite/.
  await expect(page).not.toHaveURL(/\/invite\//, { timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// Shared sign-up helpers
// ---------------------------------------------------------------------------

function uniqueEmail(label: string): string {
  return `e2e-onboarding-${label}-${Date.now()}-${Math.floor(Math.random() * 9999)}@gmail.com`;
}

/**
 * Navigate to the sign-up form, fill it, and submit.
 * Waits until the browser leaves the /auth URL.
 */
async function signUp(page: Page, user: { name: string; email: string; password: string }) {
  // Use relative URL so Playwright's baseURL setting applies
  await page.goto("/auth?mode=sign_up");

  // Confirm sign-up mode — heading from ui/src/pages/Auth.tsx
  await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible({
    timeout: 10_000,
  });

  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create Account" }).click();

  // Auth.tsx onSuccess for sign_up navigates to /cos
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

/**
 * Locate the top-level wrapper divs inside .message-list.
 * MessageList.tsx renders:
 *   <div class="message-list flex flex-col gap-5">
 *     <div class="flex items-end gap-3 justify-start|justify-end">  ← one per message
 *   </div>
 */
function messageRows(page: Page) {
  return page.locator(".message-list > div");
}

/** Poll until exactly `count` message rows are in the DOM. */
async function waitForMessageCount(page: Page, count: number, timeout = 30_000) {
  await expect
    .poll(async () => messageRows(page).count(), {
      timeout,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(count);
}

/** Collect the text content of every visible message bubble in order. */
async function getMessageTexts(page: Page): Promise<string[]> {
  const rows = messageRows(page);
  const n = await rows.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(((await rows.nth(i).textContent()) ?? "").trim());
  }
  return out;
}

/** Credentialed fetch from within the page session context. */
async function sessionFetch<T>(
  page: Page,
  url: string,
  opts: { method?: string; data?: unknown } = {},
): Promise<{ ok: boolean; status: number; json: T | null }> {
  const { method = "GET", data } = opts;
  return page.evaluate(
    async ([fetchUrl, fetchMethod, fetchData]) => {
      const res = await fetch(fetchUrl as string, {
        method: fetchMethod as string,
        credentials: "include",
        headers:
          fetchData !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: fetchData !== undefined ? JSON.stringify(fetchData) : undefined,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        if (text) json = JSON.parse(text);
      } catch {
        // ignore
      }
      return { ok: res.ok, status: res.status, json };
    },
    [url, method, data ?? undefined] as [string, string, unknown],
  ) as Promise<{ ok: boolean; status: number; json: T | null }>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("AgentDash onboarding flow", () => {
  // Accept the bootstrap invite before any sign-up can work.
  // This is required in authenticated mode: without it, every /cos visit
  // shows "Instance setup required".
  test.beforeAll(async ({ browser }) => {
    const inviteUrl = createBootstrapInvite();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await acceptBootstrapInvite(page, inviteUrl);
    } finally {
      await ctx.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 1 — fresh sign-up lands in CoS chat with the 4-message welcome
  // -------------------------------------------------------------------------
  test("fresh sign-up lands in CoS chat with the 4-message welcome", async ({ page }) => {
    test.setTimeout(90_000);

    await signUp(page, {
      name: "E2E User One",
      email: uniqueEmail("t1"),
      password: "password123",
    });

    // Auth.tsx redirects sign-ups to /cos
    await expect(page).toHaveURL(/\/cos/, { timeout: 20_000 });

    // Orchestrator hook must have succeeded — "No company access" must NOT appear
    await expect(page.getByText("No company access")).not.toBeVisible({ timeout: 5_000 });

    // CoS header should show "Chief of Staff" in the ChatHeader component.
    // Use the header container to avoid matching the first welcome message bubble
    // which also contains "Chief of Staff".
    await expect(page.locator(".chat-panel").getByText("Chief of Staff").first()).toBeVisible({ timeout: 20_000 });

    // Wait for exactly 4 messages (3 plain welcome bubbles + 1 interview question card)
    await waitForMessageCount(page, 4, 30_000);

    const texts = await getMessageTexts(page);
    expect(texts).toHaveLength(4);

    // msg[0]: greeting starts with "Hi"
    expect(texts[0]).toMatch(/^Hi/i);

    // msg[1]: product welcome — contains "AgentDash"
    expect(texts[1]).toContain("AgentDash");

    // msg[2]: context-setting line —
    //   WELCOME_INTRO_LINES[2] = "Before we get started, I want to understand…"
    expect(texts[2]).toMatch(/understand|suggest|started/i);

    // msg[3]: first fixed interview question — FIXED_QUESTIONS[0]
    expect(texts[3]).toContain("?");
    expect(texts[3]).toContain(FIXED_QUESTION_0);

    // No duplicate message bodies
    const deduped = new Set(texts);
    expect(deduped.size).toBe(4);

    // Composer must be visible
    const composerInput = page.getByLabel("Message input");
    await expect(composerInput).toBeVisible();

    // Composer should be anchored near the last message (≤ 150px gap).
    // ChatPanel.tsx uses min-h-full + justify-end to pin content to the bottom.
    const lastRow = messageRows(page).last();
    const lastBox = await lastRow.boundingBox();
    const composerBox = await composerInput.boundingBox();
    if (lastBox && composerBox) {
      const gap = composerBox.y - (lastBox.y + lastBox.height);
      expect(gap).toBeLessThanOrEqual(150);
    }
  });

  // -------------------------------------------------------------------------
  // Test 2 — second gmail sign-up lands in an isolated workspace
  // -------------------------------------------------------------------------
  test("second gmail sign-up lands in an isolated workspace", async ({ browser }) => {
    test.setTimeout(120_000);

    type MeResponse = {
      companyIds?: string[];
      companies?: Array<{ id: string }>;
    };

    // --- User A ---
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    try {
      await signUp(pageA, {
        name: "E2E User A",
        email: uniqueEmail("t2a"),
        password: "password123",
      });
      await expect(pageA).toHaveURL(/\/cos/, { timeout: 20_000 });
      await waitForMessageCount(pageA, 4, 30_000);

      const meA = await sessionFetch<MeResponse>(pageA, `${BASE}/api/cli-auth/me`);
      const idsA: string[] =
        meA.json?.companyIds ??
        (meA.json?.companies ?? []).map((c) => c.id) ??
        [];

      // --- User B in an isolated browser context ---
      const ctxB = await browser.newContext();
      const pageB = await ctxB.newPage();
      try {
        await signUp(pageB, {
          name: "E2E User B",
          email: uniqueEmail("t2b"),
          password: "password456",
        });
        await expect(pageB).toHaveURL(/\/cos/, { timeout: 20_000 });

        // User B sees exactly 4 welcome messages (their own fresh workspace)
        await waitForMessageCount(pageB, 4, 30_000);
        const textsB = await getMessageTexts(pageB);
        expect(textsB).toHaveLength(4);

        // No content from User A's session
        for (const t of textsB) {
          expect(t).not.toMatch(/I run a SaaS/i);
        }

        // Verify workspace isolation via /api/cli-auth/me
        const meB = await sessionFetch<MeResponse>(pageB, `${BASE}/api/cli-auth/me`);
        const idsB: string[] =
          meB.json?.companyIds ??
          (meB.json?.companies ?? []).map((c) => c.id) ??
          [];

        if (idsA.length > 0 && idsB.length > 0) {
          const overlap = idsA.filter((id) => idsB.includes(id));
          expect(overlap).toHaveLength(0);
        }
      } finally {
        await ctxB.close();
      }
    } finally {
      await ctxA.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 3 — user can send a reply and gets an agent response
  // -------------------------------------------------------------------------
  test("user can send a reply and gets an agent response", async ({ page }) => {
    test.setTimeout(90_000);

    await signUp(page, {
      name: "E2E User Three",
      email: uniqueEmail("t3"),
      password: "password123",
    });
    await expect(page).toHaveURL(/\/cos/, { timeout: 20_000 });

    // Wait for the 4-message welcome
    await waitForMessageCount(page, 4, 30_000);

    // Type and send a message
    const composerInput = page.getByLabel("Message input");
    await composerInput.fill("I run a SaaS for indie devs");
    // Click the Send button explicitly (aria-label="Send message")
    await page.getByRole("button", { name: "Send message" }).click();

    // useMessages is fetch-once on mount (no WebSocket push wired yet), so the
    // DOM won't update live. Wait for the POST to land (201 arrives in <1s for
    // the stub path), then reload to trigger a fresh paginate() call.
    // For the stub path the agent reply is also written synchronously, so a
    // single reload typically shows both row 5 (human) and row 6 (agent reply).
    await page.waitForTimeout(2_000);
    await page.reload();

    // After reload, both the human message (row 5) and the agent stub reply
    // (row 6) are already persisted and come back in one paginate() call.
    // Wait for exactly 6 rows — no intermediate 5-row step.
    await waitForMessageCount(page, 6, 30_000);

    const texts = await getMessageTexts(page);
    expect(texts).toHaveLength(6);

    // Row 5 (index 4) is the human echo
    expect(texts[4]).toContain("I run a SaaS for indie devs");

    // Row 6 (index 5) is the agent reply — must be non-empty
    const agentReplyText = texts[5];
    expect(agentReplyText).toBeTruthy();

    // Row 6 must be left-aligned (agent), not right-aligned (user)
    const sixthRow = messageRows(page).nth(5);
    const rowClass = await sixthRow.getAttribute("class");
    expect(rowClass).toContain("justify-start");

    // Stub check — warn unless REQUIRE_REAL_LLM is set
    if (agentReplyText === LLM_STUB_REPLY) {
      if (REQUIRE_REAL_LLM) {
        throw new Error(
          "Test 3: received LLM stub reply. Set ANTHROPIC_API_KEY and ensure " +
            "AGENTDASH_DEFAULT_ADAPTER=claude_api to wire real Claude. " +
            "Unset E2E_REQUIRE_REAL_LLM to accept the stub in CI.",
        );
      }
      console.warn(
        "[onboarding-flow] Test 3: dispatch-llm returned stub reply " +
          "(no ANTHROPIC_API_KEY configured). " +
          "Set E2E_REQUIRE_REAL_LLM=true to enforce real Claude responses.",
      );
    }
  });
});
