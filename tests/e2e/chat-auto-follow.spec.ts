/**
 * E2E (chat auto-follow): the issue conversation and Ask (the Chief of Staff
 * chat) follow the latest message only while the viewer is at the bottom,
 * in a real browser layout on a desktop viewport:
 *   - the issue page still opens at its top; once the viewer is at the bottom
 *     a new comment comes into view; after a scroll up a new comment leaves
 *     the position where it was;
 *   - Ask opens on the newest message; a scroll up shows "Jump to latest",
 *     which goes back to the bottom; sending a message follows again.
 *
 * Run on a free port, never 3100/3120/3199/3300:
 *   PAPERCLIP_E2E_PORT=3465 pnpm exec playwright test \
 *     --config tests/e2e/playwright.config.ts chat-auto-follow.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { resolveE2eServerPort } from "./e2e-port";

const PORT = resolveE2eServerPort(3399);
const BASE_URL = `http://127.0.0.1:${PORT}`;

test.use({ viewport: { width: 1280, height: 800 } });

async function ensureCompany(request: APIRequestContext) {
  const created = await request.post(`${BASE_URL}/api/companies`, {
    data: { name: `E2E-Follow-${Date.now()}` },
  });
  if (created.ok()) return (await created.json()) as { id: string; issuePrefix: string };
  // Single-company installs refuse a second company; reuse the one there is.
  const list = await request.get(`${BASE_URL}/api/companies`);
  expect(list.ok()).toBe(true);
  const companies = (await list.json()) as Array<{ id: string; issuePrefix: string }>;
  expect(companies.length).toBeGreaterThan(0);
  return companies[0]!;
}

/** The issue page scrolls in <main id="main-content"> on desktop. */
async function mainScroll(page: Page) {
  return page.evaluate(() => {
    const main = document.getElementById("main-content")!;
    return {
      top: Math.round(main.scrollTop),
      distanceFromBottom: Math.round(main.scrollHeight - main.scrollTop - main.clientHeight),
    };
  });
}

test("issue chat: follows new comments at the bottom, leaves a scrolled-up reader alone", async ({ page, request }) => {
  const company = await ensureCompany(request);
  const issueRes = await request.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
    data: { title: "Auto-follow thread", status: "in_review" },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = (await issueRes.json()) as { id: string; identifier: string | null };
  const addComment = async (body: string) => {
    const res = await request.post(`${BASE_URL}/api/issues/${issue.id}/comments`, { data: { body } });
    expect(res.ok(), await res.text()).toBe(true);
  };
  for (let i = 1; i <= 20; i += 1) {
    await addComment(`Update ${i}: notes on the trial, with enough text to take a couple of lines in the thread.`);
  }

  await page.goto(`${BASE_URL}/${company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  await expect(page.getByText("Update 20:")).toBeAttached({ timeout: 20_000 });
  // The issue page opens at its top, as before.
  expect((await mainScroll(page)).top).toBe(0);

  // At the bottom, a new comment comes into view on its own.
  await page.evaluate(() => {
    const main = document.getElementById("main-content")!;
    main.scrollTop = main.scrollHeight;
  });
  await expect.poll(async () => (await mainScroll(page)).distanceFromBottom).toBeLessThanOrEqual(2);
  await addComment("Update 21: arrived while the reader watched the bottom.");
  const update21 = page.getByText("Update 21:");
  await expect(update21).toBeAttached({ timeout: 20_000 });
  await expect(update21).toBeInViewport();
  await expect.poll(async () => (await mainScroll(page)).distanceFromBottom).toBeLessThanOrEqual(32);

  // Scrolled up, the next comment arrives below without moving the reader.
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -900);
  await expect.poll(async () => (await mainScroll(page)).distanceFromBottom).toBeGreaterThan(400);
  const before = (await mainScroll(page)).top;
  await addComment("Update 22: arrived while the reader was reading history.");
  const update22 = page.getByText("Update 22:");
  await expect(update22).toBeAttached({ timeout: 20_000 });
  await page.waitForTimeout(300);
  expect(Math.abs((await mainScroll(page)).top - before)).toBeLessThanOrEqual(2);
  await expect(update22).not.toBeInViewport();
});

test("Ask: opens on the newest message, Jump to latest after a scroll up, sending follows again", async ({ page, request }) => {
  const company = await ensureCompany(request);
  // Serve a long conversation from a fixture so nothing depends on a model.
  // The send is answered here too: a real POST would wake the CoS reply path,
  // which shares the server's E2E LLM stub call counter with the
  // deep-interview spec and shifts its canned answers.
  await page.route("**/api/conversations/*/messages*", async (route) => {
    const conversationId =
      new URL(route.request().url()).pathname.match(/\/api\/conversations\/([^/]+)\/messages/)?.[1] ?? "c";
    if (route.request().method() === "POST") {
      const sent = (route.request().postDataJSON() ?? {}) as { body?: string };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "00000000-0000-4000-8000-000000000999",
          conversationId,
          role: "user",
          content: sent.body ?? "",
          cardKind: null,
          cardPayload: null,
          createdAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const base = Date.now() - 600_000;
    const rows = Array.from({ length: 30 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      conversationId,
      role: "agent",
      content: `Note ${index + 1}: a longer answer from the Chief of Staff so the conversation needs to scroll.`,
      cardKind: null,
      cardPayload: null,
      createdAt: new Date(base + index * 1000).toISOString(),
    }));
    // The server returns newest first.
    rows.reverse();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) });
  });

  await page.goto(`${BASE_URL}/${company.issuePrefix}/cos`);
  await expect(page.getByTestId("cos-conversation")).toBeVisible({ timeout: 30_000 });
  const scroller = page.getByTestId("chat-scroller");
  const distance = () =>
    scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  await expect(page.getByText("Note 30:")).toBeInViewport({ timeout: 30_000 });
  await expect.poll(distance).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("chat-jump-to-latest")).toHaveCount(0);

  // A scroll up lets go and offers the way back.
  await scroller.hover();
  await page.mouse.wheel(0, -1200);
  await expect.poll(distance).toBeGreaterThan(400);
  const jump = page.getByTestId("chat-jump-to-latest");
  await expect(jump).toBeVisible();
  await expect(jump).toHaveText("Jump to latest");
  await jump.click();
  await expect.poll(distance).toBeLessThanOrEqual(2);
  await expect(jump).toHaveCount(0);

  // Sending from a scrolled-up position follows again.
  await page.mouse.wheel(0, -1200);
  await expect(jump).toBeVisible();
  await page.getByLabel("Message input").fill("Thanks, that's clear.");
  await page.getByLabel("Message input").press("Enter");
  await expect(page.getByText("Thanks, that's clear.")).toBeInViewport({ timeout: 20_000 });
  await expect.poll(distance).toBeLessThanOrEqual(32);
  await expect(jump).toHaveCount(0);
});
