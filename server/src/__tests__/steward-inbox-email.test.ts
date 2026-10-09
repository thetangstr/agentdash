import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issueApprovals,
  issues,
  stewardEmailNotices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { SendEmailInput, SendEmailResult } from "../auth/email.js";
import { errorHandler } from "../middleware/index.js";
import { notificationPreferenceRoutes } from "../routes/notification-preferences.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  INBOX_EMAIL_WINDOW_MS,
  MAX_SEND_ATTEMPTS,
  renderInboxEmail,
  stewardInboxEmailService,
  writeInboxEmailPreference,
} from "../services/steward-inbox-email.js";
import { truncateWithRetry } from "./helpers/truncate.js";

/**
 * AgentDash-MK: the inbox email. A pointer to what is waiting, never the
 * ask; addressed exactly as the digest is; at most one per person per window,
 * with the window kept in the database.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** Agent-authored text that must never reach an email. */
const SECRET_PROMPT = "Restated: the vendor offered a 12 percent discount on the renewal";
const SECRET_OPTION = "Accept the discounted renewal (recommended)";
const SECRET_PAYLOAD = "draft body for the client channel";

describe("inbox email content", () => {
  it("is pointers and a way to answer: agent, identifier, link -- no issue title", () => {
    const email = renderInboxEmail({
      name: "Steward A",
      appUrl: "https://agentdash.example",
      pointers: [
        { kind: "question", agentName: "Agent A", identifier: "ABC-12", link: "https://agentdash.example/ABC/issues/ABC-12" },
        { kind: "approval", agentName: "Agent A", identifier: null, approvalType: "connector_send", link: "https://agentdash.example/approvals/a1" },
      ],
    });
    expect(email.subject).toBe("AgentDash: 2 items are waiting on you");
    expect(email.text).toContain("Agent A asked you a question on ABC-12: https://agentdash.example/ABC/issues/ABC-12");
    expect(email.text).toContain("Agent A needs your decision (connector_send): https://agentdash.example/approvals/a1");
    expect(email.text).toContain("check my AgentDash inbox");
    expect(email.text).toContain("names the agent and the issue only");
    expect(email.text).toContain("My Agent page");
    expect(email.html).toContain('<a href="https://agentdash.example/ABC/issues/ABC-12">open</a>');
  });

  it("flattens and escapes an agent name", () => {
    const email = renderInboxEmail({
      name: null,
      appUrl: null,
      pointers: [{ kind: "question", agentName: "<b>Agent</b>\nA", identifier: "ABC-1", link: null }],
    });
    expect(email.html).not.toContain("<b>");
    expect(email.html).toContain("&lt;b&gt;Agent&lt;/b&gt; A asked you a question on ABC-1");
    expect(email.text).toContain("  - <b>Agent</b> A asked you a question on ABC-1");
  });
});

