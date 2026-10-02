/**
 * E2E (scan 3, lane G): the CoS plan card on a phone.
 *
 * The plan card used to sit inside an 80%-wide chat bubble next to the avatar,
 * with nested padding, so on a 390px phone it wrapped one word per line. It
 * also showed role slugs, the adapter ("hermes_local") and "Outcome
 * measurements: Unknown".
 *
 * The spec seeds a fresh company through the public API, opens its Ask page at
 * 390x844, and serves the conversation's messages from a fixture (a plan card
 * with long, realistic text, plus a sent user message) so the layout does not
 * depend on a model. It asserts:
 *   - no horizontal scroll on the page or inside the chat,
 *   - the plan card and each agent row keep a readable text column,
 *   - no internal jargon on the card,
 *   - the plan card's buttons are at least 44px tall,
 *   - the starter chips are gone once the person has sent a message,
 *   - the "Review your team" link is absent on a workspace with no hires.
 *
 * Run on a free port, never 3199:
 *   PAPERCLIP_E2E_PORT=3846 pnpm exec playwright test \
 *     --config tests/e2e/playwright.config.ts cos-plan-card-phone.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

type Company = { id: string; issuePrefix: string };

const LONG = "Run timed follow-up sequences on open inquiries and sent proposals so nothing goes quiet";

function fixtureMessages(conversationId: string) {
  const base = Date.now() - 60_000;
  const at = (offset: number) => new Date(base + offset * 1000).toISOString();
  const rows = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      conversationId,
      role: "agent",
      content: "What's the one thing you most want off your plate this quarter?",
      cardKind: null,
      cardPayload: null,
      createdAt: at(0),
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      conversationId,
      role: "user",
      content: "Winning more renovation bids without me chasing every lead.",
      cardKind: null,
      cardPayload: null,
      createdAt: at(1),
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      conversationId,
      role: "agent",
      content: "",
      cardKind: "agent_plan_proposal_v1",
      cardPayload: {
        rationale:
          "You want more renovation bids won without chasing every lead yourself, and revenue trending up quarter over quarter. Two hires cover the follow-up and the proposals.",
        agents: [
          {
            role: "proposal_drafter",
            name: "Ellie",
            adapterType: "hermes_local",
            responsibilities: ["Draft tailored proposals for every qualified inquiry within two business days"],
            kpis: ["Proposals sent within 48 hours", "Win rate trending up quarter over quarter"],
          },
          {
            role: "follow_up_coordinator",
            name: "Sam",
            adapterType: "hermes_local",
            responsibilities: [LONG],
            kpis: ["No inquiry without a reply for more than three days"],
          },
        ],
        alignmentToShortTerm: "Unknown",
        alignmentToLongTerm: "Builds a repeatable sales motion you can hand to a future sales lead.",
      },
      createdAt: at(2),
    },
    {
      id: "00000000-0000-4000-8000-000000000004",
      conversationId,
      role: "agent",
      content: "",
      cardKind: "issue_proposal_v1",
      cardPayload: {
        status: "pending",
        title: "Draft the renovation proposal for the Hendricks kitchen inquiry",
        description: "Two pages: scope, timeline, a price range, and the next step for the client.",
        assigneeAgentId: "00000000-0000-4000-8000-0000000000aa",
        assigneeName: "Ellie",
        requesterUserId: "someone-else",
        triggerMessageId: "00000000-0000-4000-8000-000000000002",
        cosAgentId: "00000000-0000-4000-8000-0000000000bb",
      },
      createdAt: at(3),
    },
  ];
  // The server returns newest first.
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
  await expect(page.getByTestId("plan-proposal")).toBeVisible({ timeout: 30_000 });
}

test("the CoS plan card is readable on a phone, in plain language", async ({ page, request }) => {
  test.setTimeout(120_000);
  const res = await request.post("/api/companies", { data: { name: `E2E Plan Card Phone ${Date.now()}` } });
  expect(res.ok(), `create company: ${res.status()} ${await res.text()}`).toBe(true);
  const company = (await res.json()) as Company;

  await openAskWithFixture(page, company);
  const card = page.getByTestId("plan-proposal");
  await card.scrollIntoViewIfNeeded();

  // No horizontal scroll: the page and the chat's own scroll area.
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const chat = document.querySelector(".chat-panel .overflow-y-auto") as HTMLElement | null;
    return {
      page: doc.scrollWidth - window.innerWidth,
      chat: chat ? chat.scrollWidth - chat.clientWidth : 0,
    };
  });
  expect(overflow.page, "page scrolls sideways").toBeLessThanOrEqual(0);
  expect(overflow.chat, "chat scrolls sideways").toBeLessThanOrEqual(0);

  // A readable text column: the card spans the chat width, and every agent
  // row and its text keep at least 260px (one word per line was ~120px).
  const cardBox = await card.boundingBox();
  expect(cardBox?.width ?? 0).toBeGreaterThanOrEqual(300);
  const rows = page.getByTestId("plan-proposal-agent");
  await expect(rows).toHaveCount(2);
  for (let i = 0; i < 2; i += 1) {
    const box = await rows.nth(i).boundingBox();
    expect(box?.width ?? 0, `agent row ${i} width`).toBeGreaterThanOrEqual(280);
    const textWidths = await rows.nth(i).evaluate((row) =>
      Array.from(row.querySelectorAll("div, p")).map((el) => (el as HTMLElement).getBoundingClientRect().width),
    );
    expect(Math.min(...textWidths), `agent row ${i} text column`).toBeGreaterThanOrEqual(260);
  }
  // The long responsibility fits in a few lines, not one word per line.
  const longLine = card.getByText(LONG);
  const longBox = await longLine.boundingBox();
  expect(longBox?.height ?? 999).toBeLessThan(120);

  // Plain language on the card.
  const text = (await card.textContent()) ?? "";
  expect(text).toContain("Ellie — Proposal Drafter");
  expect(text).toContain("Sam — Follow Up Coordinator");
  expect(text).not.toContain("proposal_drafter");
  expect(text).not.toContain("hermes_local");
  expect(text).not.toContain("Unknown");
  expect(text).not.toContain("Short-term:");
  expect(text).toContain("Long-term:");

  // Phone tap targets.
  for (const name of ["Set it up", "Let me revise"]) {
    const box = await card.getByRole("button", { name }).boundingBox();
    expect(box?.height ?? 0, `${name} height`).toBeGreaterThanOrEqual(44);
  }

  // The CoS's "Create this task?" card fits the phone too. (Who may confirm
  // it is covered by the unit and route tests.)
  const proposal = page.getByTestId("issue-proposal-card");
  await proposal.scrollIntoViewIfNeeded();
  await expect(proposal).toContainText("Create this task?");
  await expect(proposal).toContainText("For Ellie");
  expect((await proposal.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);
  const overflowAfter = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflowAfter).toBeLessThanOrEqual(0);

  // The conversation has started (the fixture has a user message): no chips.
  await expect(page.getByTestId("chat-suggestions")).toHaveCount(0);
  // A workspace with no hires has nothing to review yet.
  await expect(page.getByTestId("cos-review-team-link")).toHaveCount(0);
  // The header line is plain business language.
  await expect(page.getByText("Tell me what you need done.")).toBeVisible();

  if (process.env.MOBILE_SHOTS_DIR) {
    await page.screenshot({ path: `${process.env.MOBILE_SHOTS_DIR}/cos-plan-card-phone.png`, fullPage: false });
  }
});
