import { createServer, type Server } from "node:http";
import { test, expect } from "@playwright/test";

/**
 * E2E (GH #782): connect a GitHub repo to a project with a fine-grained token.
 *
 * GitHub's REST API is stubbed on PAPERCLIP_E2E_GITHUB_STUB_PORT; the server is
 * pointed at it through AGENTDASH_GITHUB_API_URL (playwright.config.ts).
 *   - acme/app: the token can push and read pull requests → connected;
 *   - acme/readonly: the token cannot push → refused, naming the permission.
 * The token must never come back from the API or appear on the page.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STUB_PORT = Number(process.env.PAPERCLIP_E2E_GITHUB_STUB_PORT ?? 3297);
const TOKEN = "github_pat_11E2ESTUB00000000000000_playwrightCanaryTokenValue0123";

let stub: Server;
const seenAuth: string[] = [];

test.beforeAll(async () => {
  stub = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end("{}");
      return;
    }
    const match = /^\/repos\/acme\/(app|readonly)(\/pulls.*)?$/.exec(url);
    if (!match) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    if (match[2]) {
      res.end("[]");
      return;
    }
    res.end(
      JSON.stringify({
        name: match[1],
        owner: { login: "acme" },
        default_branch: "main",
        private: true,
        permissions: { push: match[1] === "app", pull: true },
      }),
    );
  });
  await new Promise<void>((resolve) => stub.listen(STUB_PORT, "127.0.0.1", () => resolve()));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

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

  // Wrong scope: named permission, nothing connected.
  await section.getByLabel("Repository").fill("https://github.com/acme/readonly");
  await section.getByLabel("Fine-grained token").fill(TOKEN);
  await section.getByRole("button", { name: "Check and connect" }).click();
  await expect(section.getByRole("alert")).toContainText("Missing permission: Contents: Read and write");

  // Right scope: connected.
  await section.getByLabel("Repository").fill("https://github.com/acme/app");
  await section.getByLabel("Fine-grained token").fill(TOKEN);
  await section.getByRole("button", { name: "Check and connect" }).click();
  await expect(section.getByTestId("github-connected")).toContainText("acme/app");
  await expect(section.getByTestId("github-connected")).toContainText("Default branch main");

  expect(seenAuth).toContain(`Bearer ${TOKEN}`);
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
