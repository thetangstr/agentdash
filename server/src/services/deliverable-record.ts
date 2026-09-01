import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  deliverableFacts,
  deliverableRuns,
  deliverables,
  factCorrections,
  factValues,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";

/**
 * AgentDash-MK: the derivation record — how this organization's numbers are made.
 *
 * ## Why it is a by-product and never an artifact
 *
 * Context that is authored goes stale; context that is exhaust stays current.
 * The compounding-context-as-moat claim did not survive the evidence, but
 * freshness-as-byproduct did — so nothing here is written by hand. Every field
 * this serves was produced by running a cycle: the derivation came from the
 * implementer's fact list, the value and its source came from the collector,
 * the corrections came from an approver saying a number was wrong, and the
 * confirmation came from two people signing it off.
 *
 * ## Why only shipped cycles are served
 *
 * A figure two named humans have not signed off is a draft, not the answer to
 * "where does this number come from". Serving it would let the record report
 * numbers nobody stood behind, which is the failure the two-approver gate
 * exists to prevent — reintroduced one endpoint later.
 *
 * ## Why age travels with the number
 *
 * A human at the end of a workflow catches errors but not wrong foundations. A
 * stale premise passes review silently, every time, because it looks exactly
 * like a fresh one. So `ageSeconds` and `lastConfirmedBy` are inside the record
 * rather than beside it: a reader who never thinks to ask how old a figure is
 * gets told anyway.
 *
 * ## What this is not
 *
 * Not policy. Nothing verifies that anyone read it, and nothing can — which is
 * why `disclaimer` is part of every payload rather than a line in a document
 * somewhere. Shipping shared context and calling it governance would be
 * claiming a control that does not exist.
 */

const DISCLAIMER =
  "Read-only shared context. Nothing verifies that this record was read and nothing here is " +
  "enforced; it is not policy. It reports what was actually used to produce the last approved " +
  "cycle, including how old each figure is and who last confirmed it.";

function ageSecondsFrom(at: Date | null, now: Date): number | null {
  if (!at) return null;
  return Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
}

