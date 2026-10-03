import { test, expect } from "@playwright/test";
import { E2E_GITHUB_TOKEN } from "./github-stub.global-setup";

/**
 * E2E (GH #782): connect a GitHub repo to a project with a fine-grained token.
 *
 * GitHub's REST API is stubbed by github-stub.global-setup.ts; the server is
 * pointed at it through AGENTDASH_GITHUB_API_URL (playwright.config.ts).
 *   - acme/app: the token can push and read pull requests → connected;
 *   - acme/readonly: the token cannot push → refused, naming the permission.
 * The token must never come back from the API or appear on the page.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = E2E_GITHUB_TOKEN;

test("an owner connects a repo from project settings and sees it connected", async ({ page, request }) => {
  const companyRes = await request.post(`${BASE_URL}/api/companies`, { data: { name: `E2E-GitHub-${Date.now()}` } });
  expect(companyRes.ok()).toBe(true);
  const company = await companyRes.json();
  const prefix = company.issuePrefix ?? company.urlKey;
  const projectRes = await request.post(`${BASE_URL}/api/companies/${company.id}/projects`, {
    data: { name: `Repo ${Date.now()}` },
  });
  expect(projectRes.ok()).toBe(true);
  const project = await projectRes.json();

  await page.goto(`${BASE_URL}/${prefix}/projects/${project.id}/configuration`);
  const section = page.getByTestId("project-github-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("github-token-howto")).toContainText("Contents: Read and write");
  await expect(section.getByTestId("github-token-howto")).toContainText("can read this token");

  // The alert/connected panel renders off the PUT github-connections
  // permission check; wait for that response rather than asserting on timing.
  const connectCheck = () =>
    page.waitForResponse(
      (res) =>
        res.request().method() === "PUT" &&
        res.url().includes(`/api/companies/${company.id}/github-connections`),
    );

  // Wrong scope: named permission, nothing connected.
  await section.getByLabel("Repository").fill("https://github.com/acme/readonly");
  await section.getByLabel("Fine-grained token").fill(TOKEN);
  const [readonlyCheckRes] = await Promise.all([
    connectCheck(),
    section.getByRole("button", { name: "Check and connect" }).click(),
  ]);
  expect(readonlyCheckRes.status()).toBe(422);
  await expect(section.getByRole("alert")).toContainText("Missing permission: Contents: Read and write");

  // Right scope: connected.
  await section.getByLabel("Repository").fill("https://github.com/acme/app");
  await section.getByLabel("Fine-grained token").fill(TOKEN);
  const [connectRes] = await Promise.all([
    connectCheck(),
    section.getByRole("button", { name: "Check and connect" }).click(),
  ]);
  expect(connectRes.status()).toBe(201);
  await expect(section.getByTestId("github-connected")).toContainText("acme/app");
  await expect(section.getByTestId("github-connected")).toContainText("Default branch main");

  expect(await page.content()).not.toContain(TOKEN);

  const listed = await request.get(`${BASE_URL}/api/companies/${company.id}/github-connections`);
  expect(listed.ok()).toBe(true);
  const body = await listed.text();
  expect(body).toContain('"repo":"acme/app"');
  expect(body).not.toContain(TOKEN);

  // The project's workspace now points at the repo for the managed checkout.
  const projectAfter = await (await request.get(`${BASE_URL}/api/projects/${project.id}`)).json();
  const workspaces = (projectAfter.workspaces ?? []) as Array<{ repoUrl?: string | null }>;
  expect(workspaces.map((workspace) => workspace.repoUrl)).toContain("https://github.com/acme/app");
});
