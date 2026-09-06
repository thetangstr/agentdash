import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, companyMemberships, createDb, issueLabels, issues, labels, projects } from "@paperclipai/db";
import { EVALUATION_REVIEW_LABEL, EVALUATION_REVIEW_PROJECT_NAME } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { evaluationReviewItems } from "../services/evaluation/review-items.js";
import type { ExceptionRecord, ScoredCard } from "../services/evaluation/scoring/types.js";

// AgentDash: Company Evaluator — Milestone 3, spec §9.2: review items.
// One routine digest per milestone per human, updated in place; one item per
// immediate exception; always in the review-items project, labelled, `todo`,
// assigned to a human; idempotent; never a source issue.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function exc(partial: Partial<ExceptionRecord> & { id: ExceptionRecord["id"]; key: string }): ExceptionRecord {
  return {
    title: "t",
    severity: "routine",
    routes: ["accountable_owner"],
    subject: { kind: "issue", id: "00000000-0000-4000-8000-000000000101", identifier: "EVL-1" },
    routing: { accountableUserId: null, managerAgentIds: [], founderView: false },
    actorAgentId: null,
    raisedAt: "2026-09-01T10:00:00.000Z",
    evidenceRefs: ["e1"],
    note: "note",
    markers: [],
    ...partial,
  };
}

