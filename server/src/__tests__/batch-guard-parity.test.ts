import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentApiKeys, approvals, companyMemberships, instanceUserRoles, issues, labels, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser } from "./helpers/agent-profile-fixtures.js";
import { startBatchTestApp, type BatchTestApp } from "./helpers/batch-test-app.js";
import { BATCH_KINDS } from "../services/batch/kinds.js";


/**
 * AgentDash admin powers, part 2: the guard parity harness.
 *
 * For every registered production kind, a matrix of actors runs the same
 * change against twin records: one twin through the single-record route
 * directly, the other through a batch (preview → confirm → runner →
 * loopback). A batch must never allow what the single route refuses for that
 * actor. For board sessions the two answers must be identical; actors who may
 * not start a batch at all (agents) must be refused at preview.
 *
 * Part 3 kinds join here: add an entry to SCENARIOS for each new kind, and
 * the "every kind is covered" test fails until one exists.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Verdict = "allow" | "deny";
type ActorKey = "admin" | "memberCreator" | "memberOther" | "suspendedMember" | "instanceAdminNonMember" | "outsider" | "agent";
type Actor = { key: ActorKey; headers: Record<string, string>; batches: boolean };
type RecordKey = "open" | "restrictedByOwner" | "restrictedByCreator" | "foreign";

describeEmbeddedPostgres("batch guard parity: the batch path never allows what the single route refuses", () => {
  let t!: BatchTestApp;
  let companyId = "";
  let otherCompanyId = "";
  let agentId = "";
  let ownerId = "";
  let creatorId = "";
  let ownerProjectId = "";
  let creatorProjectId = "";
  let openProjectId = "";
  let labelId = "";
  let personId = "";
  const actors = new Map<ActorKey, Actor>();

  beforeAll(async () => {
    t = await startBatchTestApp("paperclip-batch-parity-");
    companyId = (await addCompany(t.db, "Parity", "default")).id;
    otherCompanyId = (await addCompany(t.db, "Parity other", "default")).id;
    ownerId = await addUser(t.db, companyId, "owner");
    creatorId = await addUser(t.db, companyId, "member");
    const otherId = await addUser(t.db, companyId, "member");
    const suspendedId = await addUser(t.db, companyId, "member");
    await t.db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, suspendedId));
    const instanceAdminId = await addUser(t.db, otherCompanyId, "member");
    await t.db.insert(instanceUserRoles).values({ userId: instanceAdminId, role: "instance_admin" });
    const outsiderId = await addUser(t.db, otherCompanyId, "owner");
    const agent = await addAgent(t.db, companyId, { name: "Parity agent", status: "paused" });
    agentId = agent.id;
    const actingAgent = await addAgent(t.db, companyId, { name: "Acting agent", role: "ceo", status: "idle" });
    await t.db.insert(agentApiKeys).values({ agentId: actingAgent.id, companyId, name: "parity", keyHash: createHash("sha256").update("parity-agent-key").digest("hex") });
    ownerProjectId = (await t.db.insert(projects).values({ companyId, name: "Owner restricted", visibility: "restricted", createdByUserId: ownerId }).returning())[0]!.id;
    openProjectId = (await t.db.insert(projects).values({ companyId, name: "Open project" }).returning())[0]!.id;
    labelId = (await t.db.insert(labels).values({ companyId, name: "Parity", color: "#123456" }).returning())[0]!.id;
    personId = await addUser(t.db, companyId, "member");
    creatorProjectId = (await t.db.insert(projects).values({ companyId, name: "Creator restricted", visibility: "restricted", createdByUserId: creatorId }).returning())[0]!.id;

    for (const [key, userId] of [
      ["admin", ownerId], ["memberCreator", creatorId], ["memberOther", otherId], ["suspendedMember", suspendedId],
      ["instanceAdminNonMember", instanceAdminId], ["outsider", outsiderId],
    ] as const) {
      actors.set(key, { key, headers: t.browser(await t.signIn(userId)), batches: true });
    }
    actors.set("agent", { key: "agent", headers: { authorization: "Bearer parity-agent-key" }, batches: false });
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  async function twin(kindKey: string, record: RecordKey) {
    if (kindKey.startsWith("approval.")) {
      // Board-filed approvals (no requesting agent): waiting on every member.
      const target = record === "foreign" ? otherCompanyId : companyId;
      const insert = () => t.db.insert(approvals).values({
        companyId: target, type: "request_board_approval", requestedByUserId: ownerId, status: "pending", payload: { title: `${record} ${randomUUID().slice(0, 4)}` },
      }).returning().then((rows) => rows[0]!);
      return { direct: await insert(), batch: await insert() };
    }
    const values = {
      open: { companyId, projectId: null },
      restrictedByOwner: { companyId, projectId: ownerProjectId },
      restrictedByCreator: { companyId, projectId: creatorProjectId },
      foreign: { companyId: otherCompanyId, projectId: null },
    }[record];
    const insert = () => t.db.insert(issues).values({ ...values, title: `${record} ${randomUUID().slice(0, 4)}`, status: "todo", priority: "medium" })
      .returning().then((rows) => rows[0]!);
    return { direct: await insert(), batch: await insert() };
  }

  /** The record a kind builds its request from, for the direct call. */
  function recordFor(kindKey: string, row: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (kindKey.startsWith("approval.")) {
      return { entityType: "approval", entityId: row.id, label: "", status: row.status, revision: row.revision, waitingOnYou: true, canDecide: true };
    }
    return {
      entityType: "issue", entityId: row.id, label: "",
      status: row.status, priority: row.priority,
      assigneeAgentId: row.assigneeAgentId, assigneeUserId: row.assigneeUserId,
      projectId: row.projectId, labelIds: [],
    };
  }

  const SCENARIOS: Record<string, Array<{ name: string; change: Record<string, unknown> }>> = {
    "issue.update": [
      { name: "status", change: { status: "in_review" } },
      { name: "status to blocked", change: { status: "blocked" } },
      { name: "priority", change: { priority: "critical" } },
      { name: "assign to an agent", change: { assignee: { agentId: "__AGENT__" } } },
      { name: "assign to a person", change: { assignee: { userId: "__PERSON__" } } },
      { name: "add a label", change: { addLabelIds: ["__LABEL__"] } },
      { name: "move to a project", change: { projectId: "__PROJECT__" } },
    ],
    "approval.approve": [
      { name: "approve with a note", change: { decisionNote: "Approved in a batch." } },
    ],
    "approval.reject": [
      { name: "reject", change: {} },
    ],
  };

  it("every production kind has parity scenarios", () => {
    expect(Object.keys(BATCH_KINDS).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });

  for (const [kindKey, scenarios] of Object.entries(SCENARIOS)) {
    for (const scenario of scenarios) {
      it(`${kindKey}: ${scenario.name}`, async () => {
        const kind = BATCH_KINDS[kindKey]!;
        const change = kind.parseChange(JSON.parse(JSON.stringify(scenario.change)
          .replaceAll("__AGENT__", agentId).replaceAll("__PERSON__", personId)
          .replaceAll("__LABEL__", labelId).replaceAll("__PROJECT__", openProjectId)));
        const table: Array<{ actor: ActorKey; record: RecordKey; direct: Verdict; batch: Verdict }> = [];
        for (const actor of actors.values()) {
          const records = new Map<RecordKey, Awaited<ReturnType<typeof twin>>>();
          for (const key of ["open", "restrictedByOwner", "restrictedByCreator", "foreign"] as const) records.set(key, await twin(kindKey, key));

          // 1. The single-record route, called directly with the kind's own request.
          const direct = new Map<RecordKey, Verdict>();
          for (const [key, pair] of records) {
            const built = kind.request(recordFor(kindKey, pair.direct), change, { itemId: randomUUID(), before: { revision: (pair.direct as { revision?: number }).revision } });
            const res = await request(t.server)[built.method.toLowerCase() as "patch" | "post"](built.path).set(actor.headers).send(built.body);
            expect(res.status, `${actor.key}/${key} direct: ${JSON.stringify(res.body)}`).not.toBeGreaterThanOrEqual(500);
            direct.set(key, res.status >= 200 && res.status < 300 ? "allow" : "deny");
          }

          // 2. The same change to the twins, as one batch.
          const batch = new Map<RecordKey, Verdict>();
          const byBatchId = new Map([...records].map(([key, pair]) => [pair.batch.id, key]));
          const preview = await request(t.server).post(`/api/companies/${companyId}/batches/preview`).set(actor.headers)
            .send({ kind: kindKey, ids: [...byBatchId.keys()], change });
          if (preview.status === 403 || preview.status === 401) {
            for (const key of records.keys()) batch.set(key, "deny");
          } else {
            expect(preview.status, `${actor.key} preview: ${JSON.stringify(preview.body)}`).toBe(200);
            for (const key of records.keys()) batch.set(key, "deny");
            if (preview.body.batchId) {
              const confirm = await request(t.server).post(`/api/companies/${companyId}/batches/${preview.body.batchId}/confirm`)
                .set(actor.headers).send({ handle: preview.body.confirmHandle, previewDigest: preview.body.previewDigest });
              expect(confirm.status, `${actor.key} confirm: ${JSON.stringify(confirm.body)}`).toBe(202);
              await t.batches.waitForRunner(preview.body.batchId);
              const read = await request(t.server).get(`/api/companies/${companyId}/batches/${preview.body.batchId}`).set(actor.headers);
              for (const item of read.body.items as Array<{ entityId: string; outcome: string; reason: string | null }>) {
                expect(["applied", "refused"], `${actor.key} ${item.entityId}: ${item.outcome} ${item.reason}`).toContain(item.outcome);
                batch.set(byBatchId.get(item.entityId)!, item.outcome === "applied" ? "allow" : "deny");
              }
            }
          }
          for (const key of records.keys()) table.push({ actor: actor.key, record: key, direct: direct.get(key)!, batch: batch.get(key)! });
        }

        for (const row of table) {
          const label = `${row.actor} × ${row.record}: direct ${row.direct}, batch ${row.batch}`;
          // The rule: a batch never allows what the single route refuses.
          if (row.batch === "allow") expect(row.direct, label).toBe("allow");
          // A batch is bound to its company: another company's record is never
          // touched, even by someone who could change it there directly.
          if (row.record === "foreign") expect(row.batch, label).toBe("deny");
          // Board sessions get exactly the single route's answer.
          else if (actors.get(row.actor)!.batches) expect(row.batch, label).toBe(row.direct);
          // Actors who may not start a batch are refused at preview.
          else expect(row.batch, label).toBe("deny");
        }
        // The matrix is not vacuous: someone is allowed and someone is refused.
        expect(table.some((row) => row.direct === "allow" && row.batch === "allow")).toBe(true);
        expect(table.some((row) => row.direct === "deny")).toBe(true);
        // Admins see restricted work; another member does not; nobody reaches another company.
        const find = (actor: ActorKey, record: RecordKey) => table.find((row) => row.actor === actor && row.record === record)!;
        if (kind.entityType === "issue") {
          expect(find("admin", "restrictedByOwner")).toMatchObject({ direct: "allow", batch: "allow" });
          expect(find("memberCreator", "restrictedByCreator")).toMatchObject({ direct: "allow", batch: "allow" });
          expect(find("memberOther", "restrictedByCreator")).toMatchObject({ direct: "deny", batch: "deny" });
        }
        for (const actor of actors.keys()) expect(find(actor, "foreign").batch).toBe("deny");
      }, 120_000);
    }
  }
});
