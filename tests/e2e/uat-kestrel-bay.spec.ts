import { expect, test, type Page } from "@playwright/test";
import {
  COMPANY,
  GOALS,
  INTERVIEW_ANSWERS,
  MANDATE_ANSWERS,
  MANUAL_TASKS,
  OWNER,
  runSuffix,
} from "./personas/kestrel-bay";

/**
 * The manual punch list, driven by a browser.
 *
 * This is Part A of the UAT plan performed rather than described. It types the
 * whole Kestrel Bay scenario — the description, the mandate including its free
 * text, a goal chosen deliberately — because the content is what the product
 * reasons over, and a walkthrough that types "Acme Corp" and clicks Next proves
 * only that the buttons are wired up.
 *
 * The sign-up at the start is the answer to "how does an agent get a password":
 * it makes its own account with a password it chose. Nothing is shared, nothing
 * is stored, and the run exercises the real first-touch path rather than
 * side-stepping it.
 */

const STAMP = Date.now();
const SUFFIX = runSuffix(STAMP);
const OWNER_EMAIL = OWNER.email.replace("@", `+uat${SUFFIX}@`);
const COMPANY_NAME = `${COMPANY.name} ${SUFFIX}`;

/** Narrate to stdout so a person watching the terminal sees the same story as the browser. */
let stepNo = 0;
async function step(page: Page, title: string, body: () => Promise<void>) {
  stepNo += 1;
  const label = `${String(stepNo).padStart(2, "0")} · ${title}`;
  process.stdout.write(`\n  ▶ ${label}\n`);
  try {
    await body();
    process.stdout.write(`  ✓ ${label}\n`);
  } catch (err) {
    process.stdout.write(`  ✗ ${label}\n`);
    await page
      .screenshot({ path: `test-results/uat/fail-${stepNo}.png`, fullPage: true })
      .catch(() => undefined);
    throw err;
  }
}