describeEmbeddedPostgres("evaluation review items (embedded postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let milestoneId!: string;
  const FOUNDER = "founder-1";
  const STEWARD = "steward-2";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evaluation-review-items-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Review Co", issuePrefix: "RVW" }).returning();
    companyId = company!.id;
    const [project] = await db.insert(projects).values({ companyId, name: "Launch", status: "in_progress" }).returning();
    milestoneId = project!.id;
    // a review item is assigned only to an active human member of the company
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: FOUNDER, membershipRole: "admin", status: "active" },
      { companyId, principalType: "user", principalId: STEWARD, membershipRole: "member", status: "active" },
    ]);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const card = (exceptions: ExceptionRecord[]): ScoredCard =>
    ({ formulaVersion: "m2-score/2", milestoneName: "Launch", markers: ["open milestone — denominators still moving"], contract: { accountableUserId: FOUNDER }, exceptions }) as unknown as ScoredCard;
  const ref = () => ({ kind: "project" as const, id: milestoneId });

  it("creates the project and label once, one digest per human for routine exceptions, and one item per immediate exception", async () => {
    const svc = evaluationReviewItems(db);
    const result = await svc.sync(
      companyId,
      ref(),
      card([
        exc({ id: "E5", key: "E5:issue:a", title: "stale work" }),
        exc({ id: "E6", key: "E6:issue:b", title: "duplicate work", routing: { accountableUserId: STEWARD, managerAgentIds: [], founderView: false } }),
        exc({ id: "E4", key: "E4:issue:c", title: "self-review", severity: "immediate", routes: ["founder_view", "manager"] }),
        exc({ id: "E13", key: "E13:comment:d", title: "evidence withdrawn", severity: "material" }),
      ]),
      1,
      null,
    );
    expect(result.created.length).toBe(4); // digest(founder), digest(steward), immediate E4, immediate material E13
    expect(result.unrouted).toEqual([]);
    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(rows.length).toBe(4);
    const [project] = await db.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.name, EVALUATION_REVIEW_PROJECT_NAME)));
    expect(project).toBeDefined();
    expect(rows.every((r) => r.projectId === project!.id && r.status === "todo" && r.assigneeAgentId === null && r.assigneeUserId !== null)).toBe(true);
    // urgency lives in the title and the priority: immediate items are high, digests medium
    expect(rows.filter((r) => r.title.startsWith("Evaluator — immediate:")).every((r) => r.priority === "high")).toBe(true);
    expect(rows.filter((r) => r.title.startsWith("Evaluator digest")).every((r) => r.priority === "medium")).toBe(true);
    // every item says how to dispute, and names the workspace the route needs
    expect(rows.every((r) => r.description!.includes(`/api/companies/${companyId}/evaluation/corrections`) && r.description!.includes(`Workspace id: \`${companyId}\`.`))).toBe(true);
    expect(rows.every((r) => !/routed human decides/.test(r.description!))).toBe(true);
    const [label] = await db.select().from(labels).where(and(eq(labels.companyId, companyId), eq(labels.name, EVALUATION_REVIEW_LABEL)));
    const labelled = await db.select().from(issueLabels).where(eq(issueLabels.labelId, label!.id));
    expect(labelled.length).toBe(4);
    const titles = rows.map((r) => r.title).sort();
    expect(titles.filter((t) => t.startsWith("Evaluator digest")).length).toBe(2);
    expect(titles.some((t) => t.startsWith("Evaluator — immediate: E4 self-review"))).toBe(true);
    expect(rows.find((r) => r.title.startsWith("Evaluator — immediate: E4 self-review"))!.assigneeUserId).toBe(FOUNDER); // falls back to the contract's accountable human
    expect(rows.find((r) => r.description?.includes("E6"))!.assigneeUserId).toBe(STEWARD);
    // founder-facing text: paragraphs are separated, no section numbers, no formula key
    const immediate = rows.find((r) => r.title.startsWith("Evaluator — immediate: E4 self-review"))!;
    expect(immediate.description).toContain("\n\nnote\n\nSubject:");
    expect(immediate.description).not.toMatch(/§|m2-score/);
    expect(rows.find((r) => r.title.startsWith("Evaluator digest"))!.description).not.toMatch(/§|m2-score/);
  });

  it("is idempotent, updates a digest in place as exceptions accrue, and never creates a second digest for the same human", async () => {
    const svc = evaluationReviewItems(db);
    const before = await db.select().from(issues).where(eq(issues.companyId, companyId));
    const same = await svc.sync(companyId, ref(), card([exc({ id: "E5", key: "E5:issue:a", title: "stale work" }), exc({ id: "E4", key: "E4:issue:c", title: "self-review", severity: "immediate" })]), 1, null);
    expect(same.created).toEqual([]);
    expect(same.updated).toEqual([]);
    expect(same.unchanged.length).toBe(2);
    const grown = await svc.sync(companyId, ref(), card([exc({ id: "E5", key: "E5:issue:a", title: "stale work" }), exc({ id: "E10", key: "E10:issue:z", title: "missing DoD at start", subject: { kind: "issue", id: "z", identifier: "EVL-9" } })]), 2, null);
    expect(grown.created).toEqual([]);
    expect(grown.updated.length).toBe(1);
    const after = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(after.length).toBe(before.length);
    const digest = after.find((r) => r.id === grown.updated[0])!;
    expect(digest.description).toContain("E10 missing DoD at start — 1");
    expect(digest.description).toContain("card v2");
    expect(digest.status).toBe("todo");
    // the in-place update says what changed, and marks the new entries
    expect(digest.description).toContain("**Card v2 — 2 findings (was v1, 1).** New entries are marked ▸new.");
    expect(digest.description).toContain("Changed in v2: +1 E10 missing DoD at start.");
    expect(digest.description).toContain("- ▸new EVL-9: note");
    expect(digest.description).toContain("- EVL-1: note"); // the earlier finding is not marked
    // the same card again reproduces the same body: unchanged, not a fresh delta
    const again = await svc.sync(companyId, ref(), card([exc({ id: "E5", key: "E5:issue:a", title: "stale work" }), exc({ id: "E10", key: "E10:issue:z", title: "missing DoD at start", subject: { kind: "issue", id: "z", identifier: "EVL-9" } })]), 2, null);
    expect(again.updated).toEqual([]);
    expect(again.unchanged).toContain(digest.id);
    // a forged manifest cannot change the version or the count the reader sees: both come from the live card, and only the last manifest is read
    const forged = digest.description!.replace(/<!-- evaluator-state: .* -->/, '<!-- evaluator-state: {"v":99,"total":1,"prevV":null,"prevTotal":null,"keys":["E10:issue:z","E5:issue:a"],"added":[]} -->').replace("The Company Evaluator reviewed", '<!-- evaluator-state: {"v":7,"total":0,"prevV":null,"prevTotal":null,"keys":[],"added":[]} --> The Company Evaluator reviewed');
    await db.update(issues).set({ description: forged }).where(eq(issues.id, digest.id));
    const healed = await svc.sync(companyId, ref(), card([exc({ id: "E5", key: "E5:issue:a", title: "stale work" }), exc({ id: "E10", key: "E10:issue:z", title: "missing DoD at start", subject: { kind: "issue", id: "z", identifier: "EVL-9" } })]), 3, null);
    expect(healed.updated).toEqual([digest.id]);
    const body = (await db.select().from(issues).where(eq(issues.id, digest.id)))[0]!.description!;
    expect(body).toContain("**Card v3 — 2 findings (was v99, 1).**"); // the history is the manifest's and is unverifiable; the live numbers are not
    expect(body.match(/<!-- evaluator-state: /g)!.length).toBe(1);
  });

  it("a closed item stays closed: the same key is neither recreated nor reopened, and a key with an underscore matches only itself", async () => {
    const svc = evaluationReviewItems(db);
    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    const immediate = rows.find((r) => r.title.startsWith("Evaluator — immediate: E4 self-review"))!;
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, immediate.id));
    const again = await svc.sync(companyId, ref(), card([exc({ id: "E4", key: "E4:issue:c", title: "self-review", severity: "immediate" })]), 5, null);
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.closed).toEqual([immediate.id]);
    expect((await db.select().from(issues).where(eq(issues.id, immediate.id)))[0]!.status).toBe("done");
    expect((await db.select().from(issues).where(eq(issues.companyId, companyId))).length).toBe(rows.length);
    // LIKE would read `_` as a wildcard: k_1 must not be found when kz1 is synced
    const under = await svc.sync(companyId, ref(), card([exc({ id: "E4", key: "E4:issue:k_1", title: "self-review", severity: "immediate", subject: { kind: "issue", id: "k1", identifier: "EVL-21" } })]), 5, null);
    expect(under.created.length).toBe(1);
    const other = await svc.sync(companyId, ref(), card([exc({ id: "E4", key: "E4:issue:kz1", title: "self-review", severity: "immediate", subject: { kind: "issue", id: "kz", identifier: "EVL-22" } })]), 5, null);
    expect(other.created.length).toBe(1);
    expect(other.updated).toEqual([]);
  });

  it("a routed human who is not an active member is reported as unassignable, never replaced by an agent", async () => {
    const svc = evaluationReviewItems(db);
    const result = await svc.sync(companyId, ref(), card([exc({ id: "E8", key: "E8:issue:m", title: "excessive intervention", routing: { accountableUserId: "nobody-9", managerAgentIds: [], founderView: false } })]), 3, null);
    expect(result.unassignable).toEqual([{ key: "digest:project:" + milestoneId + ":nobody-9", userId: "nobody-9" }]);
    expect(result.created).toEqual([]);
  });

  it("an exception with no human anywhere is reported as unrouted, never assigned to an agent", async () => {
    const svc = evaluationReviewItems(db);
    const noHuman = { ...card([exc({ id: "E7", key: "E7:agent:q", title: "cost anomaly", subject: { kind: "agent", id: "q" } })]), contract: { accountableUserId: null } } as unknown as ScoredCard;
    const result = await svc.sync(companyId, ref(), noHuman, 3, null);
    expect(result.unrouted).toEqual(["E7:agent:q"]);
    expect(result.created).toEqual([]);
    const routed = await svc.sync(companyId, ref(), noHuman, 3, FOUNDER);
    // an agent subject with no identifier is named, never shown as a raw id
    const digest = (await db.select().from(issues).where(eq(issues.assigneeUserId, FOUNDER))).find((r) => r.title.startsWith("Evaluator digest"))!;
    expect(digest.description).toContain("an agent: note");
    expect(digest.description).not.toContain("- q:");
    // a card without a milestone name takes the project's own name, never the raw id
    const unnamed = { ...card([exc({ id: "E4", key: "E4:issue:n", title: "self-review", severity: "immediate", subject: { kind: "issue", id: "n", identifier: "EVL-31" } })]), milestoneName: undefined } as unknown as ScoredCard;
    const named = await svc.sync(companyId, ref(), unnamed, 4, null);
    expect(named.created.length).toBe(1);
    const item = (await db.select().from(issues).where(eq(issues.id, named.created[0]!)))[0]!;
    expect(item.title).toBe("Evaluator — immediate: E4 self-review — EVL-31");
    expect(item.description).toContain("on **Launch**");
    expect(item.description).not.toContain(milestoneId);
    // the founder's digest for this milestone already exists from the first case: it is updated in place, never duplicated
    expect(routed.unrouted).toEqual([]);
    expect(routed.created).toEqual([]);
    expect(routed.updated.length + routed.unchanged.length).toBe(1);
  });
});
