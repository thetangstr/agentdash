import { test, expect } from "@playwright/test";

/**
 * E2E: Onboarding wizard flow (skip_llm mode).
 *
 * Walks through the 4-step OnboardingWizard:
 *   Step 1 — Name your company
 *   Step 2 — Create your first agent (adapter selection + config)
 *   Step 3 — Give it something to do (task creation)
 *   Step 4 — Ready to launch (summary + open issue)
 *
 * By default this runs in skip_llm mode: we do NOT assert that an LLM
 * heartbeat fires. Set PAPERCLIP_E2E_SKIP_LLM=false to enable LLM-dependent
 * assertions (requires a valid ANTHROPIC_API_KEY).
 */

const SKIP_LLM = process.env.PAPERCLIP_E2E_SKIP_LLM !== "false";

// Closes #311: the OnboardingWizard's default agent renamed from "CEO"
// (role=ceo) to "CoS" (role=chief_of_staff) at the CoS-onboarding refit.
// Test updated to match the current product shape — see
// ui/src/components/OnboardingWizard.tsx for the canonical defaults
// (placeholder="CoS", role="chief_of_staff", DEFAULT_TASK_DESCRIPTION
// starts with "You are the Chief of Staff (CoS).").
const COMPANY_NAME = `E2E-Test-${Date.now()}`;
const AGENT_NAME = "CoS";
const AGENT_ROLE = "chief_of_staff";
const TASK_TITLE = "E2E test task";

