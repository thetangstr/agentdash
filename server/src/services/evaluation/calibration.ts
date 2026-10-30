import { createHash } from "node:crypto";
import type { Request } from "express";
import { and, eq, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { evaluationEvents } from "@paperclipai/db";
import {
  evaluationCriterionRefKey,
  type AgentCardDisagreement,
  type AgentCardFatalFlag,
  type AgentCardObligationRow,
  type AgentCardV1,
  type EvaluationAccessClass,
  type EvaluationContractV2,
  type EvaluationCriterionRef,
  type EvaluationWorkItemRef,
} from "@paperclipai/shared";
import { resolveEvaluationViewer, viewerClassFilter, type EvaluationViewer } from "./access-class.js";
import { evaluationReviewItems, type ReviewItemSyncResult } from "./review-items.js";

/**
 * AgentDash: Agent Performance Management gate 3 — human calibration of an
 * agent's judges (evaluation LLD §10). P3.1 froze the signatures; P3.3
 * implements them on the existing review-items path (Evaluator review-items
 * project, `evaluator-review` label, `todo`, assigned only to a human,
 * idempotent by key, a closed item never recreated).
 */

export const CALIBRATION_REASONS = ["sample", "disagreement", "fatal_flag"] as const;
export type CalibrationReason = (typeof CALIBRATION_REASONS)[number];

/** One item a named person should judge. */
export interface CalibrationSampleItem {
  /** Deterministic: `calibration:<agentId>:<reason>:<item kind>:<item id>[:<criterion key>]`; the review item's marker. */
  key: string;
  agentId: string;
  responsibilityKey: string | null;
  reason: CalibrationReason;
  item: EvaluationWorkItemRef;
  /** Set for disagreements; null for samples and fatal flags (the person judges every criterion of the item). */
  criterion: EvaluationCriterionRef | null;
  /** The responsibility's `judges.human.userId`; the contract's accountable user when no responsibility or human judge applies (fatal flags). */
  routeToUserId: string;
  /** `sample` only: the item's score in [0, 1) — the first 8 hex characters of sha256(JSON `[itemId, window.from]`) / 2^32. Null otherwise. */
  sampleScore: number | null;
}

/** `hash(issueId, window.from)` in [0, 1): deterministic, uniform, independent of the item's content (LLD §10). */
export function calibrationSampleScore(itemId: string, windowFrom: string): number {
  const hex = createHash("sha256").update(JSON.stringify([itemId, windowFrom])).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) / 2 ** 32;
}

/** A criterion tuple as a short marker-safe token (criterion ids are free text). */
export function criterionToken(ref: EvaluationCriterionRef): string {
  return createHash("sha256").update(evaluationCriterionRefKey(ref)).digest("hex").slice(0, 16);
}

export interface CalibrationSampleInput {
  agentId: string;
  windowFrom: string;
  obligations: AgentCardObligationRow[];
  disagreements: AgentCardDisagreement[];
  fatal: AgentCardFatalFlag[];
  contract: EvaluationContractV2;
}

/**
 * The pure selection both `selectCalibrationSample` and agent scoring (the
 * card's `decisions.calibration.sampled`) use, so the card and the review
 * items always agree. Rows of other profile revisions are not this
 * contract's.
 */
