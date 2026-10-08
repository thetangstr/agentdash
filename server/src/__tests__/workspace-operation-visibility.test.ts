import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, executionWorkspaces, heartbeatRuns, issues, projects, workspaceOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { errorHandler } from "../middleware/index.js";
const read = vi.hoisted(() => vi.fn(async () => ({ content: "synthetic operation output" })));
vi.mock("../services/workspace-operation-log-store.js", () => ({ getWorkspaceOperationLogStore: () => ({ read }) }));
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("workspace operation visibility", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();
  const openProject = randomUUID(), hiddenProject = randomUUID(), otherProject = randomUUID();
  const openIssue = randomUUID(), hiddenIssue = randomUUID();
  const openRun = randomUUID(), hiddenRun = randomUUID();
  const openWorkspace = randomUUID(), hiddenWorkspace = randomUUID(), otherWorkspace = randomUUID();
  const cases = [
    { name: "workspace only restricted", workspace: hiddenWorkspace, run: null, status: 404 },
    { name: "run only restricted", workspace: null, run: hiddenRun, status: 404 },
    { name: "open workspace restricted run", workspace: openWorkspace, run: hiddenRun, status: 404 },
    { name: "restricted workspace open run", workspace: hiddenWorkspace, run: openRun, status: 404 },
    { name: "both open", workspace: openWorkspace, run: openRun, status: 200 },
    { name: "workspace only open", workspace: openWorkspace, run: null, status: 200 },
    { name: "run only open", workspace: null, run: openRun, status: 200 },
    { name: "orphan remains company visible", workspace: null, run: null, status: 200 },
    { name: "cross company workspace", workspace: otherWorkspace, run: openRun, status: 404 },
  ].map(row => ({ ...row, id: randomUUID() }));
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("operation-visibility-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([{ id: companyId, name: "Visible", issuePrefix: "VIS" }, { id: otherCompanyId, name: "Other", issuePrefix: "OTH" }]);
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "reader", membershipRole: "member", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test agent" });
    await db.insert(projects).values([
      { id: openProject, companyId, name: "Open" },
      { id: hiddenProject, companyId, name: "Hidden", visibility: "restricted", createdByUserId: "other" },
      { id: otherProject, companyId: otherCompanyId, name: "Other open" },
    ]);
    await db.insert(issues).values([{ id: openIssue, companyId, projectId: openProject, title: "Open" }, { id: hiddenIssue, companyId, projectId: hiddenProject, title: "Hidden" }]);
    await db.insert(heartbeatRuns).values([{ id: openRun, companyId, agentId, contextSnapshot: { issueId: openIssue } }, { id: hiddenRun, companyId, agentId, contextSnapshot: { issueId: hiddenIssue } }]);
    await db.insert(executionWorkspaces).values([
      { id: openWorkspace, companyId, projectId: openProject },
      { id: hiddenWorkspace, companyId, projectId: hiddenProject },
      { id: otherWorkspace, companyId: otherCompanyId, projectId: otherProject },
    ].map(row => ({ ...row, name: "Synthetic", mode: "shared_workspace", strategyType: "project_primary" })));
    await db.insert(workspaceOperations).values(cases.map(row => ({ id: row.id, companyId, executionWorkspaceId: row.workspace, heartbeatRunId: row.run, phase: "setup", command: row.name, logStore: "local_file", logRef: "synthetic.log" })));
  });
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(() => { read.mockClear(); });
  function appAs(admin = false) {
    const app = express();
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "reader", companyIds: [companyId], memberships: [{ companyId, membershipRole: admin ? "admin" : "member", status: "active" }], isInstanceAdmin: admin }; next(); });
    app.use("/api", agentRoutes(db));
    app.use("/api", executionWorkspaceRoutes(db));
    app.use(errorHandler);
    return app;
  }
  it.each(cases)("$name checks both links before storage", async row => {
    const res = await request(appAs()).get(`/api/workspace-operations/${row.id}/log`);
    expect(res.status, JSON.stringify(res.body)).toBe(row.status);
    expect(read).toHaveBeenCalledTimes(row.status === 200 ? 1 : 0);
  });
  it("unknown ids do not read storage", async () => {
    expect((await request(appAs()).get(`/api/workspace-operations/${randomUUID()}/log`)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
  it("an administrator can read linked restricted operations", async () => {
    expect((await request(appAs(true)).get(`/api/workspace-operations/${cases[2].id}/log`)).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("related lists omit operations whose other link is restricted or cross-company", async () => {
    const workspace = await request(appAs()).get(`/api/execution-workspaces/${openWorkspace}/workspace-operations`);
    expect(workspace.status).toBe(200);
    expect(workspace.body.map((row: { id: string }) => row.id).sort()).toEqual([cases[4].id, cases[5].id].sort());
    const run = await request(appAs()).get(`/api/heartbeat-runs/${openRun}/workspace-operations`);
    expect(run.status).toBe(200);
    expect(run.body.map((row: { id: string }) => row.id).sort()).toEqual([cases[4].id, cases[6].id].sort());
  });
});
