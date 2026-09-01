import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueReportRoutes } from "../routes/issue-reports.js";
import { errorHandler } from "../middleware/error-handler.js";
import { ghFetch } from "../services/github-fetch.js";

// Mock the GitHub seam, not global fetch. These tests drive a real local
// server over HTTP, so a stubbed `fetch` would swallow the test's own requests
// and every assertion would fail on an undefined response — which is exactly
// what happened on the first attempt.
vi.mock("../services/github-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/github-fetch.js")>()),
  ghFetch: vi.fn(),
}));

const ghFetchMock = vi.mocked(ghFetch);

function githubAccepts(number: number) {
  ghFetchMock.mockResolvedValue(
    new Response(JSON.stringify({ number, html_url: `https://github.com/acme/agentdash/issues/${number}` }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** The JSON body of the issue that was actually sent to GitHub. */
function filedIssue() {
  const call = ghFetchMock.mock.calls.at(-1);
  expect(call, "the report never reached GitHub").toBeTruthy();
  return JSON.parse(String((call![1] as RequestInit).body)) as { title: string; body: string };
}

/**
 * Who is allowed to file a bug report.
 *
 * This started as a board-only route, which is the natural shape if you picture
 * a person clicking a button in the UI. It is the wrong shape for the product:
 * the people testing AgentDash drive it from their own terminal, so the thing
 * that hits the defect and holds the context is their AGENT. A board-only route
 * turns "tell your agent to file a bug" into a tool that always 401s — which is
 * how this gap first showed up, reported as "permissions felt incomplete".
 *
 * The tests below pin the actor rules and, just as importantly, the provenance:
 * an agent-filed report must say so, and neither kind of caller may stamp a
 * report with a company it does not belong to.
 */

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Minimal chainable stand-in for the drizzle query builder this route uses. */
function fakeDb(rows: Record<string, unknown>[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return { select: () => chain } as never;
}

async function withServer(
  actor: Record<string, unknown>,
  db: ReturnType<typeof fakeDb>,
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api/issue-reports", issueReportRoutes(db));
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const agentActor = (companyId = COMPANY_A) => ({
  type: "agent",
  agentId: AGENT_ID,
  companyId,
  source: "agent_key",
});

const boardActor = () => ({
  type: "board",
  userId: "user-1",
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
  companyIds: [COMPANY_A],
  source: "session",
});

const REPORT = {
  kind: "bug",
  title: "Renaming an agent does nothing",
  description: "Called the rename tool with a new name; the agent kept its old one.",
};

function post(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/api/issue-reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("filing an issue report: who may file", () => {
  beforeEach(() => {
    process.env.AGENTDASH_GITHUB_ISSUES_REPO = "acme/agentdash";
    process.env.AGENTDASH_GITHUB_ISSUES_TOKEN = "ghp_test";
  });

  afterEach(() => {
    delete process.env.AGENTDASH_GITHUB_ISSUES_REPO;
    delete process.env.AGENTDASH_GITHUB_ISSUES_TOKEN;
    ghFetchMock.mockReset();
  });

  it("lets an agent file, and names the agent as the reporter", async () => {
    githubAccepts(7);

    await withServer(agentActor(), fakeDb([{ name: "Chief of Staff" }]), async (baseUrl) => {
      const res = await post(baseUrl, REPORT);
      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({ number: 7 });
    });

    // A maintainer reading the issue should not have to guess that a machine
    // wrote it — that changes how they read the repro and who they ask next.
    expect(filedIssue().body).toContain("Chief of Staff (agent)");
  });

  it("stamps an agent's report with its own company, ignoring any it claims", async () => {
    githubAccepts(8);

    // The agent's credential says COMPANY_A; the body asks for COMPANY_B.
    // The credential has to win, or provenance is client-controlled fiction.
    await withServer(agentActor(COMPANY_A), fakeDb([{ name: "Acme Corp" }]), async (baseUrl) => {
      const res = await post(baseUrl, { ...REPORT, companyId: COMPANY_B });
      expect(res.status).toBe(201);
    });

    expect(filedIssue().body).not.toContain(COMPANY_B);
  });

  it("still lets a signed-in person file, with their own name", async () => {
    githubAccepts(9);

    await withServer(boardActor(), fakeDb([]), async (baseUrl) => {
      const res = await post(baseUrl, REPORT);
      expect(res.status).toBe(201);
    });

    const body = filedIssue().body;
    expect(body).toContain("Ada Lovelace");
    expect(body).not.toContain("(agent)");
  });

  it("refuses an unauthenticated caller", async () => {
    await withServer({ type: "anonymous" }, fakeDb([]), async (baseUrl) => {
      const res = await post(baseUrl, REPORT);
      expect(res.status).toBe(401);
    });
  });

  it("tells an agent when reporting is not configured, rather than failing opaquely", async () => {
    delete process.env.AGENTDASH_GITHUB_ISSUES_REPO;
    delete process.env.AGENTDASH_GITHUB_ISSUES_TOKEN;

    await withServer(agentActor(), fakeDb([]), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/issue-reports/config`);
      expect(res.status).toBe(200);
      // The agent can check first and say "this instance has no bug queue"
      // instead of promising the user a filed report that went nowhere.
      await expect(res.json()).resolves.toMatchObject({ enabled: false, repo: null });
    });
  });
});
