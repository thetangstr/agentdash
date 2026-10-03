/**
 * E2E (canary, lane chat): chat stays live without the socket.
 *
 * The hosted canary went silent when the edge answered WS 502 twice: the
 * server stored and replied to messages, but nothing showed for minutes
 * while the badge kept saying "Connected". This spec closes every company
 * WebSocket the moment it opens — the page behaves as if the edge never
 * upgrades — and asserts:
 *   - the badge shows reconnecting, not "Connected";
 *   - a sent message is on screen as soon as its POST returns;
 *   - a stored reply still arrives, via the pending-reply poll.
 *
 * The reply is a fixture row the messages GET starts returning once the
 * person's POST lands, so nothing depends on a model.
 *
 * Run on a free port, never 3199:
 *   PAPERCLIP_E2E_PORT=3847 pnpm exec playwright test \
 *     --config tests/e2e/playwright.config.ts cos-chat-socket-down.spec.ts
 */

import { test, expect } from "@playwright/test";

type Company = { id: string; issuePrefix: string };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("CoS chat: sent and stored replies show with the WebSocket down", async ({ page, request }) => {
  test.setTimeout(120_000);
  const res = await request.post("/api/companies", { data: { name: `E2E Socket Down ${Date.now()}` } });
  expect(res.ok(), `create company: ${res.status()} ${await res.text()}`).toBe(true);
  const company = (await res.json()) as Company;
  try {

  // Every company socket is accepted then closed — the client behaves as if
  // the edge refused the upgrade and keeps retrying.
  await page.routeWebSocket(/\/api\/companies\/[^/]+\/events\/ws/, (ws) => {
    ws.close({ code: 1011, reason: "e2e blocked socket" });
  });

  // GETs are fixture-served; the POST continues to the real server so its
  // persisted row is what the UI publishes. Once the POST lands, later GETs
  // include the stored "reply" — exactly what the pending-reply poll fetches.
  let userPosted = false;
  await page.route("**/api/conversations/*/messages*", async (route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      if (req.method() === "POST") userPosted = true;
      await route.continue();
      return;
    }
    const convoId = new URL(req.url()).pathname.match(/\/api\/conversations\/([^/]+)\/messages/)?.[1] ?? "c";
    const rows = [
      {
        id: id(1),
        conversationId: convoId,
        role: "agent",
        content: "Welcome aboard.",
        cardKind: null,
        cardPayload: null,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
      ...(userPosted
        ? [{
            id: id(2),
            conversationId: convoId,
            role: "agent",
            content: "Yes — I can still hear you.",
            cardKind: null,
            cardPayload: null,
            // After the POST's server timestamp so it sorts last on merge.
            createdAt: new Date(Date.now() + 2_000).toISOString(),
          }]
        : []),
    ];
    // The server returns newest first.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows.reverse()) });
  });

  await page.goto(`/${company.issuePrefix}/cos`);
  await expect(page.getByTestId("cos-conversation")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("cos-conversation")).toContainText("Welcome aboard.", { timeout: 30_000 });

  // Health is green; the badge must not pretend the live channel is up.
  await expect(page.getByTestId("connection-status")).toContainText(/Reconnecting|Connecting/, { timeout: 15_000 });

  const input = page.getByLabel("Message input");
  await input.fill("Hello, is anyone there?");
  await input.press("Enter");

  // The POST response is the persisted row; it appears without the socket.
  await expect(page.getByTestId("cos-conversation")).toContainText("Hello, is anyone there?");

  // A reply is owed…
  await expect(page.getByTestId("cos-thinking")).toBeVisible({ timeout: 15_000 });
  // …and the stored row still arrives — the pending-reply poll fetches it
  // even though no socket event ever comes.
  await expect(page.getByTestId("cos-conversation")).toContainText("Yes — I can still hear you.", { timeout: 30_000 });
  await expect(page.getByTestId("cos-thinking")).toBeHidden();
  } finally {
    // Remove the workspace so it can't become another spec's companies[0]
    // fallback target for the rest of the run (same cleanup as
    // budget-hard-stop and signoff-policy).
    await request.delete(`/api/companies/${company.id}`).catch(() => {});
  }
});
