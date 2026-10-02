/**
 * E2E: Scan 3 lane I — the review loop on a deliverable.
 *
 * Decisions lists a deliverable waiting for review and says how to clear it;
 * the issue's Result block offers Accept and Request changes; Request changes
 * posts the note as a comment and moves the issue back to work; a file: URL
 * is never shown or linked.
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function createCompany(request: APIRequestContext) {
  const created = await request.post(`${BASE_URL}/api/companies`, {
    data: { name: `E2E-Review-${Date.now()}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()) as { id: string; issuePrefix: string };
}

test.describe("Review loop (Scan 3 lane I)", () => {
  test("request changes from the issue sends it back with the note", async ({ page, request }) => {
    const company = await createCompany(request);
    const title = `Draft the Japan proposal ${Date.now()}`;
    const issueRes = await request.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: { title, status: "in_review" },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = (await issueRes.json()) as { id: string; identifier: string | null };

    const wpRes = await request.post(`${BASE_URL}/api/issues/${issue.id}/work-products`, {
      data: {
        type: "document",
        provider: "local",
        title: "Tanaka family proposal",
        url: "file:///private/tmp/run-workspace/tanaka-japan-proposal.md",
        status: "ready_for_review",
      },
    });
    expect(wpRes.ok(), await wpRes.text()).toBe(true);

    // Decisions: the review is listed, and the footnote says how to clear it.
    await page.goto(`${BASE_URL}/${company.issuePrefix}/decisions`);
    const decisions = page.getByTestId("decisions");
    await expect(decisions).toBeVisible({ timeout: 20_000 });
    await expect(decisions).toContainText(title);
    await expect(page.getByText("Open a review and choose Accept or Request changes.", { exact: false })).toBeVisible();

    await page.goto(`${BASE_URL}/${company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const result = page.getByTestId("issue-result-block");
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result.getByTestId("work-product-state")).toHaveText("ready for review");
    expect(await result.innerHTML()).not.toContain("file:");
    expect(await result.innerHTML()).not.toContain("/private/tmp");
    await expect(result.getByTestId("work-product-local-note")).toHaveText("The agent saved this on its computer. Ask it to attach the content.");
    await expect(result.getByTestId("issue-review-accept")).toBeVisible();

    await result.getByTestId("issue-review-request-changes").click();
    await result.getByTestId("issue-review-note").fill("Add hotel prices for Kyoto.");
    await result.getByTestId("issue-review-send-changes").click();

    await expect(result.getByTestId("work-product-state")).toHaveText("changes requested", { timeout: 15_000 });
    await expect(result.getByTestId("issue-review-actions")).toHaveCount(0);
    await expect(page.getByText("Add hotel prices for Kyoto.").first()).toBeVisible({ timeout: 15_000 });

    const after = await request.get(`${BASE_URL}/api/issues/${issue.id}`);
    expect(after.ok()).toBe(true);
    expect(((await after.json()) as { status: string }).status).not.toBe("in_review");
  });

  // Scan 4 lane M: after Request changes the agent writes rev 2 and moves the
  // issue back to in_review. The deliverable must be reviewable again: Accept
  // and Request changes return, and Accept approves it.
  test("resubmitting to in_review brings back Accept, and Accept approves the revision", async ({ page, request }) => {
    const company = await createCompany(request);
    const title = `Revise the Japan proposal ${Date.now()}`;
    const issueRes = await request.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: { title, status: "in_review" },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = (await issueRes.json()) as { id: string; identifier: string | null };
    const wpRes = await request.post(`${BASE_URL}/api/issues/${issue.id}/work-products`, {
      data: { type: "document", provider: "paperclip", title: "Tanaka family proposal", status: "ready_for_review" },
    });
    expect(wpRes.ok(), await wpRes.text()).toBe(true);
    const product = (await wpRes.json()) as { id: string };

    await page.goto(`${BASE_URL}/${company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const result = page.getByTestId("issue-result-block");
    await expect(result).toBeVisible({ timeout: 20_000 });
    await result.getByTestId("issue-review-request-changes").click();
    await result.getByTestId("issue-review-note").fill("Add hotel prices for Kyoto.");
    await result.getByTestId("issue-review-send-changes").click();
    await expect(result.getByTestId("work-product-state")).toHaveText("changes requested", { timeout: 15_000 });
    await expect(result.getByTestId("issue-review-actions")).toHaveCount(0);

    // The revision is resubmitted by moving the issue back to in_review.
    const resubmit = await request.patch(`${BASE_URL}/api/issues/${issue.id}`, {
      data: { status: "in_review", comment: "Revised: added Kyoto hotel prices." },
    });
    expect(resubmit.ok(), await resubmit.text()).toBe(true);

    await page.reload();
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result.getByTestId("work-product-state")).toHaveText("ready for review", { timeout: 15_000 });
    await expect(result.getByTestId("issue-review-request-changes")).toBeVisible();
    await result.getByTestId("issue-review-accept").click();

    await expect.poll(async () => {
      const res = await request.get(`${BASE_URL}/api/issues/${issue.id}/work-products`);
      const items = (await res.json()) as Array<{ id: string; status: string }>;
      return items.find((item) => item.id === product.id)?.status;
    }, { timeout: 15_000 }).toBe("approved");
  });
});
