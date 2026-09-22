import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  authUsers,
  channelCallbackTokens,
  companies,
  companyMemberships,
  createDb,
  stewardWebhooks,
} from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { stewardWebhookRoutes } from "../routes/steward-webhooks.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { stewardInboxService } from "../services/steward-inbox.js";
import { webhookBodyFor,
  renderStewardWebhookMessage,
  stewardWebhooksService,
} from "../services/steward-webhooks.js";

/**
 * The webhook is the bot-less push channel, and these tests pin the three
 * promises that make it shippable:
 *
 *   1. Nothing leaves that the inbox itself would not render — the ask and a
 *      pointer, never the approval payload and never a decision handle.
 *   2. Delivery is at-least-once with a cursor: a failed POST retries the
 *      same window, a delivered one advances, a revoked webhook goes silent.
 *   3. Registration is the person's own act, verified by a challenge the
 *      destination must answer.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("webhookBodyFor", () => {
  const digestText = [
    "AgentDash inbox — Titus",
    "",
    "1 decision waiting:",
    "- connector_send from Casper",
    "Decide on your AgentDash page: https://example.test/MKT/approvals",
  ].join("\n");

  it("keeps plain {text} for ordinary webhook hosts", () => {
    const body = JSON.parse(webhookBodyFor("https://hooks.slack.example/services/x", digestText));
    expect(body).toEqual({ text: digestText });
  });

  it("wraps Power Automate hosts in an Adaptive Card with only an OpenUrl action", () => {
    const body = JSON.parse(
      webhookBodyFor("https://abc.4a.environment.api.powerplatform.com:443/flow/x", digestText),
    );
    expect(body.type).toBe("message");
    const card = body.attachments[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    const blocks = card.content.body.map((b: { text: string }) => b.text).join("\n");
    expect(blocks).toContain("AgentDash inbox — Titus");
    expect(blocks).toContain("connector_send from Casper");
    // raw URL becomes a tappable markdown link
    expect(blocks).toContain("[https://example.test/MKT/approvals](https://example.test/MKT/approvals)");
    // a pointer, never a decision: OpenUrl is the only permitted action kind
    expect(card.content.actions).toEqual([
      { type: "Action.OpenUrl", title: "Decide on AgentDash", url: "https://example.test/MKT/approvals" },
    ]);
  });

  it("recognizes older logic.azure.com flow hosts too", () => {
    const body = JSON.parse(webhookBodyFor("https://prod-1.westus.logic.azure.com/workflows/x", "hi"));
    expect(body.type).toBe("message");
  });
});

describe("renderStewardWebhookMessage", () => {
  const digest = (over: Record<string, unknown> = {}) => ({
    agentsAnsweredFor: 1,
    approvals: { total: 0, shown: 0, items: [] as never[] },
    blockers: { total: 0, shown: 0, items: [] as never[] },
    completions: { total: 0, shown: 0, items: [] as never[] },
    ...over,
  });

  it("names the owner and keeps the contract's order", () => {
    const text = renderStewardWebhookMessage({
      ownerName: "Titus",
      approvalsUrl: "https://mk.example/MKT/approvals",
      digest: digest({
        approvals: {
          total: 1,
          shown: 1,
          items: [{ type: "connector_send", agentName: "Casper", revision: 1, risk: { level: "medium", reason: "Governed action" }, waitingSince: "" }],
        },
        blockers: { total: 1, shown: 1, items: [{ identifier: "MKT-9", title: "Stuck thing", agentName: "Casper" }] },
        completions: { total: 1, shown: 1, items: [{ identifier: "MKT-8", title: "Done thing", agentName: "Casper" }] },
      }) as never,
    });
    expect(text.startsWith("AgentDash inbox — Titus")).toBe(true);
    const decide = text.indexOf("Waiting on your decision (1):");
    const blocked = text.indexOf("Stopped and needs you (1):");
    const finished = text.indexOf("Finished (1):");
    expect(decide).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(blocked);
    expect(blocked).toBeLessThan(finished);
    expect(text).toContain("Decide on your AgentDash page: https://mk.example/MKT/approvals");
    expect(text).toContain("never the evidence");
  });
});

describeEmbeddedPostgres("steward webhooks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-webhooks-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${companies} cascade`);
    await db.execute(sql`truncate table ${authUsers} cascade`);
  });

  /** A steward with an agent, a name, and one pending approval on the log. */
  async function seed() {
    const company = await db
      .insert(companies)
      .values({
        name: `Hooks ${randomUUID()}`,
        issuePrefix: `HK${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: "agentdash_mk",
      })
      .returning()
      .then((rows) => rows[0]!);
    const ownerMember = await db
      .insert(companyMemberships)
      .values({ companyId: company.id, principalType: "user", principalId: randomUUID(), status: "active", membershipRole: "owner" })
      .returning()
      .then((rows) => rows[0]!);
    const stewardId = randomUUID();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: stewardId, status: "active", membershipRole: "operator" });
    await db.insert(authUsers).values({
      id: stewardId,
      name: "Titus",
      email: "titus@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Casper", role: "chief_of_staff", status: "idle", adapterType: "process" })
      .returning()
      .then((rows) => rows[0]!);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: stewardId,
      assignedByUserId: ownerMember.principalId,
    });
    return { company, stewardId, agent };
  }

  async function openApproval(companyId: string, agentId: string) {
    const approval = await db
      .insert(approvals)
      .values({
        companyId,
        type: "connector_send",
        requestedByAgentId: agentId,
        status: "pending",
        payload: { summary: "the secret draft body that must never reach a channel" },
        revision: 1,
      })
      .returning()
      .then((rows) => rows[0]!);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");
    return approval;
  }

  const okFetch = (calls: Array<{ url: string; body: string }>) =>
    (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

  it("registers only a webhook that answers the challenge, cursor at head", async () => {
    const { company, stewardId, agent } = await seed();
    await openApproval(company.id, agent.id); // pre-existing history

    const calls: Array<{ url: string; body: string }> = [];
    const svc = stewardWebhooksService(db, { fetchImpl: okFetch(calls) });
    const created = await svc.register({
      companyId: company.id,
      userId: stewardId,
      url: "https://prod.workflows.example/trigger/abc",
      label: "Casper channel",
    });
    expect(created.verifiedAt).toBeTruthy();
    expect(calls).toHaveLength(1); // the challenge post
    expect(calls[0]!.body).toContain("Titus");

    // Registration means "from now on": the pre-existing event is not replayed.
    const swept = await svc.sweep();
    expect(swept.delivered).toBe(0);
  });

  it("refuses a webhook that does not answer, registering nothing", async () => {
    const { company, stewardId } = await seed();
    const svc = stewardWebhooksService(db, {
      fetchImpl: (async () => new Response("nope", { status: 403 })) as typeof fetch,
    });
    await expect(
      svc.register({ companyId: company.id, userId: stewardId, url: "https://x.example/hook", label: "" }),
    ).rejects.toThrow(/refused the test message/);
    expect(await db.select().from(stewardWebhooks)).toHaveLength(0);
  });

  it("refuses plain http, because the URL is a secret and the digest names people's work", async () => {
    const { company, stewardId } = await seed();
    const svc = stewardWebhooksService(db, { fetchImpl: okFetch([]) });
    await expect(
      svc.register({ companyId: company.id, userId: stewardId, url: "http://x.example/hook", label: "" }),
    ).rejects.toThrow(/https/);
  });

  it("delivers the digest when the log advances — ask and pointer, never the evidence", async () => {
    const { company, stewardId, agent } = await seed();
    const calls: Array<{ url: string; body: string }> = [];
    const svc = stewardWebhooksService(db, { fetchImpl: okFetch(calls) });
    await svc.register({ companyId: company.id, userId: stewardId, url: "https://x.example/hook", label: "chan" });

    await openApproval(company.id, agent.id);
    const swept = await svc.sweep({ approvalsBaseUrl: "https://mk.example" });
    expect(swept.delivered).toBe(1);

    const delivery = calls[1]!; // 0 was the challenge
    const payload = JSON.parse(delivery.body) as { text: string };
    expect(payload.text).toContain("AgentDash inbox — Titus");
    expect(payload.text).toContain("Waiting on your decision (1):");
    expect(payload.text).toContain("Casper — connector_send");
    expect(payload.text).toContain(`https://mk.example/${company.issuePrefix}/approvals`);
    // The privacy contract, asserted against the actual wire bytes.
    expect(payload.text).not.toContain("secret draft body");
    expect(delivery.body).not.toContain("secret draft body");

    // Nothing new → nothing sent.
    const again = await svc.sweep({ approvalsBaseUrl: "https://mk.example" });
    expect(again.delivered).toBe(0);
    expect(calls).toHaveLength(2);

    // The other half of the privacy contract: a webhook delivery must not
    // CREATE anything handle-shaped. Discovered empirically — the first
    // implementation minted callback tokens against the webhook id and the
    // foreign key refused it. Zero rows is the specification.
    expect(await db.select().from(channelCallbackTokens)).toHaveLength(0);
  });

  it("keeps the window on failure and retries it on the next sweep", async () => {
    const { company, stewardId, agent } = await seed();
    let failNext = false;
    const calls: string[] = [];
    const svc = stewardWebhooksService(db, {
      fetchImpl: (async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return new Response("x", { status: failNext ? 500 : 200 });
      }) as typeof fetch,
    });
    await svc.register({ companyId: company.id, userId: stewardId, url: "https://x.example/hook", label: "chan" });
    await openApproval(company.id, agent.id);

    failNext = true;
    expect((await svc.sweep()).delivered).toBe(0);
    const [afterFail] = await db.select().from(stewardWebhooks);
    expect(afterFail!.lastError).toBe("HTTP 500");
    expect(afterFail!.lastDeliveredAt).toBeNull();

    failNext = false;
    expect((await svc.sweep()).delivered).toBe(1);
    const [afterOk] = await db.select().from(stewardWebhooks);
    expect(afterOk!.lastError).toBeNull();
    expect(afterOk!.lastDeliveredAt).toBeTruthy();
  });

  it("a revoked webhook goes silent, immediately", async () => {
    const { company, stewardId, agent } = await seed();
    const calls: string[] = [];
    const svc = stewardWebhooksService(db, {
      fetchImpl: (async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const created = await svc.register({ companyId: company.id, userId: stewardId, url: "https://x.example/hook", label: "chan" });
    await svc.revoke(company.id, stewardId, created.id);
    await openApproval(company.id, agent.id);
    expect((await svc.sweep()).delivered).toBe(0);
    expect(calls).toHaveLength(1); // only the challenge, ever
  });

  describe("the routes", () => {
    function appAs(userId: string) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as { actor?: unknown }).actor = { type: "board", userId, source: "board_key" };
        next();
      });
      app.use("/api", stewardWebhookRoutes(db));
      app.use(errorHandler);
      return app;
    }

    it("lists the person's own webhooks with the URL reduced to a hint", async () => {
      const { company, stewardId } = await seed();
      const svc = stewardWebhooksService(db, { fetchImpl: okFetch([]) });
      await svc.register({ companyId: company.id, userId: stewardId, url: "https://prod.workflows.example/trigger/very-secret-path", label: "chan" });

      const res = await request(appAs(stewardId)).get(`/api/companies/${company.id}/me/webhooks`);
      expect(res.status).toBe(200);
      expect(res.body.webhooks).toHaveLength(1);
      expect(res.body.webhooks[0].urlHint).toBe("prod.workflows.example…");
      expect(JSON.stringify(res.body)).not.toContain("very-secret-path");
    });

    it("shows nobody else's webhooks and revokes only one's own", async () => {
      const { company, stewardId } = await seed();
      const svc = stewardWebhooksService(db, { fetchImpl: okFetch([]) });
      const created = await svc.register({ companyId: company.id, userId: stewardId, url: "https://x.example/hook", label: "chan" });

      const stranger = randomUUID();
      const listed = await request(appAs(stranger)).get(`/api/companies/${company.id}/me/webhooks`);
      expect(listed.body.webhooks).toHaveLength(0);
      const revoked = await request(appAs(stranger)).post(`/api/companies/${company.id}/me/webhooks/${created.id}/revoke`);
      expect(revoked.status).toBe(404);
      const [row] = await db.select().from(stewardWebhooks).where(and(eq(stewardWebhooks.id, created.id), eq(stewardWebhooks.companyId, company.id)));
      expect(row!.revokedAt).toBeNull();
    });
  });
});