test.describe("Kestrel Bay — first week, in a browser", () => {
  test("a principal signs up, describes the practice, and gets a runnable team", async ({ page }) => {
    page.on("console", (msg) => {
      if (msg.type() === "error") process.stdout.write(`      [browser error] ${msg.text().slice(0, 160)}\n`);
    });

    await step(page, `Sign up as ${OWNER.name} (${OWNER.title})`, async () => {
      await page.goto("/auth");
      await page.getByRole("button", { name: "Create one" }).click();
      await page.getByLabel("Name").fill(OWNER.name);
      await page.getByLabel("Email").fill(OWNER_EMAIL);
      await page.getByLabel("Password").fill(OWNER.password);
      await page.getByRole("button", { name: "Create Account" }).click();
      await expect(page).not.toHaveURL(/\/auth/, { timeout: 30_000 });
      process.stdout.write(`      account: ${OWNER_EMAIL}\n`);
    });

    await step(page, "Describe the practice — name and what it is trying to achieve", async () => {
      await page.goto("/onboarding");
      await expect(page.locator("h3", { hasText: "Name your company" })).toBeVisible();
      await page.locator('input[placeholder="Acme Corp"]').fill(COMPANY_NAME);

      // The field the earlier plan skipped. It becomes the company description
      // AND the first goal, so this text is what the Chief of Staff reasons from.
      const description = page.locator('textarea[placeholder="What is this company trying to achieve?"], input[placeholder="What is this company trying to achieve?"]');
      await description.fill(`${GOALS[0].title}. ${COMPANY.description}`);
      process.stdout.write(`      description: ${COMPANY.description.length} chars\n`);
      await page.getByRole("button", { name: "Next" }).click();
    });

    await step(page, "Create the Chief of Staff", async () => {
      await expect(page.locator("h3", { hasText: "Create your first agent" })).toBeVisible({ timeout: 30_000 });
      await page.locator('input[placeholder="CoS"]').fill("Chief");
      await page.getByRole("button", { name: "Next" }).click();
    });

    await step(page, "Write the mandate, including the free-text box at Q8", async () => {
      await expect(page.locator("h3", { hasText: "Set the rules for" })).toBeVisible({ timeout: 30_000 });

      // Q8 — practice-specific knowledge no checkbox covers.
      const freeText = page.locator('textarea[placeholder^="e.g. Never contact anyone at our largest client"]');
      await expect(freeText, "Q8 free-text box should exist").toBeVisible();
      await freeText.fill(MANDATE_ANSWERS.additional);
      process.stdout.write(`      Q8: ${MANDATE_ANSWERS.additional.length} chars typed\n`);

      // It must reach the generated mandate, attributed to the owner.
      const preview = page.locator("pre, textarea, [data-testid='mandate-preview']");
      const previewText = (await preview.first().innerText().catch(() => "")) || "";
      if (previewText) {
        expect(previewText, "Q8 text should appear in the mandate preview").toContain("Harrowfield Trust");
        process.stdout.write("      free text confirmed in the mandate preview\n");
      }
      await page.getByRole("button", { name: "Next" }).click();
    });

    await step(page, "The goal must be chosen, not defaulted", async () => {
      await expect(page.locator("h3", { hasText: "Your first goal" })).toBeVisible({ timeout: 30_000 });

      // The regression this guards: the wizard used to arrive with a board-pack
      // example pre-selected, so clicking through shipped a goal written for a
      // different company.
      const next = page.getByRole("button", { name: "Next" });
      await expect(next, "Next must be disabled until a goal is chosen").toBeDisabled();
      process.stdout.write("      confirmed: nothing pre-selected, Next disabled\n");

      await page.getByText("A recurring pack or report that takes days of chasing").click();
      await expect(next).toBeEnabled();
      await next.click();
    });

    await step(page, "Give the Chief something real to do", async () => {
      await expect(page.locator("h3", { hasText: "Give it something to do" })).toBeVisible({ timeout: 30_000 });
      await page.locator('input[placeholder="e.g. Research competitor pricing"]').fill(MANUAL_TASKS[0].title);
      const detail = page.locator('textarea[placeholder="Add more detail about what the agent should do..."]');
      if (await detail.count()) await detail.fill(MANUAL_TASKS[0].body);
      await page.getByRole("button", { name: "Next" }).click();
    });

    await step(page, "Review the launch summary before committing", async () => {
      // A sixth step the first draft of this spec did not know about. Worth
      // asserting rather than clicking past: this screen is the last point at
      // which a person sees what they are about to create, so what it says has
      // to match what they typed.
      await expect(page.getByRole("heading", { name: "Ready to launch" })).toBeVisible({ timeout: 30_000 });
      const summary = await page.locator("body").innerText();
      const adapterLine = summary.split("\n").find((l) => /Hermes|Claude Code|Codex|Gemini|OpenCode/.test(l));
      process.stdout.write(`      adapter shown: ${adapterLine?.trim() ?? "(none found)"}\n`);

      // The first agent must be able to run on the machine it was created on.
      // Claude Code is not installed on the deployment host, and selecting it
      // also switches on `--dangerously-skip-permissions`, so it must not be
      // what a person gets by not choosing.
      expect(summary, "the default agent must not be Claude Code").not.toContain("Claude Code (local)");
      const goalLine = summary.split("\n").find((l) => l.includes("fire drill") || l.includes("Monday"));
      process.stdout.write(`      goal shown: ${goalLine?.trim() ?? "(none found)"}\n`);
      await page.screenshot({ path: "test-results/uat/launch-summary.png", fullPage: true });
    });

    await step(page, "Launch, and land in the workspace", async () => {
      const launch = page.getByRole("button", { name: /Create & Open Issue|Launch|Finish|Create/ }).last();
      await launch.click();
      await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 60_000 });
      await page.screenshot({ path: "test-results/uat/final-workspace.png", fullPage: true });
      process.stdout.write(`      landed on ${page.url()}\n`);
    });

    await step(page, "The agent exists and is runnable", async () => {
      await page.goto("/agents");
      await expect(page.getByText("Chief").first()).toBeVisible({ timeout: 30_000 });
      const body = await page.locator("body").innerText();
      expect(body, "no agent should be demanding a command").not.toContain("requires a command");
      expect(body, "no preflight banner over a working agent").not.toContain("Harness preflight required");
      process.stdout.write("      Chief present; no preflight banner, no missing-command error\n");
    });

    process.stdout.write(
      `\n  Scenario complete — workspace "${COMPANY_NAME}", owner ${OWNER_EMAIL}\n`
      + `  Interview answers are ready for the next phase (${INTERVIEW_ANSWERS.length} prepared).\n\n`,
    );
  });
});
