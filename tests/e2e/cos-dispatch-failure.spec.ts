/**
 * E2E: P0 CoS chat never goes silent (v2026.1002.0).
 *
 * Run with tests/e2e/playwright-cos-dispatch.config.ts: the server dispatches
 * for real to a fake hermes that fails like canary1 (Z.AI HTTP 429, reason on
 * stdout) until a flag file exists. Asserts: "CoS is thinking..." while the
 * reply is owed, then the error card with the reason and a Retry, then Retry
 * resolving into the real reply with no error card left as the last word.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

test("a failed CoS reply shows thinking, then the reason with Retry, then the reply", async ({ page, request }) => {
  const okFile = path.resolve(process.cwd(), "tests/e2e/fixtures/.fake-hermes-ok");
  fs.rmSync(okFile, { force: true });

  const created = await request.post(`${BASE_URL}/api/companies`, { data: { name: `E2E-CosDispatch-${Date.now()}` } });
  expect(created.ok(), await created.text()).toBe(true);
  const company = (await created.json()) as { id: string; issuePrefix: string };

  await page.goto(`${BASE_URL}/${company.issuePrefix}/cos`);
  await expect(page.getByTestId("cos-conversation")).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Message input").fill("Quick check: are you there?");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByTestId("cos-thinking")).toBeVisible({ timeout: 10_000 });

  const card = page.getByTestId("cos-dispatch-error");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("CoS couldn't reply:");
  await expect(card).toContainText("Insufficient balance or no resource package");
  await expect(card).not.toContainText("session_id");
  await expect(page.getByTestId("cos-dispatch-error-hint")).toContainText("re-save your model key");
  await expect(page.getByTestId("cos-thinking")).toHaveCount(0);

  // The provider is fixed; Retry re-runs the reply without posting the message again.
  fs.writeFileSync(okFile, "ok");
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("cos-thinking")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Hello, I am your Chief of Staff and I am back.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("cos-thinking")).toHaveCount(0);
  fs.rmSync(okFile, { force: true });
});
