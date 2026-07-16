import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRunEvents,
  heartbeatRuns,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { agentService } from "../services/agents.js";
import { approvalService } from "../services/approvals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres(
  "POST /approvals/:id/approve — mandate_violation resumes the grantee (integration)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mandate-bounceback-resume-");
      db = createDb(tempDb.connectionString);
    }, 30_000);

    // Cleanup order mirrors agentService(db).remove()'s teardown — approving a
    // mandate_violation also fires the existing requester-wakeup path, which
    // can leave rows in these heartbeat/runtime tables referencing the agent.
    afterEach(async () => {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      await db.delete(agentTaskSessions);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(agentRuntimeState);
      await db.delete(approvals);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    // Board actor + errorHandler mirrors the harness in
    // mandated-actions-route.test.ts / billing-trial-lifecycle.test.ts.
    function appFor(actor: unknown) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      app.use(approvalRoutes(db));
      app.use(errorHandler);
      return app;
    }

    async function seedCompanyAndAgent(): Promise<{ companyId: string; agentId: string }> {
      const [company] = await db.insert(companies).values({ name: "Mandate Bounceback Co" }).returning();
      const [agent] = await db
        .insert(agents)
        .values({ companyId: company.id, name: "Grantee Agent" })
        .returning();
      return { companyId: company.id, agentId: agent.id };
    }

    it("resumes the paused grantee agent when its mandate_violation approval is approved", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();

      await agentService(db).pause(agentId, "mandate");
      const pausedAgent = await agentService(db).getById(agentId);
      expect(pausedAgent?.status).toBe("paused");
      expect(pausedAgent?.pauseReason).toBe("mandate");

      const approval = await approvalService(db).create(companyId, {
        type: "mandate_violation",
        requestedByAgentId: agentId,
        payload: {},
      });

      const app = appFor({
        type: "board",
        source: "local_implicit",
        isInstanceAdmin: true,
      });

      const res = await request(app).post(`/approvals/${approval.id}/approve`).send({});

      expect(res.status).toBeLessThan(400);

      const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agentRow.status).not.toBe("paused");
      expect(agentRow.pauseReason).toBeNull();
    });
  },
);