describeEmbeddedPostgres("inbox email sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-email-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}`);
    await db.delete(authUsers);
    await db.execute(sql`delete from user_notification_preferences`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function person(companyId: string, role: string, name: string, email: string | null) {
    const member = await db
      .insert(companyMemberships)
      .values({ companyId, principalType: "user", principalId: randomUUID(), status: "active", membershipRole: role })
      .returning()
      .then((rows) => rows[0]!);
    if (email !== null) {
      await db.insert(authUsers).values({
        id: member.principalId,
        name,
        email,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return member;
  }

  async function seed(options: { stewardAEmail?: string | null } = {}) {
    const prefix = `EM${randomUUID().slice(0, 6).toUpperCase()}`;
    const company = await db
      .insert(companies)
      .values({ name: `Email ${randomUUID()}`, issuePrefix: prefix, productProfile: "agentdash_mk" })
      .returning()
      .then((rows) => rows[0]!);
    const owner = await person(company.id, "owner", "Owner", "owner@example.test");
    const stewardA = await person(
      company.id,
      "operator",
      "Steward A",
      options.stewardAEmail === undefined ? "steward-a@example.test" : options.stewardAEmail,
    );
    const stewardB = await person(company.id, "operator", "Steward B", "steward-b@example.test");
    const makeAgent = async (name: string, stewardUserId: string) => {
      const agent = await db
        .insert(agents)
        .values({ companyId: company.id, name, role: "general", status: "idle", adapterType: "process" })
        .returning()
        .then((rows) => rows[0]!);
      await agentStewardshipService(db).assign(company.id, {
        agentId: agent.id,
        userId: stewardUserId,
        assignedByUserId: owner.principalId,
      });
      return agent;
    };
    const agentA = await makeAgent("Agent A", stewardA.principalId);
    await makeAgent("Agent B", stewardB.principalId);
    return { company, prefix, stewardA, stewardB, agentA };
  }

  let counter = 0;
  async function ask(companyId: string, prefix: string, agentId: string, title: string) {
    counter += 1;
    const issue = await db
      .insert(issues)
      .values({ companyId, title, status: "blocked", assigneeAgentId: agentId, identifier: `${prefix}-${counter}` })
      .returning()
      .then((rows) => rows[0]!);
    await issueThreadInteractionService(db).create(
      issue,
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          title: SECRET_PROMPT,
          questions: [
            {
              id: "q",
              prompt: SECRET_PROMPT,
              selectionMode: "single",
              options: [
                { id: "yes", label: SECRET_OPTION, description: SECRET_PROMPT },
                { id: "no", label: "Decline" },
              ],
            },
          ],
        },
      } as never,
      { agentId },
    );
    return issue;
  }

  function harness(start = Date.now()) {
    const sent: SendEmailInput[] = [];
    let clock = start;
    let configured = true;
    let outcome: SendEmailResult = { status: "sent" };
    let gate: Promise<void> | null = null;
    const make = () =>
      stewardInboxEmailService(db, {
        send: async (input) => {
          sent.push(input);
          if (gate) await gate;
          return outcome;
        },
        isConfigured: () => configured,
        publicBaseUrl: "https://agentdash.example",
        now: () => new Date(clock),
      });
    return {
      sent,
      service: make(),
      /** A fresh instance on the same database: what a restart looks like. */
      restart: make,
      advance: (ms: number) => {
        clock += ms;
      },
      setConfigured: (value: boolean) => {
        configured = value;
      },
      setOutcome: (value: SendEmailResult) => {
        outcome = value;
      },
      /** Hold every send until released, to overlap two deliveries. */
      hold: () => {
        let release!: () => void;
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return () => {
          gate = null;
          release();
        };
      },
      now: () => new Date(clock),
    };
  }

  async function statuses() {
    return (await db.select().from(stewardEmailNotices)).map((row) => row.status).sort();
  }

  it("emails the steward a pointer to the question, never its text", async () => {
    const { company, prefix, agentA } = await seed();
    const issue = await ask(company.id, prefix, agentA.id, "Reply to the vendor");
    const { sent, service } = harness();

    expect(await service.sweep()).toMatchObject({ sent: 1, configured: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("steward-a@example.test");
    expect(sent[0]!.text).toContain(
      `Agent A asked you a question on ${issue.identifier}: https://agentdash.example/${prefix}/issues/${issue.identifier}`,
    );
    for (const body of [sent[0]!.text!, sent[0]!.html, sent[0]!.subject]) {
      expect(body).not.toContain(SECRET_PROMPT);
      expect(body).not.toContain(SECRET_OPTION);
      // Issue titles are often agent-written; the email carries none.
      expect(body).not.toContain("Reply to the vendor");
    }
  });

  it("points at an approval by its linked issue, never its payload", async () => {
    const { company, prefix, agentA } = await seed();
    const issue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Send the weekly note", status: "todo", assigneeAgentId: agentA.id, identifier: `${prefix}-90` })
      .returning()
      .then((rows) => rows[0]!);
    const approval = await db
      .insert(approvals)
      .values({ companyId: company.id, type: "connector_send", requestedByAgentId: agentA.id, status: "pending", payload: { body: SECRET_PAYLOAD }, revision: 1 })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(issueApprovals).values({ companyId: company.id, issueId: issue.id, approvalId: approval.id });
    const { sent, service } = harness();

    await service.sweep();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(`Agent A needs your decision (connector_send) on ${issue.identifier}:`);
    expect(`${sent[0]!.text}${sent[0]!.html}`).not.toContain(SECRET_PAYLOAD);
    expect(`${sent[0]!.text}${sent[0]!.html}`).not.toContain("Send the weekly note");
  });

  it("sends at most one email per window and folds everything new into the next, across a restart", async () => {
    const { company, prefix, agentA } = await seed();
    const first = await ask(company.id, prefix, agentA.id, "First thing");
    const h = harness();

    await h.service.sweep();
    expect(h.sent).toHaveLength(1);

    const second = await ask(company.id, prefix, agentA.id, "Second thing");
    const third = await ask(company.id, prefix, agentA.id, "Third thing");
    h.advance(5 * 60 * 1000);
    // A restart inside the window: the window is read from the database.
    const restarted = h.restart();
    expect((await restarted.sweep()).sent).toBe(0);
    expect(h.sent).toHaveLength(1);

    h.advance(INBOX_EMAIL_WINDOW_MS);
    expect((await restarted.sweep()).sent).toBe(1);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.subject).toBe("AgentDash: 2 items are waiting on you");
    expect(h.sent[1]!.text).toContain(`on ${second.identifier}:`);
    expect(h.sent[1]!.text).toContain(`on ${third.identifier}:`);
    expect(h.sent[1]!.text).not.toContain(`on ${first.identifier}:`);

    // Nothing new: nothing sent, however long it has been.
    h.advance(INBOX_EMAIL_WINDOW_MS * 2);
    expect((await restarted.sweep()).sent).toBe(0);
  });

  it("sends nothing to a person who turned inbox emails off", async () => {
    const { company, prefix, stewardA, agentA } = await seed();
    await writeInboxEmailPreference(db, stewardA.principalId, false);
    await ask(company.id, prefix, agentA.id, "Reply to the vendor");
    const { sent, service } = harness();

    await service.sweep();
    expect(sent).toHaveLength(0);
    const rows = await db.select().from(stewardEmailNotices).where(eq(stewardEmailNotices.userId, stewardA.principalId));
    expect(rows.map((row) => row.status)).toEqual(["opted_out"]);
  });

  it("does nothing, and records nothing, while email is not configured", async () => {
    const { company, prefix, agentA } = await seed();
    await ask(company.id, prefix, agentA.id, "Reply to the vendor");
    const h = harness();
    h.setConfigured(false);

    expect(await h.service.sweep()).toEqual({ sent: 0, configured: false });
    expect(await h.service.sweep()).toEqual({ sent: 0, configured: false });
    expect(h.sent).toHaveLength(0);
    expect(await db.select().from(stewardEmailNotices)).toHaveLength(0);
  });

  it("emails only the person the digest addresses: never another steward, never someone without an email", async () => {
    const { company, prefix, agentA } = await seed({ stewardAEmail: null });
    await ask(company.id, prefix, agentA.id, "Reply to the vendor");
    const { sent, service } = harness();

    await service.sweep();
    // Steward A has no email address; Steward B is not addressed at all.
    expect(sent).toHaveLength(0);
    const rows = await db.select().from(stewardEmailNotices);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("undeliverable");
  });

  it("emails nobody about a question whose person is no longer an active member", async () => {
    const { company, prefix, stewardA, agentA } = await seed();
    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(eq(companyMemberships.principalId, stewardA.principalId));
    await ask(company.id, prefix, agentA.id, "Reply to the vendor");
    const { sent, service } = harness();

    await service.sweep();
    expect(sent).toHaveLength(0);
  });

  it("lets a person turn inbox emails off and on for themselves, defaulting on", async () => {
    const userId = randomUUID();
    const app = (actor: Record<string, unknown>) => {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      server.use("/api", notificationPreferenceRoutes(db));
      server.use(errorHandler);
      return server;
    };
    const me = app({ type: "board", source: "session", userId, companyIds: [] });

    expect((await request(me).get("/api/notification-preferences/me")).body).toMatchObject({ inboxEmail: true });
    expect((await request(me).put("/api/notification-preferences/me").send({ inboxEmail: false })).body).toMatchObject({
      inboxEmail: false,
    });
    expect((await request(me).get("/api/notification-preferences/me")).body.inboxEmail).toBe(false);

    const assistant = app({ type: "board", source: "assistant_grant", userId, companyIds: [] });
    expect((await request(assistant).put("/api/notification-preferences/me").send({ inboxEmail: true })).status).toBe(403);
    const agent = app({ type: "agent", agentId: randomUUID(), source: "agent_key" });
    expect((await request(agent).get("/api/notification-preferences/me")).status).toBe(403);
  });

  it("never mails the same rows twice when two deliveries overlap", async () => {
    const { company, prefix, agentA } = await seed();
    await ask(company.id, prefix, agentA.id, "Reply to the vendor");
    const h = harness();
    await h.service.detect();
    const release = h.hold();
    // Two processes' worth of delivery, at once, on the same database.
    const first = h.service.deliver();
    const second = h.restart().deliver();
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.sent).sort()).toEqual([0, 1]);
    expect(h.sent).toHaveLength(1);
    expect(await statuses()).toEqual(["sent"]);
  });

  it("settles a claim abandoned mid-send as uncertain and never resends it", async () => {
    const { company, prefix, agentA } = await seed();
    await ask(company.id, prefix, agentA.id, "Reply to the vendor");
    const h = harness();
    await h.service.detect();
    // A sweep claimed it and died before recording the outcome.
    await db.update(stewardEmailNotices).set({ status: "sending", claimedAt: new Date(h.now().getTime() - 11 * 60 * 1000) });

    await h.service.sweep();
    expect(h.sent).toHaveLength(0);
    expect(await statuses()).toEqual(["uncertain"]);
    h.advance(INBOX_EMAIL_WINDOW_MS * 2);
    await h.service.sweep();
    expect(h.sent).toHaveLength(0);
  });

  it("backs off after a refused send and gives up after the attempt cap", async () => {
    const { company, prefix, agentA } = await seed();
    await ask(company.id, prefix, agentA.id, "Reply to the vendor");
    const h = harness();
    h.setOutcome({ status: "failed", error: "HTTP 422" });

    await h.service.sweep();
    expect(h.sent).toHaveLength(1);
    const [row] = await db.select().from(stewardEmailNotices);
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    // Inside the backoff: no attempt.
    await h.service.sweep();
    expect(h.sent).toHaveLength(1);

    for (let attempt = 2; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      h.advance(60 * 60 * 1000);
      await h.service.sweep();
    }
    expect(h.sent).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(await statuses()).toEqual(["failed"]);
    h.advance(60 * 60 * 1000);
    await h.service.sweep();
    expect(h.sent).toHaveLength(MAX_SEND_ATTEMPTS);
  });

  it("treats a send with an unknown outcome as possibly sent: never resent, and it starts the window", async () => {
    const { company, prefix, agentA } = await seed();
    await ask(company.id, prefix, agentA.id, "First thing");
    const h = harness();
    h.setOutcome({ status: "failed", error: "The operation was aborted due to timeout", ambiguous: true });

    await h.service.sweep();
    expect(await statuses()).toEqual(["uncertain"]);
    h.setOutcome({ status: "sent" });
    await ask(company.id, prefix, agentA.id, "Second thing");
    h.advance(60 * 1000);
    await h.service.sweep();
    expect(h.sent).toHaveLength(1);
    h.advance(INBOX_EMAIL_WINDOW_MS);
    await h.service.sweep();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.subject).toBe("AgentDash: 1 item is waiting on you");
  });

  it("still delivers what is recorded when detection fails", async () => {
    const { company, prefix, agentA } = await seed();
    await ask(company.id, prefix, agentA.id, "Reply to the vendor");
    const recorder = harness();
    await recorder.service.detect();
    const sent: SendEmailInput[] = [];
    let calls = 0;
    const service = stewardInboxEmailService(db, {
      send: async (input) => {
        sent.push(input);
        return { status: "sent" };
      },
      isConfigured: () => true,
      publicBaseUrl: null,
      // The first clock read is detection's: make detection fail.
      now: () => {
        calls += 1;
        if (calls === 1) throw new Error("detection broke");
        return new Date();
      },
    });

    expect((await service.sweep()).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("emails about every addressed item, not only the digest's first ten", async () => {
    const { company, prefix, agentA } = await seed();
    const asked = [];
    for (let index = 0; index < 12; index += 1) asked.push(await ask(company.id, prefix, agentA.id, `Item ${index}`));
    const { sent, service } = harness();

    await service.sweep();
    expect(sent[0]!.subject).toBe("AgentDash: 12 items are waiting on you");
    for (const issue of asked) expect(sent[0]!.text).toContain(`on ${issue.identifier}:`);
  });

  it("dates an approval from its latest revision, not its creation, for the backlog rule", async () => {
    const { company, agentA } = await seed();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await db.insert(approvals).values({
      companyId: company.id,
      type: "connector_send",
      requestedByAgentId: agentA.id,
      status: "pending",
      payload: {},
      revision: 2,
      createdAt: twoDaysAgo,
      updatedAt: new Date(),
    });
    const { sent, service } = harness();

    await service.sweep();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Agent A needs your decision (connector_send)");
  });

  it("does not mail a standing backlog the first time it sees it", async () => {
    const { company, prefix, agentA } = await seed();
    await ask(company.id, prefix, agentA.id, "Old question");
    const { sent, service } = harness(Date.now() + 25 * 60 * 60 * 1000);

    await service.sweep();
    expect(sent).toHaveLength(0);
    expect((await db.select().from(stewardEmailNotices))[0]!.status).toBe("baseline");
  });
});
