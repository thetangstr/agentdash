import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// These fixtures inject req.actor without running the auth middleware, so no
// verified credential exists (same arrangement as document-run-protection).
vi.mock("../services/issue-current-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-current-authority.js")>()),
  issueCurrentAuthority: () => undefined,
}));

import {
  activityLog,
  agentDirectives,
  agentStewardships,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentDirectivesRoutes } from "../routes/agent-directives.js";
import { agentRoutes } from "../routes/agents.js";
import {
  ADMIN_TRANSCRIPT_READ_LOG_WINDOW_MS,
  resetAdminTranscriptReadLogForTests,
} from "../routes/document-run-access.js";
import { errorHandler } from "../middleware/index.js";
import { featureFlagsService } from "../services/feature-flags.js";
import { resetRunLogStoreForTests } from "../services/run-log-store.js";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash admin powers (parts 4.2 and 4.3): the two admin-switched reads,
 * against a real database and the real routers.
 *
 * Directives: the steward reads as before; an owner or admin reads only with
 * the company switch on, through their own session, and every such read is
 * logged. Writing stays the steward's alone.
 *
 * Transcripts (with document access on): the steward reads as before; an
 * owner or admin reads a run's detail, events and log only with the switch
 * on, logged once per person and run per 10 minutes. Listings stay blanked.
 */
