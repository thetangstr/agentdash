import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentGovernancePolicies,
  agents,
  approvals,
  bridgeEndpoints,
  bridgeTasks,
  companies,
  companyMemberships,
  connections,
  connectorSendExecutions,
  createDb,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { activityRows, setAccessMode, setAccessPolicy, wouldRefuseRows } from "./helpers/agent-access-fixtures.js";
import { AccessPolicyRefusedError, enforceAgentAccess } from "../services/agent-access-check.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { bridgeService } from "../services/bridge.js";
import { EXPORT_WITHHELD_PROJECT_WARNING_PREFIX, companyPortabilityService } from "../services/company-portability.js";
import { connectorSendExecutionService } from "../services/connector-send-execution.js";
import { connectorService } from "../services/connectors.js";
import { __resetHubspotLimiterState, hubspotConnectorService } from "../services/hubspot-connector.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { workforceService } from "../services/workforce.js";

/**
 * AgentDash: APM gate 3 (P3.4) — the service-level access LLD §4 matrix rows
 * in `enforce`, each with its "On refusal" behaviour: connections not
 * resolvable; connector_send 403 at creation and refused at execution;
 * questions and bridge tasks 403; export omits and lists withheld projects;
 * import refuses up front (no partial import). Plus the escalation path and
 * the MK regression in all three modes.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;
type Mode = "off" | "shadow" | "enforce";

describeEmbeddedPostgres("V2 access checks in enforce mode — service rows (APM gate 3, P3.4)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY"]) savedEnv[key] = process.env[key];
    home = await mkdtemp(join(tmpdir(), "agent-access-enforce-services-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "agent-access-enforce-services";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "e".repeat(64);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-enforce-svc-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function member(companyId: string, membershipRole: string) {
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole });
    return userId;
  }

  async function seed(profile: "default" | "agentdash_mk" = "default") {
    const company = await db
      .insert(companies)
      .values({ name: `Enforce ${randomUUID()}`, issuePrefix: `EN${randomUUID().slice(0, 6).toUpperCase()}`, productProfile: profile })
      .returning()
      .then((rows) => rows[0]!);
    const ownerUserId = await member(company.id, "owner");
    const stewardUserId = await member(company.id, "member");
    const outsiderUserId = await member(company.id, "member");
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: { command: "echo" } })
      .returning()
      .then((rows) => rows[0]!);
    const peer = await db
      .insert(agents)
      .values({ companyId: company.id, name: `Peer ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: { command: "echo" } })
      .returning()
      .then((rows) => rows[0]!);
    if (profile === "agentdash_mk") {
      await agentStewardshipService(db).assign(company.id, { agentId: agent.id, userId: stewardUserId, assignedByUserId: ownerUserId });
    }
    return { company, ownerUserId, stewardUserId, outsiderUserId, agent, peer };
  }

  async function agentConnection(companyId: string, agentId: string, provider = "telegram", scopes: string[] = ["read:messages"]) {
    return db
      .insert(connections)
      .values({
        companyId,
        ownerType: "agent",
        ownerId: agentId,
        provider,
        scopes,
        visibility: "private",
        status: "active",
        autonomy: { read: "full", draft: "full", send: "draft_only" },
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  function detailsOf(row: { details: unknown }) {
    return row.details as Record<string, unknown>;
  }

  async function refusedRows(companyId: string, site?: string) {
    const rows = await activityRows(db, companyId, "authz.refused");
    return site ? rows.filter((row) => detailsOf(row).site === site) : rows;
  }

  function expectEnforcedLog(row: { details: unknown }, expected: { dimension: string; site: string }) {
    expect(detailsOf(row)).toMatchObject({
      reasonCode: "ACCESS_POLICY_REFUSED",
      dimension: expected.dimension,
      policyMode: "enforce",
      site: expected.site,
    });
  }

  async function caught<T>(promise: Promise<T>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("expected a refusal");
  }

  function expectRefusal(error: unknown, expected: { dimension: string; rule: string; requested?: Record<string, unknown> }) {
    expect(error).toBeInstanceOf(AccessPolicyRefusedError);
    const refusal = error as AccessPolicyRefusedError;
    expect(refusal.status).toBe(403);
    expect(refusal.refusal).toMatchObject({
      code: "ACCESS_POLICY_REFUSED",
      dimension: expected.dimension,
      rule: expected.rule,
      ...(expected.requested ? { requested: expected.requested } : {}),
    });
    expect(typeof refusal.refusal.allowedSummary).toBe("string");
    expect(refusal.refusal.howToRequest).toContain("always reachable");
  }

  // -------------------------------------------------------------------------
  // connectors.resolve_acting_as (see.connections): not resolvable; reason logged
  // -------------------------------------------------------------------------

  describe("connectors.resolve_acting_as", () => {
    it("enforce: a connection outside see.connections is not resolvable — blocked as access_policy_refused, logged as authz.refused", async () => {
      const s = await seed();
      const conn = await agentConnection(s.company.id, s.agent.id);
      await setAccessPolicy(db, s.company.id, s.agent.id, { request: { see: { connections: [] } } });
      await setAccessMode(db, s.company.id, "enforce");
      const result = await connectorService(db).resolveActingAs(s.company.id, s.agent.id, "read", "telegram");
      expect(result).toMatchObject({
        ok: false,
        blocked: {
          reason: "access_policy_refused",
          refusal: {
            code: "ACCESS_POLICY_REFUSED",
            dimension: "see.connections",
            rule: "see.connections.not_listed",
            requested: { connectionId: conn.id, dataScope: null },
          },
        },
      });
      const rows = await refusedRows(s.company.id, "connectors.resolve_acting_as");
      expect(rows).toHaveLength(1);
      expectEnforcedLog(rows[0]!, { dimension: "see.connections", site: "connectors.resolve_acting_as" });

      // The read-only inventory preview still asks without enforcing or writing.
      const preview = await connectorService(db).resolveActingAs(s.company.id, s.agent.id, "read", "telegram", { connectionId: conn.id, accessCheck: false });
      expect(preview.ok).toBe(true);
      expect(await refusedRows(s.company.id)).toHaveLength(1);
    });

    it("enforce: a listed connection with an unlisted data scope is not resolvable", async () => {
      const s = await seed();
      const conn = await agentConnection(s.company.id, s.agent.id, "telegram", ["read:messages", "write:messages"]);
      await setAccessPolicy(db, s.company.id, s.agent.id, { request: { see: { connections: [{ connectionId: conn.id, dataScopes: ["read:messages"] }] } } });
      await setAccessMode(db, s.company.id, "enforce");
      const result = await connectorService(db).resolveActingAs(s.company.id, s.agent.id, "read", "telegram");
      expect(result).toMatchObject({ ok: false, blocked: { reason: "access_policy_refused", refusal: { rule: "see.connections.data_scope_not_listed" } } });
    });

    it("off and shadow resolve exactly as gate 2", async () => {
      for (const mode of ["off", "shadow"] as const) {
        const s = await seed();
        await agentConnection(s.company.id, s.agent.id);
        await setAccessPolicy(db, s.company.id, s.agent.id, { request: { see: { connections: [] } } });
        await setAccessMode(db, s.company.id, mode);
        expect((await connectorService(db).resolveActingAs(s.company.id, s.agent.id, "read", "telegram")).ok, mode).toBe(true);
        expect(await refusedRows(s.company.id)).toHaveLength(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // connector_send.create (403) and connector_send.execute (refused, recorded)
  // -------------------------------------------------------------------------

  describe("connector_send.create and connector_send.execute", () => {
    let crmWrites = 0;
    beforeEach(() => {
      crmWrites = 0;
      __resetHubspotLimiterState();
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        const isWrite = (method === "POST" || method === "PATCH") && String(url).includes("/crm/v3/objects/");
        if (isWrite) crmWrites += 1;
        return { ok: true, status: 200, json: async () => (isWrite ? { id: "crm-1" } : {}) } as never;
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const PROPERTIES = { email: "lead@example.com", firstname: "Ada" };

    async function seedHubspot() {
      const s = await seed("agentdash_mk");
      const connection = await connectorService(db).create(s.company.id, {
        ownerType: "user",
        ownerId: s.stewardUserId,
        provider: "hubspot",
        scopes: ["crm.objects.contacts.write"],
        visibility: "private",
        accountLabel: "12345",
        token: { accessToken: "pat-write" },
      });
      await setAccessPolicy(db, s.company.id, s.agent.id, {
        request: {
          do: { connections: [{ connectionId: connection.id, draft: "approve", send: "approve" }] },
          talk: { external: [{ connectionId: connection.id, targets: { mode: "domains", values: ["partner.example"] } }] },
        },
      });
      return { ...s, connection };
    }

    function requestWrite(s: Awaited<ReturnType<typeof seedHubspot>>, properties: Record<string, unknown>) {
      return hubspotConnectorService(db).requestWrite({
        companyId: s.company.id,
        agentId: s.agent.id,
        objectType: "contacts",
        operation: "create",
        properties,
      });
    }

    it("enforce: a write naming an unlisted external target is 403 and files no approval; a listed domain is filed for a person", async () => {
      const s = await seedHubspot();
      await setAccessMode(db, s.company.id, "enforce");
      const error = await caught(requestWrite(s, PROPERTIES));
      expectRefusal(error, {
        dimension: "talk.external",
        rule: "talk.external.domain_not_listed",
        requested: { connectionId: s.connection.id, externalTarget: "lead@example.com" },
      });
      expect(await db.select().from(approvals).where(eq(approvals.companyId, s.company.id))).toHaveLength(0);
      expectEnforcedLog((await refusedRows(s.company.id, "connector_send.create"))[0]!, { dimension: "talk.external", site: "connector_send.create" });

      // V2 `approve` never auto-executes: the allowed write is filed as an approval, nothing is sent.
      const filed = await requestWrite(s, { email: "ada@partner.example" });
      expect(filed.ok).toBe(true);
      expect(crmWrites).toBe(0);
    });

    it("enforce at execution: an approved send that V2 now refuses is refused and recorded, and nothing is sent", async () => {
      const s = await seedHubspot();
      await setAccessMode(db, s.company.id, "shadow");
      const filed = await requestWrite(s, PROPERTIES);
      expect(filed.ok).toBe(true);
      if (!filed.ok) throw new Error("not filed");
      await db.update(approvals).set({ status: "approved", decidedByUserId: s.stewardUserId, decidedAt: new Date() }).where(eq(approvals.id, filed.approvalId));
      await setAccessMode(db, s.company.id, "enforce");
      const report = await connectorSendExecutionService(db).executeForApproval(filed.approvalId);
      // The executor's refusal shape: recorded as a failed execution with `refused: true`, the steward told.
      expect(report).toMatchObject({ outcome: "failed", refused: true, reason: "access_policy_refused" });
      expect(crmWrites).toBe(0);
      const execution = await db.select().from(connectorSendExecutions).where(eq(connectorSendExecutions.approvalId, filed.approvalId)).then((rows) => rows[0] ?? null);
      expect(execution).toMatchObject({ outcome: "failed", reason: "access_policy_refused" });
      expect(await activityRows(db, s.company.id, "connector_send.refused")).toHaveLength(1);
      expectEnforcedLog((await refusedRows(s.company.id, "connector_send.execute"))[0]!, { dimension: "talk.external", site: "connector_send.execute" });
    });

    it("off and shadow: the unlisted write is filed and executed exactly as gate 2", async () => {
      for (const mode of ["off", "shadow"] as const) {
        const s = await seedHubspot();
        await setAccessMode(db, s.company.id, mode);
        const filed = await requestWrite(s, PROPERTIES);
        expect(filed.ok, mode).toBe(true);
        if (!filed.ok) throw new Error("not filed");
        await db.update(approvals).set({ status: "approved", decidedByUserId: s.stewardUserId, decidedAt: new Date() }).where(eq(approvals.id, filed.approvalId));
        const report = await connectorSendExecutionService(db).executeForApproval(filed.approvalId);
        expect(report?.outcome, mode).toBe("succeeded");
        expect(await refusedRows(s.company.id)).toHaveLength(0);
      }
      expect(crmWrites).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // questions (talk.people): 403 naming the allowed people; escalation always open
  // -------------------------------------------------------------------------

  describe("questions", () => {
    const questionInput = () => ({
      kind: "ask_user_questions" as const,
      continuationPolicy: "wake_assignee" as const,
      payload: { version: 1 as const, questions: [{ id: "offer", prompt: "What is the offer?", selectionMode: "text" as const, required: true, companyFactKey: "offer", options: [] }] },
    });

    it("enforce: an agent's workforce question still reaches its accountable member (escalation path), with people listed as nobody", async () => {
      const company = await db
        .insert(companies)
        .values({ name: `Questions ${randomUUID()}`, issuePrefix: `QE${randomUUID().slice(0, 6).toUpperCase()}` })
        .returning()
        .then((rows) => rows[0]!);
      const ownerUserId = `owner-${randomUUID()}`;
      await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" });
      const agent = await db
        .insert(agents)
        .values({ companyId: company.id, name: "Worker", adapterType: "codex_local", autonomy: "autonomous", accountableUserId: ownerUserId })
        .returning()
        .then((rows) => rows[0]!);
      const workforce = workforceService(db);
      await workforce.enroll(company.id, agent.id, { templateId: "marketing-content" }, { userId: ownerUserId });
      const issue = await workforce.startFirstJob(company.id, agent.id, { userId: ownerUserId });
      await setAccessPolicy(db, company.id, agent.id, { request: { talk: { people: { mode: "listed", userIds: [] } } } });
      await setAccessMode(db, company.id, "enforce");
      const question = await issueThreadInteractionService(db).create(issue, questionInput(), { agentId: agent.id });
      expect(question.payload).toMatchObject({ answerOwnerUserId: ownerUserId });
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, question.id))).toHaveLength(1);
      expect(await refusedRows(company.id)).toHaveLength(0);
    });

    it("enforce: the questions row refuses a named owner outside talk.people with the 403 body; admins, the steward and the accountable person are always allowed", async () => {
      const s = await seed("agentdash_mk");
      const accountableUserId = await member(s.company.id, "member");
      await db.update(agents).set({ accountableUserId }).where(eq(agents.id, s.agent.id));
      await setAccessPolicy(db, s.company.id, s.agent.id, { request: { talk: { people: { mode: "listed", userIds: [] } } } });
      await setAccessMode(db, s.company.id, "enforce");
      const check = (userId: string) =>
        enforceAgentAccess(db, { companyId: s.company.id, agentId: s.agent.id, dimension: "talk.people", target: { userId, purpose: "question" } }, { site: "questions" });
      expectRefusal(await caught(check(s.outsiderUserId)), {
        dimension: "talk.people",
        rule: "talk.people.not_listed",
        requested: { userId: s.outsiderUserId, purpose: "question" },
      });
      for (const userId of [s.ownerUserId, s.stewardUserId, accountableUserId]) {
        expect((await check(userId)).outcome).toBe("allow");
      }
      expect(await refusedRows(s.company.id, "questions")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // bridge.task (talk.people, fixed bridge-owner rule): 403
  // -------------------------------------------------------------------------

  describe("bridge.task", () => {
    async function endpointFor(companyId: string, userId: string, approvedByUserId: string) {
      return db
        .insert(bridgeEndpoints)
        .values({
          companyId,
          userId,
          label: `laptop-${randomUUID().slice(0, 6)}`,
          tokenHash: `hash-${randomUUID()}`,
          capabilities: ["bridge:read", "bridge:act"],
          enrolledAt: new Date(),
          approvedByUserId,
        })
        .returning()
        .then((rows) => rows[0]!);
    }

    function createTask(s: Awaited<ReturnType<typeof seed>>, endpointId: string) {
      return bridgeService(db).createTask(s.company.id, {
        endpointId,
        requestedByAgentId: s.agent.id,
        taskClass: "read",
        instruction: "summarize the repo README",
      });
    }

    it("enforce: a task to a machine that is neither the steward's nor the accountable person's is 403 and not created; the steward's own machine works", async () => {
      const s = await seed("agentdash_mk");
      await setAccessMode(db, s.company.id, "enforce");
      const outsiderEndpoint = await endpointFor(s.company.id, s.outsiderUserId, s.ownerUserId);
      expectRefusal(await caught(createTask(s, outsiderEndpoint.id)), {
        dimension: "talk.people",
        rule: "talk.people.bridge_owner_only",
        requested: { userId: s.outsiderUserId, purpose: "bridge_task" },
      });
      expect(await db.select().from(bridgeTasks).where(eq(bridgeTasks.endpointId, outsiderEndpoint.id))).toHaveLength(0);
      expectEnforcedLog((await refusedRows(s.company.id, "bridge.task"))[0]!, { dimension: "talk.people", site: "bridge.task" });

      const stewardEndpoint = await endpointFor(s.company.id, s.stewardUserId, s.ownerUserId);
      const created = await createTask(s, stewardEndpoint.id);
      expect(created.id).toBeTruthy();
    });

    it("off and shadow: the outsider task is created exactly as gate 2", async () => {
      for (const mode of ["off", "shadow"] as const) {
        const s = await seed("agentdash_mk");
        await setAccessMode(db, s.company.id, mode);
        const endpoint = await endpointFor(s.company.id, s.outsiderUserId, s.ownerUserId);
        expect((await createTask(s, endpoint.id)).id, mode).toBeTruthy();
        expect(await refusedRows(s.company.id)).toHaveLength(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // export.agent_actor (see.projects): omitted and listed as withheld
  // -------------------------------------------------------------------------

  describe("export.agent_actor", () => {
    async function seedProjects() {
      const s = await seed();
      const inScope = await db.insert(projects).values({ companyId: s.company.id, name: "In scope" }).returning().then((rows) => rows[0]!);
      const outOfScope = await db.insert(projects).values({ companyId: s.company.id, name: "Out of scope" }).returning().then((rows) => rows[0]!);
      await db.insert(issues).values([
        { companyId: s.company.id, projectId: inScope.id, title: "Visible task", status: "todo" },
        { companyId: s.company.id, projectId: outOfScope.id, title: "Withheld task", status: "todo" },
      ]);
      await setAccessPolicy(db, s.company.id, s.agent.id, { request: { see: { projects: { mode: "listed", ids: [inScope.id] } } } });
      return { ...s, inScope, outOfScope };
    }

    const INPUT = { include: { company: true, agents: false, projects: true, issues: true, skills: false } } as never;

    it("enforce: an agent's export and preview omit the out-of-scope project and its tasks, and list it as withheld; a board export is whole", async () => {
      const s = await seedProjects();
      await setAccessMode(db, s.company.id, "enforce");
      const portability = companyPortabilityService(db);
      const exported = await portability.exportBundle(s.company.id, INPUT, { accessActorAgentId: s.agent.id });
      const files = JSON.stringify(exported.files);
      expect(files).toContain("Visible task");
      expect(files).not.toContain("Withheld task");
      expect(files).not.toContain("Out of scope");
      const withheld = exported.warnings.filter((line) => line.startsWith(EXPORT_WITHHELD_PROJECT_WARNING_PREFIX));
      expect(withheld).toHaveLength(1);
      expect(withheld[0]).toContain("Out of scope");
      expect(withheld[0]).toContain("ACCESS_POLICY_REFUSED");

      const preview = await portability.previewExport(s.company.id, INPUT, { accessActorAgentId: s.agent.id });
      expect(JSON.stringify(preview.files)).not.toContain("Withheld task");
      expect(preview.warnings.some((line) => line.startsWith(EXPORT_WITHHELD_PROJECT_WARNING_PREFIX))).toBe(true);

      const board = await portability.exportBundle(s.company.id, INPUT);
      expect(JSON.stringify(board.files)).toContain("Withheld task");
      expect(board.warnings.some((line) => line.startsWith(EXPORT_WITHHELD_PROJECT_WARNING_PREFIX))).toBe(false);

      const rows = await refusedRows(s.company.id, "export.agent_actor");
      expect(rows).toHaveLength(2); // export, then preview
      for (const row of rows) expectEnforcedLog(row, { dimension: "see.projects", site: "export.agent_actor" });
    });

    it("off and shadow: the agent's export carries the project exactly as gate 2", async () => {
      for (const mode of ["off", "shadow"] as const) {
        const s = await seedProjects();
        await setAccessMode(db, s.company.id, mode);
        const exported = await companyPortabilityService(db).exportBundle(s.company.id, INPUT, { accessActorAgentId: s.agent.id });
        expect(JSON.stringify(exported.files), mode).toContain("Withheld task");
        expect(exported.warnings.some((line) => line.startsWith(EXPORT_WITHHELD_PROJECT_WARNING_PREFIX))).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // import.skills + import.assign: 403 up front, nothing written
  // -------------------------------------------------------------------------

  describe("import.assign and import.skills", () => {
    async function seedImport(collisionStrategy: "rename" | "skip", policy: Record<string, unknown>) {
      const s = await seed();
      const ceo = await db
        .insert(agents)
        .values({ companyId: s.company.id, name: "Chief", role: "ceo", status: "idle", adapterType: "codex_local", adapterConfig: {} })
        .returning()
        .then((rows) => rows[0]!);
      const writer = await db
        .insert(agents)
        .values({
          companyId: s.company.id,
          name: "Writer",
          role: "engineer",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: { paperclipSkillSync: { desiredSkills: ["writer-skill"] } },
        })
        .returning()
        .then((rows) => rows[0]!);
      await db.insert(issues).values({ companyId: s.company.id, title: "Draft the launch post", status: "todo", assigneeAgentId: writer.id });
      await setAccessPolicy(db, s.company.id, ceo.id, { request: policy as never });
      const portability = companyPortabilityService(db);
      const exported = await portability.exportBundle(s.company.id, {
        include: { company: false, agents: true, projects: false, issues: true, skills: false },
        agents: [writer.id],
      } as never);
      await setAccessMode(db, s.company.id, "enforce");
      const counts = async () => ({
        agents: (await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, s.company.id))).length,
        issues: (await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, s.company.id))).length,
      });
      const before = await counts();
      const run = () =>
        portability.importBundle(
          {
            source: { type: "inline", rootPath: exported.rootPath, files: exported.files },
            include: { company: false, agents: true, projects: false, issues: true, skills: false },
            target: { mode: "existing_company", companyId: s.company.id },
            agents: "all",
            collisionStrategy,
          } as never,
          null,
          { mode: "agent_safe", sourceCompanyId: s.company.id, actorIsAgent: true, actorAgentId: ceo.id },
        );
      return { ...s, ceo, writer, run, counts, before };
    }

    it("enforce: an imported agent's skill outside the importer's scope is 403 before anything is written", async () => {
      const s = await seedImport("rename", { do: { skills: { mode: "listed", ids: [] } } });
      expectRefusal(await caught(s.run()), { dimension: "do.skills", rule: "do.skills.not_listed", requested: { skillKey: "writer-skill" } });
      expect(await s.counts()).toEqual(s.before);
      expectEnforcedLog((await refusedRows(s.company.id, "import.skills"))[0]!, { dimension: "do.skills", site: "import.skills" });
    });

    it("enforce: an assignment to an existing agent outside the importer's scope is 403 before anything is written", async () => {
      const s = await seedImport("skip", { talk: { agents: { mode: "listed", agentIds: [], via: ["assign"] } } });
      expectRefusal(await caught(s.run()), {
        dimension: "talk.agents",
        rule: "talk.agents.not_listed",
        requested: { agentId: s.writer.id, via: "assign" },
      });
      expect(await s.counts()).toEqual(s.before);
    });

    it("enforce: an assignment to an agent the import itself creates is withheld (imported unassigned, listed in warnings) — never a partial import", async () => {
      const s = await seedImport("rename", { talk: { agents: { mode: "listed", agentIds: [], via: ["assign"] } } });
      const result = await s.run();
      expect(result.warnings.some((line) => line.includes("imported unassigned") && line.includes("ACCESS_POLICY_REFUSED"))).toBe(true);
      const after = await s.counts();
      expect(after.agents).toBe(s.before.agents + 1);
      const imported = await db.select().from(issues).where(and(eq(issues.companyId, s.company.id), eq(issues.title, "Draft the launch post")));
      // The original (assigned to Writer) and the import, left unassigned.
      expect(imported.map((row) => row.assigneeAgentId === null).sort()).toEqual([false, true]);
    });
  });

  // -------------------------------------------------------------------------
  // MK regression: legacy V1 checks are unchanged in every mode
  // -------------------------------------------------------------------------

  describe("MK regression (V1 checks in off, shadow and enforce)", () => {
    async function seedMk() {
      const s = await seed("agentdash_mk");
      // No agent-owned telegram row: the steward's private connection is the fallback.
      await db.insert(connections).values({
        companyId: s.company.id,
        ownerType: "user",
        ownerId: s.stewardUserId,
        provider: "telegram",
        scopes: [],
        visibility: "private",
        status: "active",
        autonomy: { read: "full", draft: "full", send: "draft_only" },
      });
      await agentConnection(s.company.id, s.agent.id, "hubspot", []);
      // A V1-only policy (no V2 dimension): the MK ceiling, credential fallback and bridge approval selection run on it.
      const ceiling = {
        ...DEFAULT_AGENT_GOVERNANCE_POLICY,
        providers: ["telegram"],
        permissions: [AGENT_POLICY_WILDCARD],
        dataScopes: [AGENT_POLICY_WILDCARD],
        monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
        minimumApproval: "act" as const,
      };
      await db.insert(agentGovernancePolicies).values({
        companyId: s.company.id,
        agentId: s.agent.id,
        ownerCeiling: ceiling,
        stewardRequest: ceiling,
        effectivePolicy: ceiling,
      });
      return s;
    }

    async function observe(s: Awaited<ReturnType<typeof seedMk>>) {
      const svc = connectorService(db);
      const endpoint = await db
        .insert(bridgeEndpoints)
        .values({
          companyId: s.company.id,
          userId: s.stewardUserId,
          label: `laptop-${randomUUID().slice(0, 6)}`,
          tokenHash: `hash-${randomUUID()}`,
          capabilities: ["bridge:read", "bridge:act"],
          enrolledAt: new Date(),
          approvedByUserId: s.ownerUserId,
        })
        .returning()
        .then((rows) => rows[0]!);
      const task = await bridgeService(db).createTask(s.company.id, {
        endpointId: endpoint.id,
        requestedByAgentId: s.agent.id,
        taskClass: "act",
        instruction: "open the release checklist",
      });
      const stored = await db.select().from(bridgeTasks).where(eq(bridgeTasks.id, task.id)).then((rows) => rows[0]!);
      const strip = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(s.stewardUserId, "STEWARD").replaceAll(s.company.id, "CO"));
      return {
        hubspotRead: strip(await svc.resolveActingAs(s.company.id, s.agent.id, "read", "hubspot")),
        telegramRead: strip(await svc.resolveActingAs(s.company.id, s.agent.id, "read", "telegram")),
        telegramSend: strip(await svc.resolveActingAs(s.company.id, s.agent.id, "send", "telegram")),
        bridgeTask: { status: stored.status, gated: stored.approvalId !== null },
      };
    }

    function withoutIds(value: Record<string, unknown>) {
      return JSON.parse(JSON.stringify(value, (key, v) => (key === "connectionId" || key === "ownerId" ? "ID" : v)));
    }

    it("returns identical results in off, shadow and enforce: provider_not_allowed under a ceiling, the steward credential fallback and bridge approval selection", async () => {
      const results: Record<Mode, Record<string, unknown>> = {} as never;
      for (const mode of ["off", "shadow", "enforce"] as const) {
        const s = await seedMk();
        await setAccessMode(db, s.company.id, mode);
        results[mode] = withoutIds(await observe(s));
        expect(await refusedRows(s.company.id), mode).toHaveLength(0);
        expect(await wouldRefuseRows(db, s.company.id), mode).toHaveLength(0);
      }
      expect(results.off.hubspotRead).toMatchObject({ ok: false, blocked: { reason: "provider_not_allowed" } });
      expect(results.off.telegramRead).toMatchObject({ ok: true, resolution: { ownerType: "user" } });
      expect(results.shadow).toEqual(results.off);
      expect(results.enforce).toEqual(results.off);
    });

    it("enforce adds a V2 narrowing on top of an MK ceiling without changing the ceiling's own answer", async () => {
      const s = await seedMk();
      await db
        .update(agentGovernancePolicies)
        .set({
          stewardRequest: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, providers: ["telegram"], permissions: [AGENT_POLICY_WILDCARD], dataScopes: [AGENT_POLICY_WILDCARD], monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS, policyVersion: 2, see: { connections: [] } } as never,
        })
        .where(eq(agentGovernancePolicies.agentId, s.agent.id));
      await setAccessMode(db, s.company.id, "enforce");
      const svc = connectorService(db);
      // The ceiling still refuses its provider as provider_not_allowed (V1 first, unchanged).
      expect(await svc.resolveActingAs(s.company.id, s.agent.id, "read", "hubspot")).toMatchObject({ ok: false, blocked: { reason: "provider_not_allowed" } });
      // The fallback connection the ceiling allows is now narrowed by V2.
      expect(await svc.resolveActingAs(s.company.id, s.agent.id, "read", "telegram")).toMatchObject({ ok: false, blocked: { reason: "access_policy_refused" } });
      const governance = await db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, s.agent.id));
      expect(governance[0]!.effectivePolicy).toMatchObject({ providers: ["telegram"] });
    });
  });
});
