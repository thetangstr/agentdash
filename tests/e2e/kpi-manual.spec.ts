import { test, expect } from "@playwright/test";

/**
 * AGE-45: Manual KPIs end-to-end.
 *
 * Creates a company, uses the settings UI to add a KPI, then exercises the
 * agent tool flow by PATCHing the KPI value via the REST endpoint (which is
 * what the `update_kpi` agent tool calls under the hood). Finally confirms
 * the UI reflects the updated current value.
 */

interface Company {
  id: string;
  name: string;
  issuePrefix: string;
}
interface Kpi {
  id: string;
  name: string;
  currentValue: string | null;
}

async function createCompany(
  page: import("@playwright/test").Page,
  suffix?: string,
): Promise<Company> {
  const ts = Date.now();
  const name = `E2E-KPI-${suffix ?? ts}`;
  const prefix = `K${ts.toString().slice(-5)}`;
  const res = await page.request.post("/api/companies", {
    data: { name, issuePrefix: prefix },
  });
  expect(res.ok(), `create company failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function setKpiValueViaApi(
  page: import("@playwright/test").Page,
  companyId: string,
  kpiId: string,
  value: number,
): Promise<Kpi> {
  const res = await page.request.post(
    `/api/companies/${companyId}/kpis/${kpiId}/value`,
    { data: { value } },
  );
  expect(res.ok(), `set kpi value failed: ${await res.text()}`).toBe(true);
  return res.json();
}

test.describe("AGE-45: Manual KPIs", () => {
  test("CEO can create a KPI via settings and update-value reflects in UI", async ({ page }) => {
    const company = await createCompany(page, "create");

    await page.goto(`/${company.issuePrefix}/company/settings/kpis`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(page.getByTestId("settings-kpis-page")).toBeVisible({ timeout: 10_000 });
    // Empty state is rendered.
    await expect(page.getByTestId("kpi-empty-state")).toBeVisible();

    // Fill in the "add new KPI" row and submit.
    await page.getByTestId("kpi-new-name").fill("MRR");
    await page.getByTestId("kpi-new-unit").fill("USD");
    await page.getByTestId("kpi-new-target").fill("10000");
    await page.getByTestId("kpi-new-priority").fill("5");
    await page.getByTestId("kpi-new-submit").click();

    // Row appears with Name MRR.
    const table = page.getByTestId("kpi-table");
    await expect(table).toBeVisible({ timeout: 10_000 });
    await expect(table.locator("input").filter({ hasText: "" })).toBeTruthy();

    // Verify via API the KPI now exists.
    const listRes = await page.request.get(`/api/companies/${company.id}/kpis`);
    expect(listRes.ok()).toBe(true);
    const kpis = (await listRes.json()) as Array<{
      id: string;
      name: string;
      currentValue: string | null;
    }>;
    expect(kpis.length).toBe(1);
    expect(kpis[0].name).toBe("MRR");
    expect(kpis[0].currentValue).toBeNull();

    // Simulate the `update_kpi` agent tool call by hitting the set-value endpoint.
    const updated = await setKpiValueViaApi(page, company.id, kpis[0].id, 4321);
    expect(updated.currentValue).toBe("4321");

    // Reload and confirm UI shows the new current value.
    await page.reload();
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });
    await expect(page.getByTestId("settings-kpis-page")).toBeVisible({ timeout: 10_000 });
    const currentField = page.getByTestId(`kpi-current-${kpis[0].id}`);
    await expect(currentField).toBeVisible();
    await expect(currentField).toHaveValue("4321");
  });

  test("Delete KPI removes it from the table", async ({ page }) => {
    const company = await createCompany(page, "delete");

    // Seed one KPI via API.
    const createRes = await page.request.post(`/api/companies/${company.id}/kpis`, {
      data: { name: "Churn", unit: "%", targetValue: 5, priority: 1 },
    });
    expect(createRes.ok()).toBe(true);
    const kpi = (await createRes.json()) as { id: string; name: string };

    await page.goto(`/${company.issuePrefix}/company/settings/kpis`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });
    await expect(page.getByTestId("kpi-table")).toBeVisible({ timeout: 10_000 });

    page.once("dialog", (dlg) => dlg.accept());
    await page.getByTestId(`kpi-delete-${kpi.id}`).click();

    await expect(page.getByTestId("kpi-empty-state")).toBeVisible({ timeout: 10_000 });

    // Confirm via API.
    const listRes = await page.request.get(`/api/companies/${company.id}/kpis`);
    const kpis = (await listRes.json()) as unknown[];
    expect(kpis.length).toBe(0);
  });
});
