/**
 * E2E (scan 4, lane N): CoS chat polish, on a phone.
 *
 * Seeds a fresh company through the public API, opens its Ask page at 390x844
 * and serves the conversation's messages from a fixture, so nothing depends on
 * a model. It asserts:
 *   - a hired plan card says "Team hired ✓" with its buttons disabled, and a
 *     "Set it up" answered by 409 turns into the same state;
 *   - plan titles keep their punctuation ("&", "Month-End");
 *   - the CoS's markdown renders (a real list, no literal "- ");
 *   - with a backlog default, the task card offers "Create" and "Create and
 *     start"; the latter sends start: true and the card turns into one
 *     "Task created" card;
 *   - an old duplicate "Task created" message is not shown twice;
 *   - the composer placeholder is the short one on a phone.
 *
 * Run on a free port, never 3199:
 *   PAPERCLIP_E2E_PORT=3847 pnpm exec playwright test \
 *     --config tests/e2e/playwright.config.ts cos-chat-polish.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

type Company = { id: string; issuePrefix: string };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function plan(confirmedAt?: string) {
  return {
    rationale: "Two hires take the routine load this quarter.",
    agents: [
      {
        role: "client_onboarding_process_builder",
        title: "Client Onboarding & Process Builder",
        name: "Priya",
        adapterType: "hermes_local",
        responsibilities: ["Turn onboarding into a checklist"],
        kpis: ["New clients onboarded in 3 days"],
      },
      {
        role: "close_coordinator",
        title: "Month-End Close Coordinator",
        name: "Marcus",
        adapterType: "hermes_local",
        responsibilities: ["Run the close checklist"],
        kpis: ["Closes done by day 10"],
      },
    ],
    alignmentToShortTerm: "Takes the routine load off this quarter.",
    alignmentToLongTerm: "Frees capacity for 50 more clients.",
    ...(confirmedAt ? { confirmedAt, confirmedAgentIds: [id(90), id(91)] } : {}),
  };
}

function fixtureMessages(conversationId: string) {
  const base = Date.now() - 60_000;
  const at = (offset: number) => new Date(base + offset * 1000).toISOString();
  const row = (n: number, fields: Record<string, unknown>) => ({
    id: id(n),
    conversationId,
    role: "agent",
    content: "",
    cardKind: null,
    cardPayload: null,
    createdAt: at(n),
    ...fields,
  });
  const rows = [
    row(1, { role: "user", content: "We need to stop drowning in email and close the month on time." }),
    row(2, { content: "Here's the team I'd start with:\n\n- **Priya** builds the onboarding checklist\n- **Marcus** runs the close" }),
    row(3, { cardKind: "agent_plan_proposal_v1", cardPayload: plan("2026-10-02T08:05:00Z") }),
    row(4, { cardKind: "agent_plan_proposal_v1", cardPayload: plan() }),
    row(5, {
      cardKind: "issue_proposal_v1",
      cardPayload: {
        status: "created",
        title: "Draft the onboarding checklist",
        assigneeName: "Priya",
        issueId: id(70),
        identifier: "E2E-1",
        issueStatus: "backlog",
      },
    }),
    // The old extra "Task created" message for the same task.
    row(6, { cardKind: "issue_created_v1", cardPayload: { issueId: id(70), identifier: "E2E-1", title: "Draft the onboarding checklist", assigneeName: "Priya", status: "backlog" } }),
    row(7, {
      cardKind: "issue_proposal_v1",
      cardPayload: {
        status: "pending",
        title: "Chase the missing bank statements",
        description: "Every client missing a statement gets a reminder.",
        assigneeName: "Marcus",
        defaultStatus: "backlog",
      },
    }),
  ];
  return rows.reverse();
}

async function openAskWithFixture(page: Page, company: Company) {
  await page.route("**/api/conversations/*/messages*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const match = new URL(route.request().url()).pathname.match(/\/api\/conversations\/([^/]+)\/messages/);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixtureMessages(match?.[1] ?? "c")) });
  });
  await page.goto(`/${company.issuePrefix}/cos`);
  await expect(page.getByTestId("cos-conversation")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("plan-proposal").first()).toBeVisible({ timeout: 30_000 });
}

test("CoS chat: hired plan state, verbatim titles, markdown, Create and start, one task card", async ({ page, request }) => {
  test.setTimeout(120_000);
  const res = await request.post("/api/companies", { data: { name: `E2E CoS Chat Polish ${Date.now()}` } });
  expect(res.ok(), `create company: ${res.status()} ${await res.text()}`).toBe(true);
  const company = (await res.json()) as Company;

  // The second plan card's team already exists: the server answers 409.
  await page.route("**/api/onboarding/confirm-plan", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Hire already accepted; inspect the existing agents instead of hiring again" }),
    });
  });
  let confirmBody: unknown = null;
  await page.route("**/api/conversations/*/task-proposals/*/confirm", async (route) => {
    confirmBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        proposal: { status: "created" },
        issue: { issueId: id(71), identifier: "E2E-2", title: "Chase the missing bank statements", assigneeName: "Marcus", status: "todo" },
      }),
    });
  });

  await openAskWithFixture(page, company);

  // 1. A hired plan card: "Team hired ✓", buttons disabled, no "Set it up".
  const hiredCard = page.getByTestId("plan-proposal").nth(0);
  await expect(hiredCard.getByRole("button", { name: "Team hired ✓" })).toBeDisabled();
  await expect(hiredCard.getByRole("button", { name: "Let me revise" })).toBeDisabled();
  await expect(hiredCard.getByRole("button", { name: "Set it up" })).toHaveCount(0);

  // 5. Titles keep their punctuation.
  await expect(hiredCard).toContainText("Priya — Client Onboarding & Process Builder");
  await expect(hiredCard).toContainText("Marcus — Month-End Close Coordinator");

  // 1. A second "Set it up" answered by 409 shows the same hired state.
  const openCard = page.getByTestId("plan-proposal").nth(1);
  await openCard.scrollIntoViewIfNeeded();
  await openCard.getByRole("button", { name: "Set it up" }).click();
  await expect(openCard.getByRole("button", { name: "Team hired ✓" })).toBeDisabled();
  await expect(openCard.getByRole("alert")).toHaveCount(0);

  // 5. The CoS's markdown renders as a list.
  const intro = page.getByTestId("chat-markdown").filter({ hasText: "Here's the team" });
  await expect(intro.locator("li")).toHaveCount(2);
  await expect(intro.locator("strong").first()).toHaveText("Priya");
  expect((await intro.textContent()) ?? "").not.toContain("- ");

  // 2. One "Task created" card per task, even with the old duplicate message.
  await expect(page.getByTestId("issue-created-card").filter({ hasText: "E2E-1" })).toHaveCount(1);

  // 3. Backlog default: "Create" (primary) and "Create and start".
  const proposal = page.getByTestId("issue-proposal-card");
  await proposal.scrollIntoViewIfNeeded();
  await expect(proposal.getByRole("button", { name: "Create", exact: true })).toBeVisible();
  const startButton = proposal.getByRole("button", { name: "Create and start" });
  await expect(startButton).toBeVisible();
  expect((await startButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await startButton.click();
  await expect(page.getByTestId("issue-created-card").filter({ hasText: "E2E-2" })).toHaveCount(1);
  await expect(page.getByTestId("issue-created-card").filter({ hasText: "E2E-2" })).toContainText("They'll start on it now.");
  expect(confirmBody).toEqual({ start: true });
  await expect(page.getByTestId("issue-proposal-card")).toHaveCount(0);

  // 6. The phone placeholder is short and not cut off.
  const input = page.getByLabel("Message input");
  await expect(input).toHaveAttribute("placeholder", "Message your Chief of Staff…");

  // Still no sideways scroll.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  if (process.env.MOBILE_SHOTS_DIR) {
    await page.screenshot({ path: `${process.env.MOBILE_SHOTS_DIR}/cos-chat-polish-phone.png`, fullPage: false });
  }
});
