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
  AGENT_ACCESS_POLICY_VERSION,
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { activityRows, setAccessMode, setAccessPolicy, wouldRefuseRows } from "./helpers/agent-access-fixtures.js";
import { checkAgentAccess } from "../services/agent-access-check.js";
import { recordAgentHandoff } from "../services/agent-handoffs.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { bridgeService } from "../services/bridge.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { connectorSendExecutionService } from "../services/connector-send-execution.js";
import { connectorService } from "../services/connectors.js";
import { __resetHubspotLimiterState, hubspotConnectorService } from "../services/hubspot-connector.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { workforceService } from "../services/workforce.js";

/**
 * AgentDash: APM gate 2 (P2.3) — the service-level access LLD §4 matrix rows
 * in shadow mode. For each: in `shadow` a would-be refusal is recorded as
 * `access.would_refuse` with `{ dimension, rule, target, site }` and the call
 * behaves exactly as in `off`; in `off` nothing is recorded.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

describeEmbeddedPostgres("V2 access checks in shadow mode — service rows (APM gate 2, P2.3)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY"]) savedEnv[key] = process.env[key];
    home = await mkdtemp(join(tmpdir(), "agent-access-shadow-services-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "agent-access-shadow-services";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "e".repeat(64);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-shadow-svc-");
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

  // -------------------------------------------------------------------------
  // Seeds — every test gets its own company, so rows never cross tests.
  // -------------------------------------------------------------------------

  async function member(companyId: string, membershipRole: string) {
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole });
    return userId;
  }

  async function seed(profile: "default" | "agentdash_mk" = "default") {
    const company = await db
      .insert(companies)
      .values({ name: `Shadow ${randomUUID()}`, issuePrefix: `SH${randomUUID().slice(0, 6).toUpperCase()}`, productProfile: profile })
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

  // -------------------------------------------------------------------------
  // 1. connectors.resolve_acting_as (see.connections)
  // -------------------------------------------------------------------------

  describe("connectors.resolve_acting_as", () => {
    it("shadow records a would-be refusal for a connection outside see.connections and resolves exactly as off", async () => {
      const s = await seed();
      const conn = await agentConnection(s.company.id, s.agent.id);
      await setAccessPolicy(db, s.company.id, s.agent.id, { request: { see: { connections: [] } } });
      const svc = connectorService(db);

      const off = await svc.resolveActingAs(s.company.id, s.agent.id, "read", "telegram");
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);

      await setAccessMode(db, s.company.id, "shadow");
      const shadow = await svc.resolveActingAs(s.company.id, s.agent.id, "read", "telegram");
      expect(shadow).toEqual(off);
      expect(shadow.ok).toBe(true);

      const rows = await wouldRefuseRows(db, s.company.id, "connectors.resolve_acting_as");
      expect(rows).toHaveLength(1);
      expect(detailsOf(rows[0]!)).toMatchObject({
        dimension: "see.connections",
        rule: "see.connections:not_listed",
        target: { connectionId: conn.id, dataScope: null },
        site: "connectors.resolve_acting_as",
        policyMode: "shadow",
      });
      expect(rows[0]!.agentId).toBe(s.agent.id);
    });

    it("records a data scope the listed connection does not allow", async () => {
      const s = await seed();
      const conn = await agentConnection(s.company.id, s.agent.id, "telegram", ["read:messages", "write:messages"]);
      await setAccessPolicy(db, s.company.id, s.agent.id, { request: { see: { connections: [{ connectionId: conn.id, dataScopes: ["read:messages"] }] } } });
      await setAccessMode(db, s.company.id, "shadow");
      const result = await connectorService(db).resolveActingAs(s.company.id, s.agent.id, "read", "telegram");
      expect(result.ok).toBe(true);
      const rows = await wouldRefuseRows(db, s.company.id, "connectors.resolve_acting_as");
      expect(rows).toHaveLength(1);
      expect(detailsOf(rows[0]!)).toMatchObject({
        rule: "see.connections:data_scope_not_listed",
        target: { connectionId: conn.id, dataScope: "write:messages" },
      });
    });

    it("writes nothing with accessCheck: false, even in shadow (the read-only inventory preview)", async () => {
      const s = await seed();
      const conn = await agentConnection(s.company.id, s.agent.id);
      await setAccessPolicy(db, s.company.id, s.agent.id, { request: { see: { connections: [] } } });
      await setAccessMode(db, s.company.id, "shadow");
      const result = await connectorService(db).resolveActingAs(s.company.id, s.agent.id, "read", "telegram", { connectionId: conn.id, accessCheck: false });
      expect(result.ok).toBe(true);
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });

    it("writes nothing in off even though V2 would refuse", async () => {
      const s = await seed();
      await agentConnection(s.company.id, s.agent.id);
      await setAccessPolicy(db, s.company.id, s.agent.id, { request: { see: { connections: [] } } });
      await connectorService(db).resolveActingAs(s.company.id, s.agent.id, "read", "telegram");
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2 + 3. connector_send creation and execution (do.connections, talk.external)
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
        const body = isWrite ? { id: "crm-1" } : {};
        return { ok: true, status: 200, json: async () => body } as never;
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
      return { ...s, connection };
    }

    async function fileAndExecute(s: Awaited<ReturnType<typeof seedHubspot>>) {
      const filed = await hubspotConnectorService(db).requestWrite({
        companyId: s.company.id,
        agentId: s.agent.id,
        objectType: "contacts",
        operation: "create",
        properties: PROPERTIES,
      });
      expect(filed.ok).toBe(true);
      if (!filed.ok) throw new Error("not filed");
      const approval = await db.select().from(approvals).where(eq(approvals.id, filed.approvalId)).then((rows) => rows[0]!);
      await db.update(approvals).set({ status: "approved", decidedByUserId: s.stewardUserId, decidedAt: new Date() }).where(eq(approvals.id, approval.id));
      const report = await connectorSendExecutionService(db).executeForApproval(approval.id);
      const execution = await db
        .select()
        .from(connectorSendExecutions)
        .where(eq(connectorSendExecutions.approvalId, approval.id))
        .then((rows) => rows[0] ?? null);
      return { filed, approval, report, execution };
    }

    function comparable(run: Awaited<ReturnType<typeof fileAndExecute>>) {
      const { payloadDigest: _digest, connectionId: _connectionId, ...payload } = run.approval.payload as Record<string, unknown>;
      return {
        approval: { type: run.approval.type, status: run.approval.status, payload },
        report: run.report,
        execution: run.execution ? { outcome: run.execution.outcome, reason: run.execution.reason, externalId: run.execution.externalId } : null,
      };
    }

    it("shadow logs do.connections and talk.external at creation and execution; the approval is filed and the send runs exactly as off", async () => {
      const offCo = await seedHubspot();
      await setAccessPolicy(db, offCo.company.id, offCo.agent.id, {
        request: {
          do: { connections: [{ connectionId: offCo.connection.id, draft: "never", send: "never" }] },
          talk: { external: [{ connectionId: offCo.connection.id, targets: { mode: "listed", values: [] } }] },
        },
      });
      const off = await fileAndExecute(offCo);
      expect(await wouldRefuseRows(db, offCo.company.id)).toHaveLength(0);

      const shadowCo = await seedHubspot();
      await setAccessPolicy(db, shadowCo.company.id, shadowCo.agent.id, {
        request: {
          do: { connections: [{ connectionId: shadowCo.connection.id, draft: "never", send: "never" }] },
          talk: { external: [{ connectionId: shadowCo.connection.id, targets: { mode: "listed", values: [] } }] },
        },
      });
      await setAccessMode(db, shadowCo.company.id, "shadow");
      const shadow = await fileAndExecute(shadowCo);

      expect(comparable(shadow)).toEqual(comparable(off));
      expect(shadow.report?.outcome).toBe("succeeded");
      expect(crmWrites).toBe(2); // one write per company: shadow never stopped the send

      for (const site of ["connector_send.create", "connector_send.execute"] as const) {
        const rows = await wouldRefuseRows(db, shadowCo.company.id, site);
        expect(rows.map((row) => detailsOf(row).dimension).sort(), site).toEqual(["do.connections", "talk.external"]);
        const byDimension = Object.fromEntries(rows.map((row) => [detailsOf(row).dimension, detailsOf(row)]));
        expect(byDimension["do.connections"]).toMatchObject({
          rule: "do.connections:send_never",
          target: { connectionId: shadowCo.connection.id, actionClass: "send", onApprovalPath: true },
          site,
        });
        expect(byDimension["talk.external"]).toMatchObject({
          rule: "talk.external:target_not_listed",
          target: { connectionId: shadowCo.connection.id, externalTarget: "lead@example.com" },
          site,
        });
      }
    });

    it("an approve-mode send adds no refusal on the approval path (rule 1 already files the approval)", async () => {
      const s = await seedHubspot();
      await setAccessPolicy(db, s.company.id, s.agent.id, {
        request: { do: { connections: [{ connectionId: s.connection.id, draft: "approve", send: "approve" }] } },
      });
      await setAccessMode(db, s.company.id, "shadow");
      const run = await fileAndExecute(s);
      expect(run.report?.outcome).toBe("succeeded");
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. handoffs (talk.agents via handoff)
  // -------------------------------------------------------------------------

  describe("handoffs", () => {
    async function handOff(s: Awaited<ReturnType<typeof seed>>) {
      const issue = await db
        .insert(issues)
        .values({ companyId: s.company.id, title: "Hand me", status: "todo", assigneeAgentId: s.peer.id })
        .returning()
        .then((rows) => rows[0]!);
      const round = await recordAgentHandoff(db, {
        companyId: s.company.id,
        issueId: issue.id,
        parentIssueId: null,
        rootIssueId: issue.id,
        fromAgentId: s.agent.id,
        toAgentId: s.peer.id,
        runId: null,
        via: "reassign",
      });
      const recorded = await activityRows(db, s.company.id, "issue.agent_handoff");
      return { issue, round, recorded };
    }

    it("shadow logs a hand-off outside talk.agents and records the hand-off with the same round as off", async () => {
      const offCo = await seed();
      await setAccessPolicy(db, offCo.company.id, offCo.agent.id, { request: { talk: { agents: { mode: "listed", agentIds: [], via: ["handoff"] } } } });
      const off = await handOff(offCo);
      expect(await wouldRefuseRows(db, offCo.company.id)).toHaveLength(0);

      const shadowCo = await seed();
      await setAccessPolicy(db, shadowCo.company.id, shadowCo.agent.id, { request: { talk: { agents: { mode: "listed", agentIds: [], via: ["handoff"] } } } });
      await setAccessMode(db, shadowCo.company.id, "shadow");
      const shadow = await handOff(shadowCo);

      expect(shadow.round).toBe(off.round);
      expect(shadow.recorded).toHaveLength(1);
      expect(off.recorded).toHaveLength(1);
      expect(detailsOf(shadow.recorded[0]!)).toMatchObject({ round: off.round, via: "reassign", fromAgentId: shadowCo.agent.id, toAgentId: shadowCo.peer.id });

      const rows = await wouldRefuseRows(db, shadowCo.company.id, "handoffs");
      expect(rows).toHaveLength(1);
      expect(detailsOf(rows[0]!)).toMatchObject({
        dimension: "talk.agents",
        rule: "talk.agents:not_listed",
        target: { agentId: shadowCo.peer.id },
        via: "handoff",
        site: "handoffs",
        issueId: shadow.issue.id,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 5. questions (talk.people, purpose question)
  // -------------------------------------------------------------------------

  describe("questions", () => {
    const questionInput = () => ({
      kind: "ask_user_questions" as const,
      continuationPolicy: "wake_assignee" as const,
      payload: { version: 1 as const, questions: [{ id: "offer", prompt: "What is the offer?", selectionMode: "text" as const, required: true, companyFactKey: "offer", options: [] }] },
    });

    async function workforceQuestion(mode: "off" | "shadow") {
      const company = await db
        .insert(companies)
        .values({ name: `Questions ${randomUUID()}`, issuePrefix: `QS${randomUUID().slice(0, 6).toUpperCase()}` })
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
      await setAccessMode(db, company.id, mode);
      const question = await issueThreadInteractionService(db).create(issue, questionInput(), { agentId: agent.id });
      return { company, agent, ownerUserId, question };
    }

    it("an agent's workforce question goes to its accountable member: always reachable, so shadow records nothing and creates it as off", async () => {
      const off = await workforceQuestion("off");
      const shadow = await workforceQuestion("shadow");
      expect(shadow.question.payload).toMatchObject({ answerOwnerUserId: shadow.ownerUserId });
      expect(off.question.payload).toMatchObject({ answerOwnerUserId: off.ownerUserId });
      expect({ ...shadow.question.payload, answerOwnerUserId: null, workforceAgentId: null, workforceEnrollmentId: null }).toEqual({
        ...off.question.payload,
        answerOwnerUserId: null,
        workforceAgentId: null,
        workforceEnrollmentId: null,
      });
      expect(shadow.question.status).toBe(off.question.status);
      const stored = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, shadow.question.id));
      expect(stored).toHaveLength(1);
      expect(await wouldRefuseRows(db, shadow.company.id)).toHaveLength(0);
      expect(await wouldRefuseRows(db, off.company.id)).toHaveLength(0);
    });

    it("the questions check records a named owner outside talk.people (direct check: no agent path can pin a non-escalation owner)", async () => {
      const s = await seed();
      await setAccessPolicy(db, s.company.id, s.agent.id, { request: { talk: { people: { mode: "listed", userIds: [] } } } });
      const check = { companyId: s.company.id, agentId: s.agent.id, dimension: "talk.people" as const, target: { userId: s.outsiderUserId, purpose: "question" as const } };

      expect(await checkAgentAccess(db, check, { site: "questions" })).toBe("allow");
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);

      await setAccessMode(db, s.company.id, "shadow");
      expect(await checkAgentAccess(db, check, { site: "questions" })).toBe("would_refuse");
      const rows = await wouldRefuseRows(db, s.company.id, "questions");
      expect(rows).toHaveLength(1);
      expect(detailsOf(rows[0]!)).toMatchObject({
        dimension: "talk.people",
        rule: "talk.people:not_listed",
        target: { userId: s.outsiderUserId, purpose: "question" },
        site: "questions",
      });
      // The escalation path stays open: a company admin is never refused.
      expect(await checkAgentAccess(db, { ...check, target: { userId: s.ownerUserId, purpose: "question" } }, { site: "questions" })).toBe("allow");
    });
  });

  // -------------------------------------------------------------------------
  // 6. bridge.task (talk.people, fixed bridge-owner rule)
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

    async function task(s: Awaited<ReturnType<typeof seed>>, endpointUserId: string) {
      const endpoint = await endpointFor(s.company.id, endpointUserId, s.ownerUserId);
      const created = await bridgeService(db).createTask(s.company.id, {
        endpointId: endpoint.id,
        requestedByAgentId: s.agent.id,
        taskClass: "read",
        instruction: "summarize the repo README",
      });
      const stored = await db.select().from(bridgeTasks).where(eq(bridgeTasks.id, created.id)).then((rows) => rows[0]!);
      return { endpoint, created, stored };
    }

    it("shadow records a task to a machine that is neither the steward's nor the accountable person's — with no stored policy — and creates it as off", async () => {
      const offCo = await seed("agentdash_mk");
      const off = await task(offCo, offCo.outsiderUserId);
      expect(await wouldRefuseRows(db, offCo.company.id)).toHaveLength(0);

      const shadowCo = await seed("agentdash_mk");
      await setAccessMode(db, shadowCo.company.id, "shadow");
      const policyRows = await db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, shadowCo.agent.id));
      expect(policyRows).toHaveLength(0);
      const shadow = await task(shadowCo, shadowCo.outsiderUserId);

      expect({ status: shadow.stored.status, taskClass: shadow.stored.taskClass, approval: shadow.stored.approvalId === null, instruction: shadow.stored.instruction }).toEqual({
        status: off.stored.status,
        taskClass: off.stored.taskClass,
        approval: off.stored.approvalId === null,
        instruction: off.stored.instruction,
      });
      const rows = await wouldRefuseRows(db, shadowCo.company.id, "bridge.task");
      expect(rows).toHaveLength(1);
      expect(detailsOf(rows[0]!)).toMatchObject({
        dimension: "talk.people",
        rule: "talk.people:bridge_owner_only",
        side: "fixed",
        target: { userId: shadowCo.outsiderUserId, purpose: "bridge_task" },
        site: "bridge.task",
      });
    });

    it("a task to the steward's own machine records nothing", async () => {
      const s = await seed("agentdash_mk");
      await setAccessMode(db, s.company.id, "shadow");
      const created = await task(s, s.stewardUserId);
      expect(created.stored.status).toBeTruthy();
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. export.agent_actor (see.projects)
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

    function stable(value: { files: unknown; manifest: unknown }) {
      const { generatedAt: _generatedAt, ...manifest } = value.manifest as Record<string, unknown>;
      return { files: value.files, manifest };
    }

    it("shadow records each exported project outside the exporter's scope; the bundle and the preview are identical to off and to a board export", async () => {
      const s = await seedProjects();
      const portability = companyPortabilityService(db);

      const board = await portability.exportBundle(s.company.id, INPUT);
      const offAgent = await portability.exportBundle(s.company.id, INPUT, { accessActorAgentId: s.agent.id });
      const offPreview = await portability.previewExport(s.company.id, INPUT, { accessActorAgentId: s.agent.id });
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);

      await setAccessMode(db, s.company.id, "shadow");
      const shadowAgent = await portability.exportBundle(s.company.id, INPUT, { accessActorAgentId: s.agent.id });
      const shadowPreview = await portability.previewExport(s.company.id, INPUT, { accessActorAgentId: s.agent.id });

      expect(stable(shadowAgent)).toEqual(stable(offAgent));
      expect(stable(shadowAgent)).toEqual(stable(board));
      expect(stable(shadowPreview)).toEqual(stable(offPreview));
      expect(shadowPreview.counts).toEqual(offPreview.counts);
      expect(JSON.stringify(shadowAgent.files)).toContain("Withheld task");

      const rows = await wouldRefuseRows(db, s.company.id, "export.agent_actor");
      // One per call (export, then preview), each for the out-of-scope project only.
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(detailsOf(row)).toMatchObject({
          dimension: "see.projects",
          rule: "see.projects:not_listed",
          target: { projectId: s.outOfScope.id },
          site: "export.agent_actor",
        });
      }
    });

    it("a board export (no agent actor) records nothing in shadow", async () => {
      const s = await seedProjects();
      await setAccessMode(db, s.company.id, "shadow");
      await companyPortabilityService(db).exportBundle(s.company.id, INPUT);
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 8. import.assign + import.skills (talk.agents assign, do.skills)
  // -------------------------------------------------------------------------

  describe("import.assign and import.skills", () => {
    async function seedImport(mode: "off" | "shadow") {
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
      await setAccessPolicy(db, s.company.id, ceo.id, {
        request: { talk: { agents: { mode: "listed", agentIds: [], via: ["assign"] } }, do: { skills: { mode: "listed", ids: [] } } },
      });
      const portability = companyPortabilityService(db);
      const exported = await portability.exportBundle(s.company.id, {
        include: { company: false, agents: true, projects: false, issues: true, skills: false },
        agents: [writer.id],
      } as never);
      await setAccessMode(db, s.company.id, mode);
      const result = await portability.importBundle(
        {
          source: { type: "inline", rootPath: exported.rootPath, files: exported.files },
          include: { company: false, agents: true, projects: false, issues: true, skills: false },
          target: { mode: "existing_company", companyId: s.company.id },
          agents: "all",
          collisionStrategy: "rename",
        } as never,
        null,
        { mode: "agent_safe", sourceCompanyId: s.company.id, actorIsAgent: true, actorAgentId: ceo.id },
      );
      const imported = await db.select().from(agents).where(and(eq(agents.companyId, s.company.id)));
      const importedIssues = await db.select().from(issues).where(eq(issues.companyId, s.company.id));
      return { ...s, ceo, writer, exported, result, imported, importedIssues };
    }

    function shape(run: Awaited<ReturnType<typeof seedImport>>) {
      const newAgent = run.imported.find((row) => ![run.agent.id, run.peer.id, run.ceo.id, run.writer.id].includes(row.id));
      return {
        agents: run.result.agents.map((entry) => ({ action: entry.action, name: entry.name })),
        warnings: run.result.warnings,
        newAgentSkills: newAgent ? (newAgent.adapterConfig as Record<string, unknown>).paperclipSkillSync : null,
        issues: run.importedIssues.map((row) => ({ title: row.title, assigned: row.assigneeAgentId === newAgent?.id })).sort((a, b) => (a.title + a.assigned).localeCompare(b.title + b.assigned)),
      };
    }

    it("shadow records the importer's assignment and skill grant outside its scopes; the import is identical to off", async () => {
      const off = await seedImport("off");
      expect(await wouldRefuseRows(db, off.company.id)).toHaveLength(0);
      const shadow = await seedImport("shadow");

      expect(shape(shadow)).toEqual(shape(off));
      const newAgent = shadow.imported.find((row) => ![shadow.agent.id, shadow.peer.id, shadow.ceo.id, shadow.writer.id].includes(row.id));
      expect(newAgent).toBeTruthy();

      const assign = await wouldRefuseRows(db, shadow.company.id, "import.assign");
      expect(assign).toHaveLength(1);
      expect(detailsOf(assign[0]!)).toMatchObject({
        dimension: "talk.agents",
        rule: "talk.agents:not_listed",
        target: { agentId: newAgent!.id },
        via: "assign",
        site: "import.assign",
      });
      const skills = await wouldRefuseRows(db, shadow.company.id, "import.skills");
      expect(skills).toHaveLength(1);
      expect(detailsOf(skills[0]!)).toMatchObject({
        dimension: "do.skills",
        rule: "do.skills:not_listed",
        target: { skillKey: "writer-skill" },
        site: "import.skills",
      });
      for (const row of [...assign, ...skills]) expect(row.agentId).toBe(shadow.ceo.id);
    });
  });

  // -------------------------------------------------------------------------
  // 9. MK regression: resolveActingAs is unchanged by the mode
  // -------------------------------------------------------------------------

  describe("MK regression (resolveActingAs)", () => {
    async function writeSides(companyId: string, agentId: string, ceilingV1: Partial<typeof DEFAULT_AGENT_GOVERNANCE_POLICY>) {
      const ceiling = { ...DEFAULT_AGENT_GOVERNANCE_POLICY, ...ceilingV1 };
      await db.insert(agentGovernancePolicies).values({
        companyId,
        agentId,
        ownerCeiling: ceiling,
        stewardRequest: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, policyVersion: AGENT_ACCESS_POLICY_VERSION, see: { connections: [] } },
        effectivePolicy: ceiling,
      });
    }

    async function resolveAll(companyId: string, agentId: string) {
      const svc = connectorService(db);
      return {
        hubspotRead: await svc.resolveActingAs(companyId, agentId, "read", "hubspot"),
        telegramRead: await svc.resolveActingAs(companyId, agentId, "read", "telegram"),
        telegramSend: await svc.resolveActingAs(companyId, agentId, "send", "telegram"),
      };
    }

    it("returns identical results in off and shadow, including provider_not_allowed under a ceiling and the steward credential fallback", async () => {
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
      await writeSides(s.company.id, s.agent.id, {
        providers: ["telegram"],
        permissions: [AGENT_POLICY_WILDCARD],
        dataScopes: [AGENT_POLICY_WILDCARD],
        monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
      });

      const off = await resolveAll(s.company.id, s.agent.id);
      expect(off.hubspotRead).toMatchObject({ ok: false, blocked: { reason: "provider_not_allowed" } });
      expect(off.telegramRead).toMatchObject({ ok: true, resolution: { ownerType: "user", ownerId: s.stewardUserId } });
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);

      await setAccessMode(db, s.company.id, "shadow");
      const shadow = await resolveAll(s.company.id, s.agent.id);
      expect(shadow).toEqual(off);
      // Shadow logged the V2 request's empty connection list for the resolved (fallback) connection only;
      // the provider the ceiling refuses never reaches the V2 check.
      const rows = await wouldRefuseRows(db, s.company.id, "connectors.resolve_acting_as");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(detailsOf(row).rule).toBe("see.connections:not_listed");
      const governance = await db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, s.agent.id));
      expect(governance[0]!.effectivePolicy).toMatchObject({ providers: ["telegram"] });
    });
  });
});
