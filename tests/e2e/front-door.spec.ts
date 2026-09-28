import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * AgentDash (SC-7, GH #768): the self-serve front door on www — /start,
 * /start/verify, /start/progress and /find. The control-plane API
 * (/api/cloud/*, rewritten by Vercel in production) is stubbed per test with
 * page.route, so the pages are checked against the exact response shapes the
 * control plane's own tests pin (cloud/src/__tests__/front-door.test.ts),
 * without a control plane or a mailbox. Runs in the default e2e config.
 *
 * FRONT_DOOR_SHOTS=<dir> also writes a screenshot of each state (PR assets).
 */

const SHOTS = process.env.FRONT_DOOR_SHOTS;
// The app's service worker would proxy the Turnstile script past page.route.
test.use({ serviceWorkers: "block" });
const CLAIM = "https://acme.agentdash.cloud/claim#code=AGD-0123456789ABCDEF0123456789&email=founder%40acme.test";

interface Stub {
  config?: Record<string, unknown>;
  slug?: (slug: string) => Record<string, unknown>;
  signup?: { status: number; body: Record<string, unknown> };
  verify?: { status: number; body: Record<string, unknown> };
  /** What GET /boxes/mine answers; tests move `calls.mineStage` to change it. */
  mine?: Array<{ status: number; body: Record<string, unknown> }>;
  find?: { status: number; body: Record<string, unknown> };
}

interface Calls {
  signup: Array<Record<string, unknown>>;
  verify: Array<Record<string, unknown>>;
  find: Array<Record<string, unknown>>;
  resend: Array<Record<string, unknown>>;
  mine: number;
  mineStage: number;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function stubCloud(page: Page, stub: Stub): Promise<Calls> {
  const calls: Calls = { signup: [], verify: [], find: [], resend: [], mine: 0, mineStage: 0 };
  await page.route(
    (url) => url.pathname.startsWith("/api/cloud/"),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace("/api/cloud", "");
      const body = req.method() === "POST" ? (req.postDataJSON() as Record<string, unknown>) : {};
      switch (path) {
        case "/config":
          return json(route, 200, { turnstileSiteKey: null, signupOpen: true, waitlist: true, edgeDomain: "agentdash.cloud", ...stub.config });
        case "/slug-available": {
          const slug = new URL(req.url()).searchParams.get("slug") ?? "";
          return json(route, 200, stub.slug?.(slug) ?? { slug, available: true });
        }
        case "/signup":
          calls.signup.push(body);
          return json(route, stub.signup?.status ?? 202, stub.signup?.body ?? { ok: true });
        case "/verify":
          calls.verify.push(body);
          return json(route, stub.verify?.status ?? 200, stub.verify?.body ?? { ok: true, outcome: "box_requested", provisioning: "waitlisted", reason: "kill_switch" });
        case "/boxes/mine": {
          calls.mine += 1;
          const list = stub.mine ?? [{ status: 401, body: { error: "no session", code: "no_session" } }];
          const r = list[Math.min(calls.mineStage, list.length - 1)]!;
          return json(route, r.status, r.body);
        }
        case "/resend":
          calls.resend.push(body);
          return json(route, 202, { ok: true });
        case "/find":
          calls.find.push(body);
          return json(route, stub.find?.status ?? 202, stub.find?.body ?? { ok: true });
        default:
          return json(route, 404, { error: "not found" });
      }
    },
  );
  return calls;
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

const box = (over: Record<string, unknown>) => ({
  email: "founder@acme.test",
  boxes: [{ slug: "acme", url: "https://acme.agentdash.cloud", state: "waitlisted", phase: "waitlisted", stepIndex: null, slow: false, claimUrl: null, createdAt: "2026-09-28T17:00:00.000Z", ...over }],
});

test.describe("front door: /start", () => {
  test("signs up: live slug check, terms, then 'check your email' with resend", async ({ page }) => {
    const calls = await stubCloud(page, { slug: (s) => (s === "taken" ? { slug: s, available: false, reason: "taken", message: "That name is taken. Try another." } : { slug: s, available: true }) });
    await page.goto("/start");
    await expect(page.locator("h1")).toContainText("Create your workspace");
    await expect(page.getByTestId("waitlist-note")).toBeVisible();
    await page.getByLabel("Work email").fill("founder@acme.test");
    await page.getByLabel("Workspace name").fill("Acme Robotics");
    // The slug follows the name until edited.
    await expect(page.getByLabel("Web address")).toHaveValue("acme-robotics");
    await expect(page.getByTestId("slug-status")).toHaveText("Available");
    await page.getByLabel("Web address").fill("taken");
    await expect(page.getByTestId("slug-status")).toHaveText("That name is taken. Try another.");
    await page.getByLabel("Web address").fill("acme");
    await expect(page.getByTestId("slug-status")).toHaveText("Available");
    const submit = page.getByRole("button", { name: "Email me a link" });
    await expect(submit).toBeDisabled(); // terms not accepted
    await page.getByRole("checkbox").check();
    await shot(page, "start-filled");
    await submit.click();
    await expect(page.getByTestId("check-email")).toContainText("founder@acme.test");
    expect(calls.signup).toEqual([{ email: "founder@acme.test", workspaceName: "Acme Robotics", slug: "acme", acceptTerms: true }]);
    await shot(page, "start-check-email");
    await page.getByRole("button", { name: "Send it again" }).click();
    await expect(page.getByRole("button", { name: "Sent again" })).toBeDisabled();
    expect(calls.resend).toEqual([{ email: "founder@acme.test" }]);
  });

  test("shows the control plane's refusal (disposable address)", async ({ page }) => {
    await stubCloud(page, { signup: { status: 400, body: { error: "Use a permanent email address; temporary inboxes are not accepted.", code: "disposable_email" } } });
    await page.goto("/start");
    await page.getByLabel("Work email").fill("x@mailinator.com");
    await page.getByLabel("Workspace name").fill("Acme");
    await expect(page.getByTestId("slug-status")).toHaveText("Available");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.getByTestId("start-error")).toContainText("temporary inboxes are not accepted");
  });

  test("renders the Turnstile widget only when a site key is configured, and needs its token", async ({ page }) => {
    await page.route("https://challenges.cloudflare.com/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "window.turnstile={render:function(el,o){el.textContent='turnstile';setTimeout(function(){o.callback('tok-123')},50);return 'w1'},remove:function(){},reset:function(){}};" }));
    const calls = await stubCloud(page, { config: { turnstileSiteKey: "site-key" } });
    await page.goto("/start");
    await expect(page.getByTestId("turnstile")).toHaveText("turnstile");
    await page.getByLabel("Work email").fill("founder@acme.test");
    await page.getByLabel("Workspace name").fill("Acme");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.getByTestId("check-email")).toBeVisible();
    expect(calls.signup[0]!.turnstileToken).toBe("tok-123");
  });

  test("mobile layout has no horizontal overflow", async ({ page }) => {
    await stubCloud(page, {});
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/start");
    await expect(page.getByTestId("start-form")).toBeVisible();
    await shot(page, "start-mobile");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
  });
});

test.describe("front door: magic link and progress", () => {
  test("the link posts its fragment token once, clears it from the address bar, and lands on progress (waitlisted)", async ({ page }) => {
    const calls = await stubCloud(page, { mine: [{ status: 200, body: box({}) }] });
    const token = "T".repeat(43);
    await page.goto(`/start/verify#token=${token}`);
    await expect(page).toHaveURL(/\/start\/progress$/);
    expect(calls.verify).toEqual([{ token }]);
    await expect(page.getByTestId("phase-waitlisted")).toContainText("You're on the list");
    await expect(page.getByTestId("phase-waitlisted")).toContainText("acme.agentdash.cloud");
    await shot(page, "progress-waitlisted");
  });

  test("a used link says so and offers /find", async ({ page }) => {
    await stubCloud(page, { verify: { status: 410, body: { error: "This link was already used. Each link works once.", code: "link_used" } } });
    await page.goto(`/start/verify#token=${"U".repeat(43)}`);
    await expect(page.getByTestId("verify-error")).toContainText("already used");
    await expect(page.getByRole("link", { name: "Find my workspace" })).toHaveAttribute("href", "/find");
    await shot(page, "verify-used");
  });

  test("approved-pending: the person is told they are in", async ({ page }) => {
    await stubCloud(page, {
      mine: [
        { status: 200, body: box({ phase: "approved" }) },
      ],
    });
    await page.goto("/start/progress");
    await expect(page.getByTestId("phase-approved")).toContainText("You're in");
    await shot(page, "progress-approved");
  });

  test("provisioning shows the current step, the slow note, then ready", async ({ page }) => {
    await page.clock.install();
    const calls = await stubCloud(page, {
      mine: [
        { status: 200, body: box({ state: "provisioning", phase: "provisioning", stepIndex: 2 }) },
        { status: 200, body: box({ state: "provisioning", phase: "provisioning", stepIndex: 3, slow: true }) },
        { status: 200, body: box({ state: "awaiting_claim", phase: "ready", claimUrl: CLAIM }) },
      ],
    });
    await page.goto("/start/progress");
    await expect(page.getByTestId("phase-provisioning")).toContainText("Creating your workspace");
    await expect(page.locator(".mkt-cloud__step.is-now")).toHaveText("Configuring your workspace");
    await expect(page.locator(".mkt-cloud__step.is-done")).toHaveCount(2);
    await shot(page, "progress-provisioning");
    calls.mineStage = 1;
    await page.clock.runFor(4_500);
    await expect(page.getByTestId("slow-note")).toBeVisible();
    calls.mineStage = 2;
    await page.clock.runFor(4_500);
    await expect(page.getByTestId("phase-ready")).toContainText("Your workspace is ready");
    await expect(page.getByRole("link", { name: "Open my workspace" })).toHaveAttribute("href", CLAIM);
    await shot(page, "progress-ready");
  });

  test("without a session, progress sends the person to /find", async ({ page }) => {
    await stubCloud(page, {});
    await page.goto("/start/progress");
    await expect(page.getByTestId("progress-card")).toContainText("Sign in to see your workspace");
    await expect(page.getByRole("link", { name: "Email me a link" })).toHaveAttribute("href", "/find");
  });
});

test.describe("front door: /find", () => {
  test("mails links and answers the same way for any address", async ({ page }) => {
    const calls = await stubCloud(page, {});
    await page.goto("/find");
    await expect(page.locator("h1")).toContainText("Find your workspace");
    await shot(page, "find");
    await page.getByLabel("The email you signed up with").fill("founder@acme.test");
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.getByTestId("find-sent")).toContainText("If founder@acme.test has an AgentDash workspace");
    expect(calls.find).toEqual([{ email: "founder@acme.test" }]);
    await shot(page, "find-sent");
  });
});