export function deliverableRecordService(db: Db) {
  /** The most recent shipped run of a deliverable, or null. */
  async function lastShippedRun(deliverableId: string) {
    return db
      .select()
      .from(deliverableRuns)
      .where(
        and(
          eq(deliverableRuns.deliverableId, deliverableId),
          isNotNull(deliverableRuns.shippedAt),
        ),
      )
      .orderBy(desc(deliverableRuns.shippedAt))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Who last stood behind this cycle.
   *
   * The second approver, read from the approval row itself rather than from a
   * column on the run: the decision and who made it belong to the approvals
   * service, which stays the single decision boundary even for a read.
   */
  async function lastConfirmedBy(run: typeof deliverableRuns.$inferSelect | null) {
    if (!run?.secondApprovalId) return null;
    const approval = await db
      .select({
        decidedByUserId: approvals.decidedByUserId,
        decidedAt: approvals.decidedAt,
      })
      .from(approvals)
      .where(eq(approvals.id, run.secondApprovalId))
      .then((rows) => rows[0] ?? null);
    if (!approval?.decidedByUserId) return null;
    return {
      userId: approval.decidedByUserId,
      at: approval.decidedAt ? approval.decidedAt.toISOString() : null,
      stage: "second" as const,
    };
  }

  /**
   * Resolve a fact key, refusing rather than guessing when it is ambiguous.
   *
   * Fact keys are unique per deliverable, not per company, so a bare key can
   * name two figures. Picking one would be picking the wrong number some of the
   * time, and which time is unknowable from here — the same refusal as an
   * ambiguous worksheet, and for the same reason: a wrong number that looks
   * right is worse than an error.
   *
   * `deliverable/fact` disambiguates.
   */
  async function resolveFact(companyId: string, rawKey: string) {
    const slash = rawKey.indexOf("/");
    const deliverableKey = slash === -1 ? null : rawKey.slice(0, slash);
    const factKey = slash === -1 ? rawKey : rawKey.slice(slash + 1);

    const candidates = await db
      .select({
        fact: deliverableFacts,
        deliverableKey: deliverables.key,
        deliverableName: deliverables.name,
        deliverableId: deliverables.id,
      })
      .from(deliverableFacts)
      .innerJoin(deliverables, eq(deliverableFacts.deliverableId, deliverables.id))
      .where(
        and(
          eq(deliverables.companyId, companyId),
          eq(deliverableFacts.key, factKey),
          ...(deliverableKey ? [eq(deliverables.key, deliverableKey)] : []),
        ),
      );

    if (candidates.length === 0) throw notFound("No such fact in this workspace");
    if (candidates.length > 1) {
      throw conflict("That fact key exists on more than one deliverable; name which one", {
        code: "FACT_KEY_AMBIGUOUS",
        candidates: candidates.map((row) => `${row.deliverableKey}/${factKey}`),
      });
    }
    return candidates[0]!;
  }

  /** One figure's whole story: definition, current value, corrections, age. */
  async function factRecord(companyId: string, rawKey: string) {
    const resolved = await resolveFact(companyId, rawKey);
    const now = new Date();
    const run = await lastShippedRun(resolved.deliverableId);
    const value = run
      ? await db
          .select()
          .from(factValues)
          .where(
            and(eq(factValues.runId, run.id), eq(factValues.factId, resolved.fact.id)),
          )
          .then((rows) => rows[0] ?? null)
      : null;

    const corrections = await db
      .select()
      .from(factCorrections)
      .where(eq(factCorrections.factId, resolved.fact.id))
      .orderBy(desc(factCorrections.createdAt));

    return {
      deliverableKey: resolved.deliverableKey,
      deliverableName: resolved.deliverableName,
      factKey: resolved.fact.key,
      label: resolved.fact.label,
      sourceType: resolved.fact.sourceType,
      derivation: resolved.fact.derivation,
      connectorProvider: resolved.fact.connectorProvider,
      runKey: run?.runKey ?? null,
      // Null until a cycle has actually shipped. A draft nobody signed off is
      // not an answer to "where does this number come from".
      current: value
        ? {
            value: value.value,
            status: value.status,
            sourceRef: value.sourceRef,
            method: value.method,
            fetchedAt: value.fetchedAt ? value.fetchedAt.toISOString() : null,
            ageSeconds: ageSecondsFrom(value.fetchedAt, now),
            flagged: value.flagged,
            flagReason: value.flagReason,
            appliedCorrectionId: value.appliedCorrectionId,
          }
        : null,
      lastConfirmedBy: await lastConfirmedBy(run),
      // The corrections say what was wrong with the FIGURE. Nothing here names
      // whose figure it was — there is no such column and no such query.
      corrections: corrections.map((row) => ({
        id: row.id,
        correction: row.correction,
        reason: row.reason,
        recordedAt: row.createdAt.toISOString(),
        active: row.retiredAt === null,
      })),
      disclaimer: DISCLAIMER,
    };
  }

  /** The last shipped cycle, whole, with provenance and age on every figure. */
  async function latestShipped(companyId: string, deliverableKey: string) {
    const deliverable = await db
      .select()
      .from(deliverables)
      .where(and(eq(deliverables.companyId, companyId), eq(deliverables.key, deliverableKey)))
      .then((rows) => rows[0] ?? null);
    if (!deliverable) throw notFound("Deliverable not found");

    const run = await lastShippedRun(deliverable.id);
    const now = new Date();
    if (!run) {
      return {
        deliverableKey: deliverable.key,
        deliverableName: deliverable.name,
        runKey: null,
        shippedAt: null,
        facts: [],
        approvals: { first: null, second: null },
        disclaimer: DISCLAIMER,
      };
    }

    const rows = await db
      .select({
        factKey: deliverableFacts.key,
        label: deliverableFacts.label,
        derivation: deliverableFacts.derivation,
        orderIndex: deliverableFacts.orderIndex,
        value: factValues.value,
        status: factValues.status,
        sourceRef: factValues.sourceRef,
        method: factValues.method,
        fetchedAt: factValues.fetchedAt,
        flagged: factValues.flagged,
        flagReason: factValues.flagReason,
      })
      .from(factValues)
      .innerJoin(deliverableFacts, eq(factValues.factId, deliverableFacts.id))
      .where(eq(factValues.runId, run.id));
    rows.sort((a, b) => a.orderIndex - b.orderIndex || a.factKey.localeCompare(b.factKey));

    const decided = await db
      .select({ id: approvals.id, decidedByUserId: approvals.decidedByUserId, decidedAt: approvals.decidedAt })
      .from(approvals)
      .where(eq(approvals.companyId, companyId));
    const byId = new Map(decided.map((row) => [row.id, row]));
    function seat(approvalId: string | null) {
      if (!approvalId) return null;
      const row = byId.get(approvalId);
      if (!row?.decidedByUserId) return null;
      return {
        userId: row.decidedByUserId,
        at: row.decidedAt ? row.decidedAt.toISOString() : null,
      };
    }

    return {
      deliverableKey: deliverable.key,
      deliverableName: deliverable.name,
      runKey: run.runKey,
      shippedAt: run.shippedAt ? run.shippedAt.toISOString() : null,
      checkPassed: run.checkPassed,
      facts: rows.map((row) => ({
        factKey: row.factKey,
        label: row.label,
        derivation: row.derivation,
        value: row.value,
        status: row.status,
        sourceRef: row.sourceRef,
        method: row.method,
        fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
        ageSeconds: ageSecondsFrom(row.fetchedAt, now),
        flagged: row.flagged,
        flagReason: row.flagReason,
      })),
      approvals: {
        first: seat(run.firstApprovalId),
        second: seat(run.secondApprovalId),
      },
      disclaimer: DISCLAIMER,
    };
  }

  return { factRecord, latestShipped };
}
