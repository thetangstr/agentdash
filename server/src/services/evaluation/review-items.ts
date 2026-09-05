import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, labels, projects } from "@paperclipai/db";
import { EVALUATION_REVIEW_LABEL, EVALUATION_REVIEW_PROJECT_NAME, type EvaluationMilestoneRef } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { projectService } from "../projects.js";
import type { ExceptionRecord, ScoredCard } from "./scoring/types.js";

/**
 * AgentDash: Company Evaluator — review items (spec §9.2, Milestone 3).
 *
 * Deterministic server code, not the evaluator agent: exceptions on a stored
 * card become issues in the Evaluator review-items project, labelled
 * `evaluator-review`, status `todo`, assigned only to a human. Routine
 * exceptions are batched into ONE digest per milestone per routed human,
 * created on the first exception and updated in place afterwards (an
 * update sends no message — that is the chatter ceiling). Immediate
 * exceptions (E3, E4, and material E2/E12/E13) each get one item at once.
 * Items never touch a source issue; closing one is the human's act, and a
 * closed item stays closed: the same key is never recreated or reopened.
 * Idempotent: every item carries its key in a marker; re-running changes
 * nothing that has not changed.
 */

const MARKER = (key: string) => `<!-- evaluator-key: ${key} -->`;
const CLOSED_STATUSES = new Set(["done", "cancelled"]);
export const REVIEW_PROJECT_DESCRIPTION = "Review items raised by the Company Evaluator. Assigned only to humans; closing one is the human's act.";