export function calibrationSampleFrom(input: CalibrationSampleInput): CalibrationSampleItem[] {
  const out = new Map<string, CalibrationSampleItem>();
  const add = (x: CalibrationSampleItem) => {
    if (!out.has(x.key)) out.set(x.key, x);
  };
  const { agentId, contract } = input;
  const byKey = new Map(contract.responsibilities.map((r) => [r.key, r] as const));
  for (const r of contract.responsibilities) {
    const human = r.judges.human;
    if (!human) continue;
    const items = new Map<string, EvaluationWorkItemRef>();
    for (const row of input.obligations) {
      if (row.responsibilityKey !== r.key || row.profileRevisionId !== contract.profileRevisionId) continue;
      for (const item of row.deliveredItems) items.set(`${item.kind}:${item.id}`, item);
    }
    const scored = [...items.values()]
      .map((item) => ({ item, score: calibrationSampleScore(item.id, input.windowFrom) }))
      .sort((a, b) => a.score - b.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
    const chosen = scored.filter((x) => x.score < human.sampleRate);
    // topped up with the lowest-scoring remaining items to at least minPerWindow
    for (const x of scored) {
      if (chosen.length >= human.minPerWindow) break;
      if (!chosen.includes(x)) chosen.push(x);
    }
    for (const x of chosen) {
      add({ key: `calibration:${agentId}:sample:${x.item.kind}:${x.item.id}`, agentId, responsibilityKey: r.key, reason: "sample", item: x.item, criterion: null, routeToUserId: human.userId, sampleScore: x.score });
    }
  }
  for (const d of input.disagreements) {
    const r = byKey.get(d.criterion.responsibilityKey);
    if (!r) continue;
    const to = r.judges.human?.userId ?? contract.accountableUserId;
    if (!to) continue;
    add({ key: `calibration:${agentId}:disagreement:${d.item.kind}:${d.item.id}:${criterionToken(d.criterion)}`, agentId, responsibilityKey: r.key, reason: "disagreement", item: d.item, criterion: d.criterion, routeToUserId: to, sampleScore: null });
  }
  for (const f of input.fatal) {
    if (!f.item || f.status === "dismissed" || !contract.accountableUserId) continue;
    add({ key: `calibration:${agentId}:fatal_flag:${f.item.kind}:${f.item.id}`, agentId, responsibilityKey: null, reason: "fatal_flag", item: f.item, criterion: null, routeToUserId: contract.accountableUserId, sampleScore: null });
  }
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The calibration set for one card. Pure, deterministic. Per responsibility
 * with `judges.human`: delivered items whose `sampleScore < sampleRate`,
 * topped up with the lowest-scoring remaining items to at least
 * `minPerWindow`; plus every criterion-level disagreement; plus every
 * potentially fatal flag. Unique by `key`, sorted by key.
 */
export function selectCalibrationSample(card: AgentCardV1, contract: EvaluationContractV2): CalibrationSampleItem[] {
  return calibrationSampleFrom({
    agentId: card.subjectRef.id,
    windowFrom: card.replay.window.from,
    obligations: card.worker.obligations.body.responsibilities,
    disagreements: card.worker.decisions.body.disagreements,
    fatal: card.fatal.body,
    contract,
  });
}

export interface CalibrationSyncResult extends ReviewItemSyncResult {
  /** Items not created because the routed person can't read every class behind them (recorded, never silently dropped). */
  withheld: Array<{ key: string; userId: string }>;
}

/**
 * The evaluation viewer a named person would be, resolved without a request:
 * a company admin reads everything; anyone else reads by the class rules.
 * Instance-admin status is not assumed (narrow, never wider).
 */
export async function evaluationViewerForUser(db: Db, companyId: string, userId: string): Promise<EvaluationViewer> {
  const req = { actor: { type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId], memberships: [] } } as unknown as Request;
  return resolveEvaluationViewer(db, req, companyId);
}

/** Every (class, project) pair behind one work item at the card's cut. */
async function classesBehind(db: Db, companyId: string, item: EvaluationWorkItemRef, throughSeq: number): Promise<Array<{ accessClass: EvaluationAccessClass; projectId: string | null }>> {
  const about =
    item.kind === "issue"
      ? or(sql`${evaluationEvents.payload}->>'issueId' = ${item.id}`, sql`${evaluationEvents.payload}->>'linkedIssueId' = ${item.id}`)
      : or(eq(evaluationEvents.sourceId, item.id), sql`${evaluationEvents.payload}->>'deliverableRunId' = ${item.id}`);
  const rows = await db
    .selectDistinct({ accessClass: evaluationEvents.accessClass, projectId: evaluationEvents.projectId })
    .from(evaluationEvents)
    .where(and(eq(evaluationEvents.companyId, companyId), lte(evaluationEvents.seq, throughSeq), about));
  // an unparseable stored class stays as stored: the viewer rule reads it as admin-only (narrow, never wider)
  return rows.map((r) => ({ accessClass: r.accessClass as EvaluationAccessClass, projectId: r.projectId }));
}

function itemLabelFor(item: EvaluationWorkItemRef): string {
  return item.kind === "issue" ? "an issue" : "a deliverable run";
}

function renderCalibrationItem(companyId: string, card: AgentCardV1, cardVersion: number, x: CalibrationSampleItem, identifier: string | null): string {
  const agent = card.agentName ?? "this agent";
  const what = identifier ?? itemLabelFor(x.item);
  const criteria = card.worker.quality.body.criteria.filter((c) => (x.criterion ? evaluationCriterionRefKey(c.criterion) === evaluationCriterionRefKey(x.criterion) : c.criterion.responsibilityKey === x.responsibilityKey));
  const why =
    x.reason === "sample"
      ? `It was drawn in this window's calibration sample for **${x.responsibilityKey}** (deterministic: score ${x.sampleScore?.toFixed(4)}).`
      : x.reason === "disagreement"
        ? `Two bound judgments disagree on one criterion of it. Both stay on record; nothing is settled by vote. Your judgment is a third, bound one.`
        : `It carries a potentially fatal flag. Only a person can confirm or dismiss it.`;
  const lines = [
    `**Calibration for ${agent} — ${what}** (agent card v${cardVersion}).`,
    "",
    why,
    "",
    "Judge each criterion below against the work itself and record it as a bound attestation:",
    "",
  ];
  for (const c of criteria.slice(0, 20)) lines.push(`- ${c.text} — \`${JSON.stringify(c.criterion)}\``);
  if (criteria.length === 0) lines.push("- (no criterion with a check on record for this responsibility; note what you see in a comment)");
  lines.push(
    "",
    `\`POST /api/companies/${companyId}/evaluation/dispositions\` with \`{ "kind": "criterion_attest", "binding": { "criterion": <a tuple above>, "subjectRef": { "kind": "agent", "id": "${x.agentId}" }, "item": ${JSON.stringify(x.item)} }, "result": "satisfied" | "unsatisfied", "evidenceRefs": ["<a ledger event id>"] }\`.`,
    "",
    "Closing this item is your decision; it will not be re-raised for the same key. The evaluator changed nothing and blocked nothing.",
  );
  return lines.join("\n");
}

/**
 * Bring the calibration review items for one stored card version up to date.
 * Review items filter by class: an item is created only when the routed
 * person may read every class behind it. The person closes it with a bound
 * verdict or `criterion_attest`.
 */
export async function syncCalibrationReviewItems(
  db: Db,
  input: { companyId: string; agentId: string; card: AgentCardV1; cardVersion: number; sample: CalibrationSampleItem[] },
): Promise<CalibrationSyncResult> {
  const result: CalibrationSyncResult = { projectId: null, labelId: null, created: [], updated: [], unchanged: [], closed: [], unrouted: [], unassignable: [], withheld: [] };
  if (input.sample.length === 0) return result;
  const items = evaluationReviewItems(db);
  const viewers = new Map<string, EvaluationViewer>();
  for (const x of [...input.sample].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    let viewer = viewers.get(x.routeToUserId);
    if (!viewer) {
      viewer = await evaluationViewerForUser(db, input.companyId, x.routeToUserId);
      viewers.set(x.routeToUserId, viewer);
    }
    const readable = viewerClassFilter(viewer);
    const behind = await classesBehind(db, input.companyId, x.item, input.card.replay.throughSeq);
    if (behind.some((row) => !readable(row))) {
      result.withheld.push({ key: x.key, userId: x.routeToUserId });
      continue;
    }
    const identifier = x.item.kind === "issue" ? await issueIdentifier(db, input.companyId, x.item.id) : null;
    const title = `Calibration — ${input.card.agentName ?? "agent"}: ${identifier ?? itemLabelFor(x.item)}${x.reason === "sample" ? "" : x.reason === "disagreement" ? " (disagreement)" : " (potentially fatal flag)"}`;
    const outcome = await items.upsertKeyed(input.companyId, {
      key: x.key,
      title,
      priority: x.reason === "fatal_flag" ? "high" : "medium",
      assigneeUserId: x.routeToUserId,
      body: renderCalibrationItem(input.companyId, input.card, input.cardVersion, x, identifier),
    });
    result.projectId = outcome.projectId;
    result.labelId = outcome.labelId;
    if (outcome.outcome === "unassignable") result.unassignable.push({ key: x.key, userId: x.routeToUserId });
    else if (outcome.issueId) result[outcome.outcome].push(outcome.issueId);
  }
  return result;
}

async function issueIdentifier(db: Db, companyId: string, issueId: string): Promise<string | null> {
  const rows = await db
    .select({ identifier: sql<string | null>`${evaluationEvents.payload}->>'identifier'` })
    .from(evaluationEvents)
    .where(and(eq(evaluationEvents.companyId, companyId), sql`${evaluationEvents.payload}->>'issueId' = ${issueId}`, sql`${evaluationEvents.payload}->>'identifier' is not null`))
    .limit(1);
  return rows[0]?.identifier ?? null;
}
