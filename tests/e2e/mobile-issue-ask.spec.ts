/**
 * E2E: mobile redesign lane A — issue detail and Ask on a 390×844 phone.
 *
 * Seeds an issue (long description, a document result, a few comments) through
 * the public API, then checks at phone width that:
 *   - the page never scrolls sideways;
 *   - New Sub-issue / Upload / New document live in the header ⋯ menu;
 *   - every tab (Chat, Activity, Related work, Reviews) is reachable and fully on screen;
 *   - the reply composer sits above the bottom nav and nothing covers it;
 *   - Ask shows its starters as one row of chips, the workforce link in the header,
 *     and a composer pinned above the bottom nav.
 *
 * Set MOBILE_SHOTS_DIR to also save 390px screenshots of both pages.
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import fs from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SHOTS_DIR = process.env.MOBILE_SHOTS_DIR?.trim() || null;
const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true });

async function ensureCompany(request: APIRequestContext) {
  const created = await request.post(`${BASE_URL}/api/companies`, {
    data: { name: `E2E-Mobile-${Date.now()}` },
  });
  if (created.ok()) return (await created.json()) as { id: string; issuePrefix: string };
  // Single-company installs refuse a second company; reuse the one there is.
  const list = await request.get(`${BASE_URL}/api/companies`);
  expect(list.ok()).toBe(true);
  const companies = (await list.json()) as Array<{ id: string; issuePrefix: string }>;
  expect(companies.length).toBeGreaterThan(0);
  return companies[0]!;
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, bodyScrollWidth: document.body.scrollWidth };
  });
  expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth);
  expect(overflow.bodyScrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, "element has a layout box").not.toBeNull();
  return box!;
}

/** The composer is on screen, above the bottom nav, and the top-most element at its key points. */
async function expectUnobscured(page: Page, target: Locator) {
  const box = await boxOf(target);
  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(nav).toBeVisible();
  const navBox = await boxOf(nav);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(navBox.y + 1);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  const handle = await target.elementHandle();
  const points = [
    [box.x + box.width / 2, box.y + box.height / 2],
    [box.x + 12, box.y + box.height - 8],
    [box.x + box.width - 12, box.y + box.height - 8],
    [box.x + box.width - 12, box.y + 8],
  ];
  for (const [x, y] of points) {
    const inside = await page.evaluate(
      ({ el, x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit && el && (el === hit || el.contains(hit)));
      },
      { el: handle, x, y },
    );
    expect(inside, `nothing covers the composer at (${Math.round(x)}, ${Math.round(y)})`).toBe(true);
  }
}

function overlapsVertically(a: { y: number; height: number }, b: { y: number; height: number }) {
  return a.y < b.y + b.height && a.y + a.height > b.y;
}

/** The bottom nav slides in and out with a transform; wait until it rests on the bottom edge. */
async function expectNavSettled(page: Page) {
  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(nav).toBeInViewport();
  await expect
    .poll(async () => {
      const box = await nav.boundingBox();
      return box ? Math.round(box.y + box.height) : null;
    })
    .toBe(PHONE.height);
}

async function shot(page: Page, name: string) {
  if (!SHOTS_DIR) return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, name) });
}