/** LIKE metacharacters in a key (qualifiers carry `_`) must match literally. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Creating the review project and label is serialised per company (blocking advisory lock) so two syncs cannot race into two projects. */
async function withReviewItemsLock<T>(db: Db, companyId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`evaluation_review_items:${companyId}`}, 0))`);
    return fn(tx as unknown as Db);
  });
}
const IMMEDIATE_SEVERITIES = new Set(["immediate"]);
const MATERIAL_IMMEDIATE_IDS = new Set(["E2", "E12", "E13"]); // §9.2: when material (release / credential), immediate

export interface ReviewItemSyncResult {
  /** Null when the card carried no exceptions and nothing was created. */
  projectId: string | null;
  labelId: string | null;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Items the human has closed (done or cancelled): left closed, never recreated or reopened. */
  closed: string[];
  /** Exceptions with no human to route to (no accountable owner and no fallback): recorded, not silently dropped. */
  unrouted: string[];
  /** Items whose routed human is not an active member of the company (cannot be assigned): recorded, not silently dropped. */
  unassignable: Array<{ key: string; userId: string }>;
}

export function evaluationReviewItems(db: Db) {
  const issuesSvc = issueService(db);

  /** The review project and label, created once per company under the per-company lock. */
  async function ensureProjectAndLabel(companyId: string): Promise<{ projectId: string; labelId: string }> {
    return withReviewItemsLock(db, companyId, async (tx) => {
      const project = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.name, EVALUATION_REVIEW_PROJECT_NAME)))
        .orderBy(projects.createdAt)
        .then((rows) => rows[0] ?? null);
      const projectId = project?.id ?? (await projectService(tx).create(companyId, { name: EVALUATION_REVIEW_PROJECT_NAME, description: REVIEW_PROJECT_DESCRIPTION, status: "in_progress" })).id;
      const label = await tx
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.companyId, companyId), eq(labels.name, EVALUATION_REVIEW_LABEL)))
        .then((rows) => rows[0] ?? null);
      const labelId = label?.id ?? (await issueService(tx).createLabel(companyId, { name: EVALUATION_REVIEW_LABEL, color: "#6b7280" }))!.id;
      return { projectId, labelId };
    });
  }

  /** The item carrying this key in the review project, whatever its status (a closed one must be found so it is never recreated). */
  async function itemByKey(companyId: string, projectId: string, key: string) {
    const pattern = `%${likeEscape(MARKER(key))}%`;
    return db
      .select({ id: issues.id, description: issues.description, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.projectId, projectId), sql`${issues.description} LIKE ${pattern} ESCAPE '\\'`))
      .orderBy(issues.createdAt)
      .then((rows) => rows[0] ?? null);
  }

  return {
    /**
     * Bring the review items for one stored card up to date. `fallbackUserId`
     * is the human who receives exceptions with no accountable owner (the
     * administrator who ran the snapshot, or the company's founder).
     */
    async sync(companyId: string, ref: EvaluationMilestoneRef, card: ScoredCard, cardVersion: number, fallbackUserId: string | null): Promise<ReviewItemSyncResult> {
      // nothing to write → nothing created, not even the project or the label
      if (card.exceptions.length === 0) return { projectId: null, labelId: null, created: [], updated: [], unchanged: [], closed: [], unrouted: [], unassignable: [] };
      const { projectId, labelId } = await ensureProjectAndLabel(companyId);
      const result: ReviewItemSyncResult = { projectId, labelId, created: [], updated: [], unchanged: [], closed: [], unrouted: [], unassignable: [] };
      const milestoneName = card.milestoneName ?? `${ref.kind} ${ref.id}`;
      const humanFor = (e: ExceptionRecord) => e.routing.accountableUserId ?? card.contract.accountableUserId ?? fallbackUserId;

      const digests = new Map<string, ExceptionRecord[]>();
      const immediates: ExceptionRecord[] = [];
      for (const e of card.exceptions) {
        const immediate = IMMEDIATE_SEVERITIES.has(e.severity) || (MATERIAL_IMMEDIATE_IDS.has(e.id) && e.severity === "material");
        const human = humanFor(e);
        if (!human) {
          result.unrouted.push(e.key);
          continue;
        }
        if (immediate) immediates.push(e);
        else digests.set(human, [...(digests.get(human) ?? []), e]);
      }

      const upsert = async (key: string, title: string, description: string, assigneeUserId: string) => {
        const body = `${description}\n\n${MARKER(key)}`;
        const existing = await itemByKey(companyId, projectId, key);
        if (existing) {
          // the human closed it: that decision stands — no recreation, no reopening, no message
          if (CLOSED_STATUSES.has(existing.status)) {
            result.closed.push(existing.id);
            return;
          }
          if ((existing.description ?? "") === body) {
            result.unchanged.push(existing.id);
            return;
          }
          // in place: no comment, no status change, no message
          await issuesSvc.update(existing.id, { description: body });
          result.updated.push(existing.id);
          return;
        }
        try {
          const created = await issuesSvc.create(companyId, {
            title,
            description: body,
            status: "todo",
            priority: "medium",
            projectId,
            assigneeUserId,
            assigneeAgentId: null,
            labelIds: [labelId],
          });
          result.created.push(created.id);
        } catch (err) {
          // the routed human is not an active member here: never fall back to an agent, never fail the whole sync
          if (err instanceof Error && /Assignee user not found/.test(err.message)) {
            result.unassignable.push({ key, userId: assigneeUserId });
            return;
          }
          throw err;
        }
      };

      for (const [human, list] of [...digests.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const key = `digest:${ref.kind}:${ref.id}:${human}`;
        await upsert(key, `Evaluator digest — ${milestoneName}`, renderDigest(milestoneName, list, card, cardVersion), human);
      }
      for (const e of immediates.sort((a, b) => (a.key < b.key ? -1 : 1))) {
        const human = humanFor(e)!;
        await upsert(`immediate:${e.key}`, `Evaluator: ${e.title} — ${subjectLabel(e, card, milestoneName)}`, renderImmediate(milestoneName, e, card, cardVersion), human);
      }
      if (result.unrouted.length > 0) logger.warn({ companyId, count: result.unrouted.length }, "evaluation_review_items: exceptions with no human to route to");
      if (result.unassignable.length > 0) logger.warn({ companyId, count: result.unassignable.length }, "evaluation_review_items: routed humans are not active company members");
      return result;
    },
  };
}

/** Founder-facing name for an exception's subject: an identifier when there is one, otherwise a name or a plain noun — never a raw id. */
function subjectLabel(e: ExceptionRecord, card: ScoredCard, milestoneName: string): string {
  const s = e.subject;
  if (s.identifier) return s.identifier;
  switch (s.kind) {
    case "agent":
      return card.actors?.find((a) => a.actorId === s.id)?.name ?? "an agent";
    case "milestone":
      return milestoneName;
    case "company":
      return "this company";
    case "comment":
      return "a comment";
    case "pair":
      return "a reviewer pair";
    default:
      return "an item";
  }
}

function renderDigest(milestoneName: string, list: ExceptionRecord[], card: ScoredCard, cardVersion: number): string {
  const byId = new Map<string, ExceptionRecord[]>();
  for (const e of list) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
  const lines: string[] = [];
  lines.push(`Routine exceptions the Company Evaluator raised on **${milestoneName}** (card v${cardVersion}). This item is updated in place as exceptions accrue; closing it is your act and is recorded.`);
  lines.push("");
  for (const [id, group] of [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`### ${id} ${group[0]!.title} — ${group.length}`);
    for (const e of group.slice(0, 30)) {
      lines.push(`- ${subjectLabel(e, card, milestoneName)}: ${e.note}${e.evidenceRefs.length > 0 ? ` (events ${e.evidenceRefs.slice(0, 5).join(", ")}${e.evidenceRefs.length > 5 ? ", …" : ""})` : ""}`);
    }
    if (group.length > 30) lines.push(`- … ${group.length - 30} more in the card`);
    lines.push("");
  }
  if (card.markers.length > 0) {
    lines.push(`Card markers: ${card.markers.join("; ")}`);
    lines.push("");
  }
  lines.push("The evaluator never changes reviewed work. Dispute a finding with a correction; the routed human decides.");
  return lines.join("\n");
}

function renderImmediate(milestoneName: string, e: ExceptionRecord, card: ScoredCard, cardVersion: number): string {
  const lines = [
    `**${e.id} ${e.title}** (${e.severity}) on **${milestoneName}** — card v${cardVersion}.`,
    "",
    e.note,
    "",
    `Subject: ${e.subject.kind} ${subjectLabel(e, card, milestoneName)}`,
    `Raised at: ${e.raisedAt}`,
    e.evidenceRefs.length > 0 ? `Evidence: events ${e.evidenceRefs.slice(0, 20).join(", ")}${e.evidenceRefs.length > 20 ? ", …" : ""}` : "Evidence: none cited",
  ];
  if (e.markers.length > 0) lines.push(`Markers: ${e.markers.join("; ")}`);
  lines.push("", "The evaluator never changes reviewed work. Dispute this finding with a correction; the routed human decides.");
  return lines.join("\n");
}
