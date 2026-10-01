import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { workspacePersistenceHold } from "../services/workspace-persistence-recovery.js";

// AgentDash (#881 review P3): a workspace attempt recorded with
// recoveryRequired before persistence can outlive a restart. This is the
// audited human exit; it marks the attempt resolved and never replays.
describe("workspace recovery clear", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("workspace-recovery-clear-");
    db = createDb(temp.connectionString);
  });
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture(withIssue = true) {
    const [company] = await db.insert(companies).values({ name: "Quarantine", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Held", status: "todo", assigneeAgentId: agent.id }).returning();
    const workspaceId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, status: "failed", errorCode: "workspace_persistence_uncertain",
      resultJson: { workspacePersistence: { companyId: company.id, agentId: agent.id, issueId: withIssue ? issue.id : null,
        workspaceId, phase: "workspace", outcome: "pending", recoveryRequired: true } },
      usageJson: { workspacePersistenceAttemptId: workspaceId },
    }).returning();
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: "member-user", membershipRole: "member", status: "active" },
      { companyId: company.id, principalType: "user", principalId: "admin-user", membershipRole: "admin", status: "active" },
    ]);
    return { company, agent, issue, run };
  }
  function app(actor: Record<string, unknown>) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    result.use("/api", issueRoutes(db, {} as any));
    result.use(errorHandler);
    return result;
  }
  const member = (companyId: string) => ({ type: "board", userId: "member-user", companyIds: [companyId], source: "session",
    memberships: [{ companyId, membershipRole: "member", status: "active" }], isInstanceAdmin: false });
  const admin = (companyId: string) => ({ type: "board", userId: "admin-user", companyIds: [companyId], source: "session",
    memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false });

  it("lets a board user clear an issue's quarantine, audited, and refuses agents and assistant grants", async () => {
    const f = await fixture();
    expect(await workspacePersistenceHold(db, f.company.id, f.agent.id, f.issue.id)).not.toBeNull();
    const url = `/api/companies/${f.company.id}/workspace-recovery/clear`;
    const agentRes = await request(app({ type: "agent", agentId: f.agent.id, companyId: f.company.id, source: "agent_key" }))
      .post(url).send({ issueId: f.issue.id });
    expect(agentRes.status).toBe(403);
    const assistantRes = await request(app({ ...member(f.company.id), source: "assistant_grant" })).post(url).send({ issueId: f.issue.id });
    expect(assistantRes.status).toBe(403);
    expect(await workspacePersistenceHold(db, f.company.id, f.agent.id, f.issue.id)).not.toBeNull();

    const res = await request(app(member(f.company.id))).post(url).send({ issueId: f.issue.id, note: "Checked the workspace" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.runIds).toEqual([f.run.id]);
    expect(await workspacePersistenceHold(db, f.company.id, f.agent.id, f.issue.id)).toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect((run.resultJson as any).workspacePersistence).toMatchObject({ recoveryRequired: false, outcome: "resolved_by_board",
      resolvedByUserId: "member-user", previousOutcome: "pending" });
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.company.id), eq(activityLog.action, "workspace.persistence_recovery_cleared")));
    expect(audit).toHaveLength(1);

    const again = await request(app(member(f.company.id))).post(url).send({ issueId: f.issue.id });
    expect(again.status).toBe(409);
  });

  it("requires company admin for an agent-level hold", async () => {
    const f = await fixture(false);
    expect(await workspacePersistenceHold(db, f.company.id, f.agent.id, null)).not.toBeNull();
    const url = `/api/companies/${f.company.id}/workspace-recovery/clear`;
    expect((await request(app(member(f.company.id))).post(url).send({ agentId: f.agent.id })).status).toBe(403);
    expect((await request(app(admin(f.company.id))).post(url).send({ agentId: f.agent.id, issueId: f.issue.id })).status).toBe(400);
    const res = await request(app(admin(f.company.id))).post(url).send({ agentId: f.agent.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await workspacePersistenceHold(db, f.company.id, f.agent.id, null)).toBeNull();
  });
});