test.describe("Mobile issue detail and Ask (390×844)", () => {
  test("issue detail: overflow menu, reachable tabs, docked composer, no sideways scroll", async ({ page, request }) => {
    const company = await ensureCompany(request);

    const issueRes = await request.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: {
        title: "Competitor scan: warehouse picking grippers",
        status: "in_review",
        description:
          "Short competitor scan for our new gripper launch. Cover the 5 most relevant competitors selling picking grippers or end-effectors for warehouse robots: product, positioning, pricing signals, and a one-line takeaway each. One page, with sources. Deliver it as a document on this issue. https://example.com/a/very/long/url/that/should/wrap/instead/of/pushing/the/page/sideways/on/a/phone",
      },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = (await issueRes.json()) as { id: string; identifier: string | null };

    const wpRes = await request.post(`${BASE_URL}/api/issues/${issue.id}/work-products`, {
      data: {
        type: "document",
        provider: "paperclip",
        title: "Competitor scan: warehouse picking grippers",
        status: "ready_for_review",
        isPrimary: true,
      },
    });
    expect(wpRes.ok(), await wpRes.text()).toBe(true);

    for (const body of [
      "Started on this. Pulling product pages and pricing signals first.",
      "Draft is attached as a document. Two competitors do not publish pricing; I noted the signals I could find.",
    ]) {
      const commentRes = await request.post(`${BASE_URL}/api/issues/${issue.id}/comments`, { data: { body } });
      expect(commentRes.ok(), await commentRes.text()).toBe(true);
    }

    await page.goto(`${BASE_URL}/${company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    await expect(page.getByRole("heading", { name: "Competitor scan: warehouse picking grippers" }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("issue-result-block")).toBeVisible();
    await expect(page.getByTestId("issue-chat-composer")).toBeVisible({ timeout: 20_000 });
    await shot(page, "issue-top.png");

    await expectNoHorizontalOverflow(page);

    // The inline action buttons are gone on phones...
    await expect(page.getByRole("button", { name: "New Sub-issue" })).toBeHidden();
    await expect(page.getByTestId("issue-documents-actions").first()).toBeHidden();

    // ...and live in the header ⋯ menu instead.
    const trigger = page.getByTestId("issue-phone-actions-trigger");
    await expect(trigger).toBeVisible();
    const triggerBox = await boxOf(trigger);
    expect(triggerBox.width).toBeGreaterThanOrEqual(44);
    expect(triggerBox.height).toBeGreaterThanOrEqual(44);
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "New sub-issue" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Upload attachment" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "New document" })).toBeVisible();
    for (const item of await menu.getByRole("menuitem").all()) {
      expect((await boxOf(item)).height).toBeGreaterThanOrEqual(44);
    }
    await shot(page, "issue-menu.png");
    // "New document" opens the document draft in place.
    await menu.getByRole("menuitem", { name: "New document" }).click();
    await expect(page.getByPlaceholder(/document key|key/i).or(page.getByPlaceholder(/title/i)).first()).toBeVisible();
    await page.keyboard.press("Escape");

    // Every tab is reachable: scroll it into view inside the tab bar, then it must sit fully on screen.
    const tabList = page.getByTestId("issue-detail-tabs");
    for (const name of ["Activity", "Related work", "Reviews", "Chat"]) {
      const tab = tabList.getByRole("tab", { name });
      await tab.scrollIntoViewIfNeeded();
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      const box = await boxOf(tab);
      expect(box.x, `${name} tab left edge`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} tab right edge`).toBeLessThanOrEqual(PHONE.width);
      expect(box.height, `${name} tab height`).toBeGreaterThanOrEqual(44);
      await expectNoHorizontalOverflow(page);
    }

    // Composer: docked above the bottom nav and not covered by anything (Jump to latest, floating buttons).
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const composer = page.getByTestId("issue-chat-composer");
    await expect(composer).toBeVisible();
    // The bottom nav slides away while scrolling down; scrolling up a little brings it back.
    await page.mouse.wheel(0, -40);
    await expectNavSettled(page);
    await expectUnobscured(page, composer);
    // The in-thread "Jump to latest" link never covers the composer.
    const jump = page.getByTestId("issue-chat-jump-to-latest");
    await expect(jump).toBeVisible();
    expect(overlapsVertically(await boxOf(jump), await boxOf(composer)), "Jump to latest does not cover the composer").toBe(false);
    // At the bottom of a short thread the floating "Latest" control stays out of the way.
    await expect(page.getByTestId("issue-chat-jump-to-latest-floating")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Scroll to bottom" })).toHaveCount(0);
    await shot(page, "issue-chat.png");
    await expectNoHorizontalOverflow(page);
  });

  test("issue detail: a floating Latest control above the docked composer gets a long thread home", async ({ page, request }) => {
    const company = await ensureCompany(request);
    const issueRes = await request.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: { title: "Long thread on a phone", status: "in_review" },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = (await issueRes.json()) as { id: string; identifier: string | null };
    const total = 30;
    for (let i = 1; i <= total; i += 1) {
      const body = `Update ${i} of ${total}: notes on the pick-and-place trial, with enough text to take a few lines on a phone screen.`;
      const commentRes = await request.post(`${BASE_URL}/api/issues/${issue.id}/comments`, { data: { body } });
      expect(commentRes.ok(), await commentRes.text()).toBe(true);
    }

    await page.goto(`${BASE_URL}/${company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const latest = page.getByText(`Update ${total} of ${total}:`);
    await expect(page.getByText(`Update 1 of ${total}:`)).toBeVisible({ timeout: 20_000 });
    const composer = page.getByTestId("issue-chat-composer");
    await expect(composer).toBeVisible();

    // Read from the top of the thread: the composer is docked, the newest update is far below it.
    await page.getByTestId("issue-detail-tabs").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.mouse.wheel(0, -40);
    await expectNavSettled(page);
    await expect(latest).not.toBeInViewport();

    const floating = page.getByTestId("issue-chat-jump-to-latest-floating");
    await expect(floating).toBeVisible();
    await expect(floating).toHaveAccessibleName("Jump to latest");
    const floatingBox = await boxOf(floating);
    const composerBox = await boxOf(composer);
    expect(floatingBox.height).toBeGreaterThanOrEqual(44);
    expect(floatingBox.y + floatingBox.height, "Latest sits above the composer").toBeLessThanOrEqual(composerBox.y);
    expect(floatingBox.x + floatingBox.width).toBeLessThanOrEqual(PHONE.width);
    await expectUnobscured(page, composer);
    await shot(page, "issue-long-thread.png");

    await floating.click();
    await expect(latest).toBeInViewport();
    // The newest update lands above the docked composer, not behind it.
    await expect
      .poll(async () => {
        const latestBox = await latest.boundingBox();
        const composerTop = (await composer.boundingBox())?.y ?? 0;
        return latestBox ? Math.round(latestBox.y + latestBox.height - composerTop) : null;
      })
      .toBeLessThanOrEqual(0);
    await expect(floating).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("Ask: one row of starter chips, header link, composer above the nav", async ({ page, request }) => {
    const company = await ensureCompany(request);
    // The team review link shows once someone besides the CoS is hired (scan 3, lane G).
    const hire = await request.post(`${BASE_URL}/api/companies/${company.id}/agent-hires`, {
      data: {
        name: `Mobile Ask Worker ${Date.now()}`,
        role: "engineer",
        title: "Engineer",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.stdout.write('done\\n')"] },
      },
    });
    expect(hire.ok(), await hire.text()).toBe(true);
    const hired = (await hire.json()) as { approval?: { id: string } };
    if (hired.approval) {
      const approved = await request.post(`${BASE_URL}/api/approvals/${hired.approval.id}/approve`, { data: {} });
      expect(approved.ok(), await approved.text()).toBe(true);
    }

    await page.goto(`${BASE_URL}/${company.issuePrefix}/cos`);
    const conversation = page.getByTestId("cos-conversation");
    await expect(conversation).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Message input")).toBeVisible();

    await expectNoHorizontalOverflow(page);

    // The workforce link is a compact header link on phones; the full-width bar is hidden.
    const headerLink = page.getByTestId("cos-workforce-header-link");
    await expect(headerLink).toBeVisible();
    const linkBox = await boxOf(headerLink);
    expect(linkBox.height).toBeGreaterThanOrEqual(44);
    const header = page.getByTestId("chat-header");
    expect((await boxOf(header)).height).toBeLessThanOrEqual(64);

    // Starters: one horizontal row of chips (same top edge), each a 44px tap target.
    const suggestions = page.getByTestId("chat-suggestions");
    await expect(suggestions).toBeVisible();
    const chips = await suggestions.getByRole("button").all();
    expect(chips.length).toBeGreaterThan(1);
    const tops = new Set<number>();
    for (const chip of chips) {
      const box = await boxOf(chip);
      tops.add(Math.round(box.y));
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(tops.size, "starters sit in one row").toBe(1);
    await expect(chips[chips.length - 1]!).toBeAttached();
    await chips[chips.length - 1]!.scrollIntoViewIfNeeded();
    const lastBox = await boxOf(chips[chips.length - 1]!);
    expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(PHONE.width);
    await expectNoHorizontalOverflow(page);

    // Composer pinned above the bottom nav and unobscured.
    await expectNavSettled(page);
    await expectUnobscured(page, page.getByTestId("chat-composer-dock"));
    const send = page.getByRole("button", { name: "Send message" });
    const sendBox = await boxOf(send);
    expect(sendBox.width).toBeGreaterThanOrEqual(44);
    await shot(page, "ask.png");
  });
});
