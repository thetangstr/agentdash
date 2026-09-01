import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  deliverableChecks,
  deliverableFacts,
  deliverableRuns,
  deliverables,
  factValues,
} from "@paperclipai/db";
import type {
  DeliverableCheckKind,
  DeliverableCheckOutcome,
  DeliverableCheckSeverity,
  DeliverableReliabilityScore,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { elapsedMsBetween, workflowEventsService } from "./workflow-events.js";

/**
 * AgentDash-MK: the check that cannot certify the thing that produced the draft.
 *
 * ## What this file is defending against
 *
 * Not agent error. **Reviewer capitulation.** The documented way agent
 * deployments fail is that review slots collapse from hours to minutes and the
 * reviewer quietly stops catching things — so the approval keeps arriving and
 * stops meaning anything. An independent check is the only mitigation that
 * survives that, and it is only independent if self-certification is
 * structurally impossible rather than discouraged.
 *
 * ## The four mechanisms, none of which is a prompt
 *
 * 1. **The assembler cannot author the criteria.** `deliverable_checks` is
 *    written on the implementer-only path. Without this, running the checker
 *    elsewhere would buy nothing: self-certification would move to definition
 *    time, where nothing downstream could see it.
 * 2. **No import edge to assembly, in either direction.** This file talks to
 *    the database, never to `deliverable-runs.ts`, so it cannot be handed the
 *    assembler's in-memory draft instead of reading what was persisted. A test
 *    reads both sources and fails if either edge appears.
 * 3. **A digest of exactly what was read.** `check_draft_hash` is recomputed
 *    from the persisted values at the moment the check runs. A figure that
 *    moves afterwards leaves a run whose stored digest no longer matches its
 *    own values, and the review surface refuses to present it. The assembler
 *    cannot re-derive the digest, because writing it is the check's act.
 * 4. **A database constraint.** `deliverable_runs_checked_has_verdict_ck`
 *    refuses `checked` or beyond without all three of the check's artifacts, so
 *    the state cannot be reached by anything that did not check.
 *
 * ## Why there is no `custom` evaluator
 *
 * A custom predicate needs either an expression language nobody has specified
 * or a model, and a model asked "does this look right" is a second opinion
 * rather than a check — the thing it inspects is the thing that would have to
 * be wrong. What remains is a check that always passes, which is worthless, or
 * one that always fails, which is noise that trains an approver to scroll past
 * everything including the real failures. So `custom` is not authorable and the
 * evaluator treats it as an unmet criterion.
 */

/** The projection the digest is taken over. Deliberately not the whole row. */
export type DraftDigestRow = {
  factKey: string;
  status: string;
  value: unknown;
  sourceRef: string | null;
};

/**
 * A digest of the draft the check actually read.
 *
 * Sorted by fact key and serialized deterministically, so the digest is a
 * property of the figures rather than of the order a query happened to return
 * them in — otherwise it would change for reasons that are not changes, and a
 * verdict that spuriously invalidates is a verdict people learn to override.
 *
 * `sourceRef` is inside the digest as well as the value: the same number read
 * from a different place is a different fact about the week, and the check
 * approved one of them.
 */
export function computeDraftHash(rows: DraftDigestRow[]): string {
  const canonical = rows
    .slice()
    .sort((a, b) => a.factKey.localeCompare(b.factKey))
    .map((row) => ({
      factKey: row.factKey,
      status: row.status,
      sourceRef: row.sourceRef,
      value: row.value === undefined ? null : row.value,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

type CheckRow = typeof deliverableChecks.$inferSelect;

/** One fact's persisted state, as the check sees it. */
type DraftFact = {
  factKey: string;
  status: string;
  value: unknown;
  sourceRef: string | null;
  flagged: boolean;
  flagReason: string | null;
};

/**
 * Address a number inside a figure, or refuse.
 *
 * A bare number is itself. A tabular value needs `at: {row, column}` in the
 * check's own configuration, and without it the check FAILS rather than going
 * looking for the first number it can find. That heuristic is the `usedRange`
 * mistake one layer up: it returns whatever happens to be there, and a wrong
 * number that looks right is far worse than an error because the error gets
 * fixed and the number gets believed.
 */
function addressNumber(
  value: unknown,
  at: { row?: unknown; column?: unknown } | undefined,
): { ok: true; value: number } | { ok: false; detail: string } {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value };
  }
  const table = (value as { values?: unknown } | null)?.values;
  if (!Array.isArray(table)) {
    return { ok: false, detail: "the figure is not addressable as a number" };
  }
  const row = typeof at?.row === "number" ? at.row : null;
  const column = typeof at?.column === "number" ? at.column : null;
  if (row === null || column === null) {
    return {
      ok: false,
      detail:
        "the figure is a table and this check names no cell, so it is not " +
        "addressable as a number; add `at: { row, column }` rather than letting the check guess",
    };
  }
  const cell = (table[row] as unknown[] | undefined)?.[column];
  if (typeof cell !== "number" || !Number.isFinite(cell)) {
    return {
      ok: false,
      detail: `the cell at row ${row}, column ${column} is not addressable as a number`,
    };
  }
  return { ok: true, value: cell };
}

export function deliverableCheckService(db: Db) {
  const workflow = workflowEventsService(db);

  async function runRow(companyId: string, runId: string) {
    const row = await db
      .select()
      .from(deliverableRuns)
      .where(and(eq(deliverableRuns.id, runId), eq(deliverableRuns.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Deliverable run not found");
    return row;
  }

  /**
   * The draft, read from the database rather than received.
   *
   * This is mechanism 2 made concrete: whatever the assembler holds in memory
   * is not what gets checked. What gets checked is what was persisted, which is
   * also what the approver will read.
   */
  async function draftFor(runId: string): Promise<DraftFact[]> {
    const rows = await db
      .select({
        factKey: deliverableFacts.key,
        status: factValues.status,
        value: factValues.value,
        sourceRef: factValues.sourceRef,
        flagged: factValues.flagged,
        flagReason: factValues.flagReason,
      })
      .from(factValues)
      .innerJoin(deliverableFacts, eq(factValues.factId, deliverableFacts.id))
      .where(eq(factValues.runId, runId));
    return rows;
  }

  /** The last run of the same deliverable that actually shipped. */
  async function priorShippedDraft(
    deliverableId: string,
    excludeRunId: string,
  ): Promise<Map<string, DraftFact> | null> {
    const prior = await db
      .select({ id: deliverableRuns.id })
      .from(deliverableRuns)
      .where(
        and(
          eq(deliverableRuns.deliverableId, deliverableId),
          isNotNull(deliverableRuns.shippedAt),
          ne(deliverableRuns.id, excludeRunId),
        ),
      )
      .orderBy(desc(deliverableRuns.shippedAt))
      .then((rows) => rows[0] ?? null);
    if (!prior) return null;
    const draft = await draftFor(prior.id);
    return new Map(draft.map((row) => [row.factKey, row]));
  }

  function evaluate(
    check: CheckRow,
    draft: Map<string, DraftFact>,
    prior: Map<string, DraftFact> | null,
  ): DeliverableCheckOutcome {
    const config = (check.config ?? {}) as Record<string, unknown>;
    const factKey = typeof config.factKey === "string" ? config.factKey : null;
    const base = {
      checkKey: check.key,
      kind: check.kind as DeliverableCheckKind,
      severity: check.severity as DeliverableCheckSeverity,
      factKey,
    };

    if (!factKey) {
      return { ...base, passed: false, detail: "this check names no fact" };
    }
    const value = draft.get(factKey);
    if (!value) {
      return { ...base, passed: false, detail: `no value was collected for "${factKey}"` };
    }

    if (check.kind === "missing") {
      if (value.status === "missing") {
        return {
          ...base,
          passed: false,
          detail: `"${factKey}" is missing this cycle: ${value.flagReason ?? "no reason recorded"}`,
        };
      }
      if (value.flagged) {
        return {
          ...base,
          passed: false,
          detail: `"${factKey}" arrived flagged: ${value.flagReason ?? "no reason recorded"}`,
        };
      }
      return { ...base, passed: true, detail: `"${factKey}" is present and unflagged` };
    }

    if (check.kind === "range") {
      const addressed = addressNumber(value.value, config.at as { row?: unknown; column?: unknown });
      if (!addressed.ok) {
        return { ...base, passed: false, detail: `"${factKey}": ${addressed.detail}` };
      }
      const min = typeof config.min === "number" ? config.min : Number.NEGATIVE_INFINITY;
      const max = typeof config.max === "number" ? config.max : Number.POSITIVE_INFINITY;
      if (addressed.value < min) {
        return {
          ...base,
          passed: false,
          detail: `"${factKey}" is ${addressed.value}, below the floor of ${min}`,
        };
      }
      if (addressed.value > max) {
        return {
          ...base,
          passed: false,
          detail: `"${factKey}" is ${addressed.value}, above the ceiling of ${max}`,
        };
      }
      return {
        ...base,
        passed: true,
        detail: `"${factKey}" is ${addressed.value}, within ${min}–${max}`,
      };
    }

    if (check.kind === "moved_more_than" || check.kind === "matches_prior") {
      const before = prior?.get(factKey) ?? null;
      if (!before) {
        // A first cycle has nothing to compare against. Failing it would make
        // every new deliverable fail its own first run, which trains whoever
        // reads the result to ignore the first one — and then the second.
        return {
          ...base,
          passed: true,
          detail: `no prior shipped run to compare "${factKey}" against`,
        };
      }

      if (check.kind === "matches_prior") {
        const same = JSON.stringify(before.value ?? null) === JSON.stringify(value.value ?? null);
        return same
          ? { ...base, passed: true, detail: `"${factKey}" is unchanged from the last shipped run` }
          : { ...base, passed: false, detail: `"${factKey}" changed from the last shipped run` };
      }

      const now = addressNumber(value.value, config.at as { row?: unknown; column?: unknown });
      const then = addressNumber(before.value, config.at as { row?: unknown; column?: unknown });
      if (!now.ok) return { ...base, passed: false, detail: `"${factKey}": ${now.detail}` };
      if (!then.ok) {
        return { ...base, passed: false, detail: `the prior "${factKey}": ${then.detail}` };
      }
      const percent = typeof config.percent === "number" ? config.percent : 0;
      if (then.value === 0) {
        // A percentage against zero is undefined, not infinite. Saying so is
        // more useful than a verdict computed from a division nobody meant.
        return {
          ...base,
          passed: false,
          detail: `the prior "${factKey}" was 0, so a percentage move is undefined`,
        };
      }
      const moved = Math.abs((now.value - then.value) / then.value) * 100;
      return moved > percent
        ? {
            ...base,
            passed: false,
            detail: `"${factKey}" moved ${moved.toFixed(1)}% (${then.value} → ${now.value}), over the ${percent}% limit`,
          }
        : {
            ...base,
            passed: true,
            detail: `"${factKey}" moved ${moved.toFixed(1)}%, within the ${percent}% limit`,
          };
    }

    // `custom`, which is not authorable. Reached only by a row written outside
    // the routes, and treated as unmet rather than as a pass — an unevaluable
    // criterion is not a satisfied one.
    return {
      ...base,
      passed: false,
      detail: "this check has no evaluator; it cannot be satisfied by anything",
    };
  }

  /**
   * Check one assembled run.
   *
   * Refuses anything that is not `assembled`: checking a draft that is still
   * collecting would certify figures that are about to change, and re-checking
   * one that already has a verdict would let a failing run be retried until it
   * passed.
   */
  async function runChecks(companyId: string, runId: string) {
    const run = await runRow(companyId, runId);
    if (run.status !== "assembled") {
      throw conflict("Only an assembled run can be checked");
    }

    const declared = await db
      .select()
      .from(deliverableChecks)
      .where(eq(deliverableChecks.deliverableId, run.deliverableId));
    const draftRows = await draftFor(run.id);
    const draft = new Map(draftRows.map((row) => [row.factKey, row]));
    const prior = await priorShippedDraft(run.deliverableId, run.id);

    const outcome = declared.map((check) => evaluate(check, draft, prior));
    // Only blocking failures stop a run. An advisory failure is a flag the
    // first approver sees — a review surface that shows twenty items every week
    // is a review surface people stop reading, and then a blocking failure
    // scrolls past with the rest.
    const passed = outcome.every((entry) => entry.passed || entry.severity === "advisory");
    const draftHash = computeDraftHash(draftRows);

    const now = new Date();
    const updated = await db
      .update(deliverableRuns)
      .set({
        status: "checked",
        checkedAt: now,
        checkPassed: passed,
        checkOutcome: outcome as unknown as Record<string, unknown>[],
        checkDraftHash: draftHash,
        updatedAt: now,
      })
      // Conditional on the run still being assembled, so two sweeps racing
      // cannot both write a verdict.
      .where(and(eq(deliverableRuns.id, run.id), eq(deliverableRuns.status, "assembled")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw conflict("The run was checked by something else first");

    const deliverable = await db
      .select({ key: deliverables.key })
      .from(deliverables)
      .where(eq(deliverables.id, run.deliverableId))
      .then((rows) => rows[0] ?? null);

    await workflow.emit({
      companyId,
      pipelineId: `deliverable:${deliverable?.key ?? "unknown"}`,
      runId: run.id,
      stepKey: "check",
      // The check is machinery. Recording the assembling agent here would put a
      // person one join away from a measurement.
      eventType: passed ? "step_completed" : "step_failed",
      actorKind: "system",
      durationMs: elapsedMsBetween(run.assembledAt ?? run.openedAt, now),
      payload: passed
        ? { taskClass: "check", resultChars: JSON.stringify(outcome).length }
        : { taskClass: "check", reasonChars: JSON.stringify(outcome).length },
    });

    return { runId: run.id, passed, outcome, draftHash };
  }

  /**
   * Has anything moved since the check read it?
   *
   * The review and approval surfaces call this before presenting or shipping.
   * A false here means the verdict on the run describes figures that are no
   * longer in it, which is the exact shape self-certification-by-later-edit
   * would take.
   */
  async function verifyDraftUnchanged(companyId: string, runId: string) {
    const run = await runRow(companyId, runId);
    const actual = computeDraftHash(await draftFor(run.id));
    return {
      unchanged: Boolean(run.checkDraftHash) && run.checkDraftHash === actual,
      expected: run.checkDraftHash,
      actual,
    };
  }

  /**
   * Check every run that has been assembled and not yet checked.
   *
   * The ordinary caller. An implementer route exists too, but the assembling
   * agent has neither — the party being checked does not operate the checker.
   */
  async function sweepAssembledRuns() {
    const assembled = await db
      .select({ id: deliverableRuns.id, companyId: deliverableRuns.companyId })
      .from(deliverableRuns)
      .where(eq(deliverableRuns.status, "assembled"));

    let checked = 0;
    for (const row of assembled) {
      try {
        await runChecks(row.companyId, row.id);
        checked += 1;
      } catch (error) {
        // One run whose check throws must not stop every other company's from
        // being checked.
        logger.error({ err: error, runId: row.id }, "[deliverables] check failed");
      }
    }
    return { checked, considered: assembled.length };
  }

  /**
   * `pass^k`, with `pass@k` beside it.
   *
   * 75% per run over three cycles is 42%, and reporting the second number as if
   * it were the first is how a system that does not work looks like one that
   * does. Both are returned so they can be read next to each other.
   *
   * Advisory checks are excluded from the rate. They are flags for a reviewer,
   * not acceptance criteria, and counting them would make the score a function
   * of how chatty the definition is.
   */
  async function scoreDeliverable(
    companyId: string,
    deliverableKey: string,
    cycles: number,
  ): Promise<DeliverableReliabilityScore> {
    const deliverable = await db
      .select({ id: deliverables.id })
      .from(deliverables)
      .where(and(eq(deliverables.companyId, companyId), eq(deliverables.key, deliverableKey)))
      .then((rows) => rows[0] ?? null);
    if (!deliverable) throw notFound("Deliverable not found");

    const recent = await db
      .select({ checkOutcome: deliverableRuns.checkOutcome })
      .from(deliverableRuns)
      .where(
        and(
          eq(deliverableRuns.deliverableId, deliverable.id),
          isNotNull(deliverableRuns.checkedAt),
        ),
      )
      .orderBy(desc(deliverableRuns.checkedAt))
      .limit(Math.max(1, cycles));

    // Oldest first, so the array reads as the history it is.
    const perRunPassRate = recent
      .slice()
      .reverse()
      .map((row) => {
        const outcome = (row.checkOutcome ?? []) as unknown as DeliverableCheckOutcome[];
        const blocking = outcome.filter((entry) => entry.severity !== "advisory");
        if (blocking.length === 0) return 1;
        return blocking.filter((entry) => entry.passed).length / blocking.length;
      });

    return {
      deliverableKey,
      cycles: perRunPassRate.length,
      perRunPassRate,
      passPowK: perRunPassRate.reduce((product, rate) => product * rate, 1),
      passAtK: 1 - perRunPassRate.reduce((product, rate) => product * (1 - rate), 1),
      runsFullyPassed: perRunPassRate.filter((rate) => rate === 1).length,
    };
  }

  return { runChecks, verifyDraftUnchanged, sweepAssembledRuns, scoreDeliverable, draftFor };
}