describeEmbeddedPostgres("admin-switched reads (parts 4.2, 4.3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const saved: Record<string, string | undefined> = {};

  const MK = randomUUID(); // agentdash_mk profile, document access on
  const PLAIN = randomUUID(); // default profile, document access off
  const ELSEWHERE = randomUUID(); // another mk company
  const ADMIN = "switch-admin";
  const STEWARD = "switch-steward";
  const MEMBER = "switch-member";

  const STEWARDED = randomUUID();
  const UNSTEWARDED = randomUUID();
  const ELSEWHERE_AGENT = randomUUID();
  const PLAIN_AGENT = randomUUID();
  const RUN = randomUUID();
  const RUN_TWO = randomUUID();
  const PLAIN_RUN = randomUUID();
  const SECRET = "transcript-secret-figures";

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY", "RUN_LOG_BASE_PATH"]) {
      saved[key] = process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), "admin-switched-reads-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "admin-switched-reads-test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "d".repeat(64);
    process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-admin-switched-reads-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values([
      { id: MK, name: "MK Co", issuePrefix: "SWM", productProfile: "agentdash_mk" },
      { id: PLAIN, name: "Plain Co", issuePrefix: "SWP", productProfile: "default", adminDirectiveReadEnabled: true, adminTranscriptReadEnabled: true },
      { id: ELSEWHERE, name: "Elsewhere Co", issuePrefix: "SWE", productProfile: "agentdash_mk" },
    ]);
    for (const companyId of [MK, PLAIN]) {
      for (const [userId, role] of [[ADMIN, "admin"], [STEWARD, "member"], [MEMBER, "member"]] as const) {
        await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
      }
    }
    await db.insert(agents).values([
      { id: STEWARDED, companyId: MK, name: "Stewarded", role: "general", adapterType: "process", adapterConfig: {} },
      { id: UNSTEWARDED, companyId: MK, name: "Unstewarded", role: "general", adapterType: "process", adapterConfig: {} },
      { id: ELSEWHERE_AGENT, companyId: ELSEWHERE, name: "Elsewhere", role: "general", adapterType: "process", adapterConfig: {} },
      { id: PLAIN_AGENT, companyId: PLAIN, name: "Plain", role: "general", adapterType: "process", adapterConfig: {} },
    ]);
    await db.insert(agentStewardships).values([
      { companyId: MK, agentId: STEWARDED, userId: STEWARD },
      { companyId: PLAIN, agentId: PLAIN_AGENT, userId: STEWARD },
    ]);
    await db.insert(agentDirectives).values({ companyId: MK, agentId: STEWARDED, version: 1, directives: "Be brief with the board.", pushedByUserId: STEWARD });
    await featureFlagsService(db).set(MK, FEATURE_FLAG_KEYS.DOCUMENT_ACCESS, true);
    await db.insert(heartbeatRuns).values([
      { id: RUN, companyId: MK, agentId: STEWARDED, invocationSource: "on_demand", status: "failed", error: `adapter said: ${SECRET}`, resultJson: { summary: SECRET } },
      { id: RUN_TWO, companyId: MK, agentId: UNSTEWARDED, invocationSource: "on_demand", status: "failed", error: `second: ${SECRET}` },
      { id: PLAIN_RUN, companyId: PLAIN, agentId: PLAIN_AGENT, invocationSource: "on_demand", status: "failed", error: `plain: ${SECRET}` },
    ]);
    await db.insert(heartbeatRunEvents).values({ companyId: MK, runId: RUN, agentId: STEWARDED, seq: 1, eventType: "log", message: SECRET });
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    resetAdminTranscriptReadLogForTests();
    await db.delete(activityLog);
    await db.update(companies).set({ adminDirectiveReadEnabled: false, adminTranscriptReadEnabled: false }).where(eq(companies.id, MK));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });

  function appAs(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentDirectivesRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }
  const asUser = (userId: string, role: string) => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [MK, PLAIN, ELSEWHERE],
    memberships: [MK, PLAIN].map((companyId) => ({ companyId, membershipRole: role, status: "active" })),
  });
  const asAssistant = (userId: string, role: string) => ({
    ...asUser(userId, role),
    source: "assistant_grant",
    assistantGrantId: randomUUID(),
    assistantClientName: "Claude",
  });
  const admin = () => appAs(asUser(ADMIN, "admin"));
  const steward = () => appAs(asUser(STEWARD, "member"));
  const member = () => appAs(asUser(MEMBER, "member"));

  async function switchOn(column: "adminDirectiveReadEnabled" | "adminTranscriptReadEnabled", companyId = MK) {
    await db.update(companies).set({ [column]: true }).where(eq(companies.id, companyId));
  }
  const rowsFor = (action: string) => db.select().from(activityLog).where(eq(activityLog.action, action));

  describe("directives", () => {
    const path = (agentId = STEWARDED, companyId = MK) => `/api/companies/${companyId}/agents/${agentId}/directives`;

    it("the steward reads as before, switch on or off, and is not logged", async () => {
      const off = await request(steward()).get(path());
      expect(off.status).toBe(200);
      expect(off.body.active.directives).toBe("Be brief with the board.");
      await switchOn("adminDirectiveReadEnabled");
      expect((await request(steward()).get(path())).status).toBe(200);
      expect(await rowsFor("agent.directives_read_by_admin")).toHaveLength(0);
    });

    it("switch off: an admin gets 403", async () => {
      const res = await request(admin()).get(path());
      expect(res.status).toBe(403);
      expect(await rowsFor("agent.directives_read_by_admin")).toHaveLength(0);
    });

    it("switch on: an admin reads, and every read is logged", async () => {
      await switchOn("adminDirectiveReadEnabled");
      for (let i = 0; i < 3; i += 1) {
        const res = await request(admin()).get(path());
        expect(res.status).toBe(200);
        expect(res.body.active.directives).toBe("Be brief with the board.");
      }
      const logged = await rowsFor("agent.directives_read_by_admin");
      expect(logged).toHaveLength(3);
      expect(logged[0]).toMatchObject({ companyId: MK, actorType: "user", actorId: ADMIN, entityType: "agent", entityId: STEWARDED, agentId: STEWARDED });
      expect(logged[0]!.details).toEqual({ agentId: STEWARDED, stewardUserId: STEWARD });
    });

    it("switch on: works with no active steward (logged with stewardUserId null)", async () => {
      await switchOn("adminDirectiveReadEnabled");
      const res = await request(admin()).get(path(UNSTEWARDED));
      expect(res.status).toBe(200);
      expect(res.body.active).toBeNull();
      const [logged] = await rowsFor("agent.directives_read_by_admin");
      expect(logged!.details).toEqual({ agentId: UNSTEWARDED, stewardUserId: null });
    });

    it("switch on: a member, an admin's assistant grant, and an admin's POST are all 403", async () => {
      await switchOn("adminDirectiveReadEnabled");
      expect((await request(member()).get(path())).status).toBe(403);
      expect((await request(appAs(asAssistant(ADMIN, "admin"))).get(path())).status).toBe(403);
      const post = await request(admin()).post(path()).send({ directives: "Admin words in the agent's mouth." });
      expect(post.status).toBe(403);
      expect(await db.select().from(agentDirectives).where(eq(agentDirectives.agentId, STEWARDED))).toHaveLength(1);
      expect(await rowsFor("agent.directives_read_by_admin")).toHaveLength(0);
    });

    it("the profile gate stays (404 on a default-profile company), and another company's agent is 404", async () => {
      expect((await request(admin()).get(path(PLAIN_AGENT, PLAIN))).status).toBe(404);
      await switchOn("adminDirectiveReadEnabled");
      expect((await request(admin()).get(path(ELSEWHERE_AGENT, MK))).status).toBe(404);
      expect(await rowsFor("agent.directives_read_by_admin")).toHaveLength(0);
    });
  });

  describe("run transcripts", () => {
    const detailPaths = (runId = RUN) => [`/api/heartbeat-runs/${runId}`, `/api/heartbeat-runs/${runId}/events`, `/api/heartbeat-runs/${runId}/log`];

    it("the steward reads as before and is not logged", async () => {
      await switchOn("adminTranscriptReadEnabled");
      for (const p of detailPaths()) {
        const res = await request(steward()).get(p);
        expect(res.status, p).not.toBe(404);
      }
      expect((await request(steward()).get(`/api/heartbeat-runs/${RUN}`)).body.error).toContain(SECRET);
      expect(await rowsFor("run.content_read_by_admin")).toHaveLength(0);
    });

    it("switch off: an admin is refused (404) on detail, events and log", async () => {
      for (const p of detailPaths()) {
        expect((await request(admin()).get(p)).status, p).toBe(404);
      }
      expect(await rowsFor("run.content_read_by_admin")).toHaveLength(0);
    });

    it("switch on: an admin reads what the steward reads, logged once per run per 10 minutes", async () => {
      await switchOn("adminTranscriptReadEnabled");
      for (let poll = 0; poll < 3; poll += 1) {
        for (const p of detailPaths()) {
          const asAdmin = await request(admin()).get(p);
          const asSteward = await request(steward()).get(p);
          expect(asAdmin.status, p).toBe(asSteward.status);
          if (!p.endsWith("/log")) expect(asAdmin.body, p).toEqual(asSteward.body);
        }
      }
      let logged = await rowsFor("run.content_read_by_admin");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ companyId: MK, actorId: ADMIN, entityType: "heartbeat_run", entityId: RUN, agentId: STEWARDED });
      expect(logged[0]!.details).toEqual({ runId: RUN, agentId: STEWARDED, route: "run" });

      // Another run is its own entry; an unstewarded agent's run works too.
      expect((await request(admin()).get(`/api/heartbeat-runs/${RUN_TWO}/events`)).status).toBe(200);
      logged = await rowsFor("run.content_read_by_admin");
      expect(logged.map((row) => (row.details as { route: string }).route).sort()).toEqual(["events", "run"]);

      // After the window, the same run is logged again.
      const realNow = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(realNow + ADMIN_TRANSCRIPT_READ_LOG_WINDOW_MS + 1000);
      expect((await request(admin()).get(`/api/heartbeat-runs/${RUN}/log`)).status).not.toBe(404);
      vi.restoreAllMocks();
      expect(ADMIN_TRANSCRIPT_READ_LOG_WINDOW_MS).toBe(10 * 60 * 1000);
      logged = await rowsFor("run.content_read_by_admin");
      expect(logged).toHaveLength(3);
    });

    it("switch on: listings stay blanked for the admin", async () => {
      await switchOn("adminTranscriptReadEnabled");
      const list = await request(admin()).get(`/api/companies/${MK}/heartbeat-runs`);
      expect(list.status).toBe(200);
      const row = (list.body as Array<Record<string, unknown>>).find((r) => r.id === RUN);
      expect(row).toBeDefined();
      expect(JSON.stringify(list.body)).not.toContain(SECRET);
      expect(await rowsFor("run.content_read_by_admin")).toHaveLength(0);
    });

    it("switch on: an admin's assistant grant and a plain member are refused", async () => {
      await switchOn("adminTranscriptReadEnabled");
      for (const p of detailPaths()) {
        expect((await request(appAs(asAssistant(ADMIN, "admin"))).get(p)).status, p).toBe(404);
        expect((await request(member()).get(p)).status, p).toBe(404);
      }
      expect(await rowsFor("run.content_read_by_admin")).toHaveLength(0);
    });

    it("document access off: everyone reads as before and nothing is logged", async () => {
      for (const p of detailPaths(PLAIN_RUN)) {
        expect((await request(admin()).get(p)).status, p).not.toBe(404);
        expect((await request(member()).get(p)).status, p).not.toBe(404);
      }
      expect((await request(admin()).get(`/api/heartbeat-runs/${PLAIN_RUN}`)).body.error).toContain(SECRET);
      expect(await rowsFor("run.content_read_by_admin")).toHaveLength(0);
      // Another company's admin path does not exist: the switch is per company.
      expect((await db.select().from(companies).where(and(eq(companies.id, MK), eq(companies.adminTranscriptReadEnabled, true))))).toHaveLength(0);
    });
  });
});
