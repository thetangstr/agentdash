import { test, expect } from "@playwright/test";
import { E2E_GITHUB_TOKEN } from "./github-stub.global-setup";

/**
 * E2E (GH #786, UX-5): the first run.
 *
 *   /company-create → /setup: runtime → /cos; /setup: connect GitHub → first issue → Home
 *
 * GitHub's REST API is stubbed by github-stub.global-setup.ts (the server
 * points at it through AGENTDASH_GITHUB_API_URL, playwright.config.ts). The
 * e2e instance is local_trusted, so the model-key step (hosted boxes only) is
 * covered by FirstRun.test.tsx and first-run-routes.test.ts instead.
 *
 * Checks: leaving after the repo step and coming back resumes at the first
 * issue; the first issue is created in the repo's project and assigned to an
 * engineer agent; Home (not a hosted box here, so no first-run nudges) offers
 * "Plan with your Chief of Staff", which opens the CoS chat with its header
 * line and suggestions; the in-app assistant instructions open directly.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = E2E_GITHUB_TOKEN;

test("a new workspace goes through the first run to Home with its first issue assigned", async ({ page, request }) => {
  // This is the longest full-journey spec (workspace → GitHub connect → first
  // issue → Home → CoS chat → instructions). Under CI heartbeat churn the
  // global 60s is eaten before the last clicks — same budget as
  // multi-user-authenticated.spec.ts's full journeys.
  test.setTimeout(180_000);
  const name = `E2E-FirstRun-${Date.now()}`;
  // The shared e2e board user may already belong to other specs' workspaces;
  // drop fromSignup so a real workspace is created (see onboarding-optional-assessment.spec.ts).
  await page.route("**/api/companies?*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST" && url.searchParams.has("fromSignup")) {
      url.searchParams.delete("fromSignup");
      await route.continue({ url: url.toString() });
      return;
    }
    await route.continue();
  });

  await page.goto(`${BASE_URL}/company-create`);
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/setup\?companyId=/);

  // One onboarding path: on a self-hosted install the first step after naming
  // the workspace is the runtime (Claude Code, Codex or Hermes), then the CoS.
  await expect(page.getByTestId("first-run-progress")).toContainText("Your AI assistant");
  const runtime = page.getByTestId("first-run-runtime");
  await expect(runtime).toContainText("Claude Code");
  await expect(runtime).toContainText("Codex");
  await expect(runtime).toContainText("Hermes");
  await expect(page.getByTestId("first-run-runtime-current")).toContainText("Your workspace uses");
  await page.getByRole("button", { name: "Continue to your Chief of Staff" }).click();
  await expect(page).toHaveURL(/\/cos$/);

  // GitHub and the first issue stay at /setup.
  await page.goto(`${BASE_URL}/setup`);

  // Step: Code (optional). Lane J: the step says it is optional and can be skipped.
  await expect(page.getByTestId("first-run-skip")).toBeVisible();
  await expect(page.getByTestId("first-run-progress")).toContainText("Code (optional)");
  await page.getByLabel("Repository").fill("https://github.com/acme/firstrun");
  await page.getByLabel("Fine-grained token").fill(TOKEN);
  await page.getByRole("button", { name: "Check and connect" }).click();
  await expect(page.getByRole("heading", { name: "What should your team do first?" })).toBeVisible();

  // Leave and come back: resumes at the first issue.
  await page.goto(`${BASE_URL}/setup`);
  await expect(page.getByRole("heading", { name: "What should your team do first?" })).toBeVisible();
  expect(await page.content()).not.toContain(TOKEN);

  // Step: first issue, from a suggestion chip.
  const chip = page.getByTestId("first-issue-suggestions").getByRole("button").first();
  const suggestion = (await chip.textContent())!.trim();
  await chip.click();
  await page.getByRole("button", { name: "Start", exact: true }).click();

  // Home. The e2e instance is not a hosted box, so the first-run nudges stay
  // off (#813: only hosted boxes, for new companies); their visibility rules are
  // covered by first-run-routes.test.ts and FirstRunHomeNudges.test.tsx.
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("home")).toBeVisible();
  await expect(page.getByTestId("connect-muse")).toHaveCount(0);
  await expect(page.getByTestId("first-run-home-resume")).toHaveCount(0);

  // The in-app assistant instructions are reachable directly.
  await page.goto(`${BASE_URL}/connect-assistant`);
  await expect(page.getByTestId("assistant-mcp-url")).toContainText("/api/mcp/assistant");
  await expect(page.getByTestId("assistant-client-id")).toHaveText("muse");
  await page.getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Server state: the issue is in the repo's project and assigned to an engineer.
  const companies = (await (await request.get(`${BASE_URL}/api/companies`)).json()) as Array<{ id: string; name: string }>;
  const company = companies.find((candidate) => candidate.name === name)!;
  const status = await (await request.get(`${BASE_URL}/api/companies/${company.id}/first-run`)).json();
  expect(status).toMatchObject({ nextStep: "done", repo: { repo: "acme/firstrun" }, firstIssue: { title: suggestion, assigneeName: "Engineer" } });
  const agents = (await (await request.get(`${BASE_URL}/api/companies/${company.id}/agents`)).json()) as Array<{ id: string; role: string }>;
  const engineer = agents.find((agent) => agent.role === "engineer");
  expect(engineer?.id).toBe(status.firstIssue.assigneeAgentId);

  // Optional planning: the CoS chat, with its header line and suggestions.
  // Ask lives inside the sidebar Layout at /:prefix/cos, with Ask highlighted.
  await page.getByTestId("home-plan-with-cos").click();
  await expect(page).toHaveURL(/\/[^/]+\/cos$/);
  await expect(page.getByTestId("cos-conversation")).toHaveAttribute("data-layout", "embedded");
  await expect(page.getByRole("link", { name: "Ask", exact: true }).first()).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Work", exact: true }).first()).toBeVisible();
  await expect(page.getByText("Tell me what you need done.")).toBeVisible();
  await expect(page.getByTestId("chat-suggestions")).toBeVisible();

  // Bare /cos (onboarding, emails) redirects to the company-prefixed Ask.
  await page.goto(`${BASE_URL}/cos`);
  await expect(page).toHaveURL(/\/[^/]+\/cos$/);
  await expect(page.getByTestId("cos-conversation")).toHaveAttribute("data-layout", "embedded");
});