test.describe("Onboarding wizard", () => {
  test("completes full wizard flow", async ({ page }) => {
    await page.goto("/onboarding");

    const wizardHeading = page.locator("h3", { hasText: "Name your company" });

    await expect(wizardHeading).toBeVisible({ timeout: 5_000 });

    const companyNameInput = page.locator('input[placeholder="Acme Corp"]');
    await companyNameInput.fill(COMPANY_NAME);

    const nextButton = page.getByRole("button", { name: "Next" });
    await nextButton.click();

    await expect(
      page.locator("h3", { hasText: "Create your first agent" })
    ).toBeVisible({ timeout: 30_000 });

    const agentNameInput = page.locator('input[placeholder="CoS"]');
    await expect(agentNameInput).toHaveValue(AGENT_NAME);

    await expect(
      page.locator("button", { hasText: "Claude Code" }).locator("..")
    ).toBeVisible();

    await page.getByRole("button", { name: "More Agent Adapter Types" }).click();
    await expect(page.getByRole("button", { name: "Process" })).toHaveCount(0);

    await page.getByRole("button", { name: "Next" }).click();

    // Step 3 — mandate. Every answer defaults to the careful option, so the
    // step advances without input; the wizard writes AGENTS.md from these.
    await expect(
      page.locator("h3", { hasText: "Set the rules for" })
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Next" }).click();

    // Step 4 — first goal. Pre-filled with a worked example.
    await expect(
      page.locator("h3", { hasText: "Your first goal" })
    ).toBeVisible({ timeout: 30_000 });
    // The goal is now a decision, not a default. Nothing is pre-selected, so
    // Next stays disabled until the owner picks an example, writes their own,
    // or explicitly skips — a workspace used to ship a goal written for a
    // different company purely because clicking through was easier than
    // reading. Assert the gate, then make a choice like a person would.
    const goalNext = page.getByRole("button", { name: "Next" });
    await expect(goalNext).toBeDisabled();
    await page.getByText("A recurring pack or report that takes days of chasing").click();
    await expect(goalNext).toBeEnabled();
    await goalNext.click();

    await expect(
      page.locator("h3", { hasText: "Give it something to do" })
    ).toBeVisible({ timeout: 30_000 });

    const baseUrl = page.url().split("/").slice(0, 3).join("/");
    if (SKIP_LLM) {
      const companiesAfterAgentRes = await page.request.get(`${baseUrl}/api/companies`);
      expect(companiesAfterAgentRes.ok()).toBe(true);
      const companiesAfterAgent = await companiesAfterAgentRes.json();
      const companyAfterAgent = companiesAfterAgent.find(
        (c: { name: string }) => c.name === COMPANY_NAME
      );
      expect(companyAfterAgent).toBeTruthy();

      const agentsAfterCreateRes = await page.request.get(
        `${baseUrl}/api/companies/${companyAfterAgent.id}/agents`
      );
      expect(agentsAfterCreateRes.ok()).toBe(true);
      const agentsAfterCreate = await agentsAfterCreateRes.json();
      const ceoAgentAfterCreate = agentsAfterCreate.find(
        (a: { name: string }) => a.name === AGENT_NAME
      );
      expect(ceoAgentAfterCreate).toBeTruthy();

      const disableWakeRes = await page.request.patch(
        `${baseUrl}/api/agents/${ceoAgentAfterCreate.id}?companyId=${encodeURIComponent(companyAfterAgent.id)}`,
        {
          data: {
            runtimeConfig: {
              heartbeat: {
                enabled: false,
                intervalSec: 300,
                wakeOnDemand: false,
                cooldownSec: 10,
                maxConcurrentRuns: 5,
              },
            },
          },
        }
      );
      expect(disableWakeRes.ok()).toBe(true);
    }

    const taskTitleInput = page.locator(
      'input[placeholder="e.g. Research competitor pricing"]'
    );
    await taskTitleInput.clear();
    await taskTitleInput.fill(TASK_TITLE);

    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Ready to launch" })
    ).toBeVisible({ timeout: 30_000 });

    // .first(): the launch summary now echoes these values in more than one
    // place (name in the header and again in the review list), and a bare
    // text= locator is strict-mode ambiguous. The assertion's intent is "the
    // review step shows what I entered", which the first match proves.
    await expect(page.locator("text=" + COMPANY_NAME).first()).toBeVisible();
    await expect(page.locator("text=" + AGENT_NAME).first()).toBeVisible();
    await expect(page.locator("text=" + TASK_TITLE).first()).toBeVisible();

    await page.getByRole("button", { name: "Create & Open Issue" }).click();

    await expect(page).toHaveURL(/\/issues\//, { timeout: 30_000 });

    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find(
      (c: { name: string }) => c.name === COMPANY_NAME
    );
    expect(company).toBeTruthy();

    const agentsRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    const ceoAgent = agents.find(
      (a: { name: string }) => a.name === AGENT_NAME
    );
    expect(ceoAgent).toBeTruthy();
    expect(ceoAgent.role).toBe(AGENT_ROLE);
    expect(ceoAgent.adapterType).not.toBe("process");

    const instructionsBundleRes = await page.request.get(
      `${baseUrl}/api/agents/${ceoAgent.id}/instructions-bundle?companyId=${company.id}`
    );
    expect(instructionsBundleRes.ok()).toBe(true);
    const instructionsBundle = await instructionsBundleRes.json();
    const expectedInstructionFiles = ceoAgent.adapterType === "hermes_local"
      // Hermes does not advertise managed-bundle support; onboarding still
      // persists the owner's mandate as AGENTS.md for inspection and editing.
      ? ["AGENTS.md"]
      : ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"];
    expect(
      instructionsBundle.files.map((file: { path: string }) => file.path).sort()
    ).toEqual(expectedInstructionFiles);

    const issuesRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/issues`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    const task = issues.find(
      (i: { title: string }) => i.title === TASK_TITLE
    );
    expect(task).toBeTruthy();
    expect(task.assigneeAgentId).toBe(ceoAgent.id);
    expect(task.description).toContain(
      "You are the Chief of Staff (CoS)."
    );
    expect(task.description).not.toContain("github.com/paperclipai/companies");

    if (!SKIP_LLM) {
      await expect(async () => {
        const res = await page.request.get(
          `${baseUrl}/api/issues/${task.id}`
        );
        const issue = await res.json();
        expect(["in_progress", "done"]).toContain(issue.status);
      }).toPass({ timeout: 120_000, intervals: [5_000] });
    } else {
      await expect
        .poll(async () => {
          const runsRes = await page.request.get(
            `${baseUrl}/api/companies/${company.id}/heartbeat-runs?agentId=${ceoAgent.id}`
          );
          expect(runsRes.ok()).toBe(true);
          const runs = await runsRes.json();
          return Array.isArray(runs) ? runs.length : -1;
        }, { timeout: 10_000, intervals: [500, 1_000, 2_000] })
        .toBe(0);
    }
  });
});
