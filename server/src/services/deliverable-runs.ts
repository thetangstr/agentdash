import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentFactRequests,
  companies,
  deliverableFacts,
  deliverableRuns,
  deliverables,
  factValues,
} from "@paperclipai/db";
import type { DeliverableCadence } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { logger } from "../middleware/logger.js";
import { agentFactRequestService } from "./agent-fact-requests.js";
import { deliverableService } from "./deliverables.js";
import {
  sharepointConnectorService,
  type WorkbookTarget,
} from "./sharepoint-connector.js";
import { elapsedMsBetween, workflowEventsService } from "./workflow-events.js";

/**
 * AgentDash-MK: one cycle of a deliverable — open, collect, assemble.
 *
 * ## The collection mechanism is the product
 *
 * A fact is fetched where it exists and **asked for where it doesn't**. Nothing
 * here tries to replace how a person produces their number; a `human` fact
 * becomes one specific agent-to-agent request, which the owning agent answers,
 * declines, or escalates to its steward's own harness — and only if that machine
 * is unreachable does a person get interrupted at all.
 *
 * That is what makes retrieval-versus-reconstruction a **dial rather than a
 * precondition**. A deliverable made entirely of `human` facts still runs. It
 * costs more attention, and the measurement substrate is what says how much and
 * whether that number is falling.
 *
 * ## Why a hole is louder than an absence
 *
 * Every path that fails to produce a figure writes `missing` and `flagged` with
 * a reason. None of them writes nothing, and none of them writes a plausible
 * value. A deliverable with an unmarked hole in it gets believed; one that says
 * where the hole is gets corrected, and the second is the only shape of error
 * that survives a review slot which has shrunk from hours to minutes.
 *
 * ## Where this file deliberately stops
 *
 * It does not check anything, and it cannot. It has no import edge to the check
 * service, it never writes `checked_at`, `check_outcome`, or
 * `check_draft_hash`, and the database refuses a run in `checked` or beyond
 * without all three. Self-certification is not discouraged here; there is no
 * expression of it available.
 */

/** Pad to two digits. Used for both ISO weeks and calendar months. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The label for the period a cadence is in at an instant.
 *
 * ISO weeks, not "the week containing the 1st". A week that straddles New Year
 * belongs to the year that owns four or more of its days, so 2027-01-01 is
 * `2026-W53` — get that wrong and the scheduler opens a duplicate cycle every
 * January, which is exactly the kind of defect nobody notices until the second
 * one lands in an approver's queue.
 */
export function runKeyFor(cadence: DeliverableCadence, at: Date): string {
  if (cadence === "monthly") {
    return `${at.getUTCFullYear()}-${pad2(at.getUTCMonth() + 1)}`;
  }
  // Shift to the Thursday of this ISO week; the year of that Thursday is the
  // ISO year by definition.
  const thursday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const isoDay = thursday.getUTCDay() === 0 ? 7 : thursday.getUTCDay();
  thursday.setUTCDate(thursday.getUTCDate() + 4 - isoDay);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstIsoDay = firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay();
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstIsoDay);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${pad2(week)}`;
}

export type DeliverableRow = typeof deliverableRuns.$inferSelect;
type FactRow = typeof deliverableFacts.$inferSelect;

export function deliverableRunService(db: Db) {
  const definitions = deliverableService(db);
  const factRequests = agentFactRequestService(db);
  const sharepoint = sharepointConnectorService(db);
  const workflow = workflowEventsService(db);

  function pipelineIdFor(deliverableKey: string) {
    return `deliverable:${deliverableKey}`;
  }

  async function getRun(companyId: string, runId: string) {
    const row = await db
      .select()
      .from(deliverableRuns)
      .where(and(eq(deliverableRuns.id, runId), eq(deliverableRuns.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Deliverable run not found");
    return row;
  }

  async function deliverableForRun(run: DeliverableRow) {
    const row = await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.id, run.deliverableId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Deliverable not found");
    return row;
  }

  /**
   * Write one fact's value for one run, creating or replacing.
   *
   * There is exactly one `(run, fact)` row by unique index, so a re-collection
   * corrects rather than accumulates. Provenance columns move together with the
   * status: the database refuses a `fetched` or `answered` row that lacks them.
   */
  async function upsertValue(
    runId: string,
    companyId: string,
    factId: string,
    patch: Partial<typeof factValues.$inferInsert>,
  ) {
    const existing = await db
      .select({ id: factValues.id })
      .from(factValues)
      .where(and(eq(factValues.runId, runId), eq(factValues.factId, factId)))
      .then((rows) => rows[0] ?? null);

    if (existing) {
      await db
        .update(factValues)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(factValues.id, existing.id));
      return;
    }
    await db.insert(factValues).values({
      companyId,
      runId,
      factId,
      status: "missing",
      ...patch,
    });
  }

  function parseWorkbookConfig(
    config: Record<string, unknown> | null,
  ): { siteId: string; itemId: string; target: WorkbookTarget } | null {
    if (!config) return null;
    const siteId = typeof config.siteId === "string" ? config.siteId : null;
    const itemId = typeof config.itemId === "string" ? config.itemId : null;
    const raw = config.target as { kind?: unknown; name?: unknown } | undefined;
    const kind = typeof raw?.kind === "string" ? raw.kind : null;
    const name = typeof raw?.name === "string" ? raw.name : null;
    if (!siteId || !itemId || !name) return null;
    if (kind !== "table" && kind !== "namedRange" && kind !== "worksheet") return null;
    return { siteId, itemId, target: { kind, name } as WorkbookTarget };
  }

  /**
   * Fetch a `system` fact under the owning person's own identity.
   *
   * The connector authenticates as the fact's owner, never as an application,
   * so SharePoint answers with exactly what that person can see. A refusal —
   * for any reason, including one that looks like a configuration mistake —
   * lands the fact `missing` and `flagged`. There is deliberately no fallback
   * that returns "whatever occupies the top-left of the sheet": a wrong number
   * that looks right is far worse than an error, because the error gets fixed
   * and the number gets believed.
   */
  async function fetchSystemFact(
    run: DeliverableRow,
    deliverableKey: string,
    fact: FactRow,
  ): Promise<void> {
    const runContext = {
      pipelineId: pipelineIdFor(deliverableKey),
      runId: run.id,
      stepKey: fact.key,
    };

    if (fact.connectorProvider !== "sharepoint") {
      // An honest refusal rather than a placeholder. SharePoint is the only
      // connector this pipeline can read through today, and a fact pointed at
      // anything else is a definition that cannot be collected — which the
      // approver has to see rather than discover.
      await workflow.emit({
        ...runContext,
        companyId: run.companyId,
        eventType: "step_failed",
        actorKind: "system",
        payload: { taskClass: "read", reasonChars: (fact.connectorProvider ?? "").length },
      });
      await upsertValue(run.id, run.companyId, fact.id, {
        status: "missing",
        value: null,
        flagged: true,
        flagReason: `unsupported_connector:${fact.connectorProvider ?? "none"}`,
      });
      return;
    }

    const config = parseWorkbookConfig(fact.connectorConfig);
    if (!config) {
      await upsertValue(run.id, run.companyId, fact.id, {
        status: "missing",
        value: null,
        flagged: true,
        flagReason: "invalid_connector_target",
      });
      return;
    }

    // The connector emits its own step_completed / step_failed against this run
    // context, so the fetch is measured whether or not it succeeded.
    const result = await sharepoint.readWorkbookRange({
      companyId: run.companyId,
      agentId: fact.ownerAgentId,
      siteId: config.siteId,
      itemId: config.itemId,
      target: config.target,
      runContext,
    });

    if (!result.ok) {
      await upsertValue(run.id, run.companyId, fact.id, {
        status: "missing",
        value: null,
        flagged: true,
        flagReason: `${result.reason}: ${result.message}`,
      });
      return;
    }

    // The exact call, not a summary of it. Someone asking "where did this
    // number come from" gets the site, the item, and the resolved named target
    // that was actually read — including when a worksheet resolved to its one
    // table, because the resolution is part of the answer.
    const sourceRef =
      `sharepoint:/sites/${config.siteId}/drive/items/${config.itemId}` +
      `/workbook/${result.target.kind}/${result.target.name}` +
      (result.address ? `!${result.address}` : "");

    await upsertValue(run.id, run.companyId, fact.id, {
      status: "fetched",
      value: {
        values: result.values,
        address: result.address,
        rowCount: result.rowCount,
        columnCount: result.columnCount,
      },
      sourceRef,
      method: "connector:sharepoint:read_workbook_range",
      fetchedAt: new Date(),
      flagged: false,
      flagReason: null,
    });
  }

  /**
   * Ask the owning agent for a `human` fact.
   *
   * One ask per fact per run, enforced by the fact-request table's unique index
   * rather than by a check here — two collectors racing on the same run would
   * both find nothing and both ask. A person asked the same question three
   * times in one cycle stops answering, and this whole design is a bet on them
   * continuing to.
   */
  async function askHumanFact(
    run: DeliverableRow,
    deliverable: typeof deliverables.$inferSelect,
    fact: FactRow,
  ): Promise<void> {
    const { request } = await factRequests.ask(run.companyId, {
      requestedByAgentId: deliverable.assemblerAgentId,
      targetAgentId: fact.ownerAgentId,
      factKey: fact.key,
      runId: run.id,
      pipelineId: pipelineIdFor(deliverable.key),
      // The label and the derivation, in that order. Trigger, not automate: the
      // question tells the person which figure and how it is normally made, so
      // it prompts what they already do rather than asking them to invent a
      // method on the spot.
      question: `${fact.label}\n\n${fact.derivation}`,
    });

    await upsertValue(run.id, run.companyId, fact.id, {
      status: "asked",
      value: null,
      sourceRef: `agent_fact_request:${request.id}`,
      method: "agent_request",
      flagged: false,
      flagReason: null,
    });
  }

  /**
   * Collect every fact that does not already have a settled value.
   *
   * Re-entrant on purpose: a run that stalled on one fact can be collected
   * again without re-fetching the ones that landed, and without asking anybody
   * a second time.
   */
  async function collect(companyId: string, runId: string) {
    const run = await getRun(companyId, runId);
    if (run.status !== "collecting") {
      throw conflict("Only a collecting run can be collected");
    }
    const deliverable = await deliverableForRun(run);
    const facts = await definitions.factsFor(deliverable.id);

    for (const fact of facts) {
      const existing = await db
        .select({ status: factValues.status })
        .from(factValues)
        .where(and(eq(factValues.runId, run.id), eq(factValues.factId, fact.id)))
        .then((rows) => rows[0] ?? null);
      // `asked` is not settled, but re-asking is exactly what the dedup exists
      // to prevent, so it is skipped here and reconciled at assembly.
      if (existing && existing.status !== null) continue;

      if (fact.sourceType === "system") {
        await fetchSystemFact(run, deliverable.key, fact);
      } else {
        await askHumanFact(run, deliverable, fact);
      }
    }

    return { runId: run.id, factCount: facts.length };
  }

  /**
   * Open the cycle for a period, or return the one already open.
   *
   * Idempotent by unique index rather than by check-then-insert: two schedulers
   * ticking together would both find nothing and both open a run, and a
   * duplicate cycle means a person is asked for the same figure twice.
   */
  async function openRun(
    companyId: string,
    deliverableKey: string,
    opts: { at?: Date } = {},
  ): Promise<{ run: DeliverableRow; opened: boolean }> {
    const deliverable = await definitions.getByKey(companyId, deliverableKey);
    const runKey = runKeyFor(deliverable.cadence as DeliverableCadence, opts.at ?? new Date());

    let run: DeliverableRow;
    try {
      run = await db
        .insert(deliverableRuns)
        .values({ companyId, deliverableId: deliverable.id, runKey })
        .returning()
        .then((rows) => rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await db
          .select()
          .from(deliverableRuns)
          .where(
            and(
              eq(deliverableRuns.deliverableId, deliverable.id),
              eq(deliverableRuns.runKey, runKey),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (existing) return { run: existing, opened: false };
      }
      throw error;
    }

    await collect(companyId, run.id);
    return { run: await getRun(companyId, run.id), opened: true };
  }

  /**
   * Reconcile the outstanding asks and, if nothing is still open, assemble.
   *
   * Pull rather than push: the fact-request rows are read here rather than
   * pushed into `fact_values` when they settle. A push would need a hook on
   * every terminal transition of that table — answer, decline, lease sweep,
   * filter release, filter discard — and the one nobody wired would be a figure
   * that silently never arrived.
   */
  async function assemble(companyId: string, runId: string) {
    const run = await getRun(companyId, runId);
    if (run.status !== "collecting" && run.status !== "assembled") {
      throw conflict("Only a collecting run can be assembled");
    }
    const deliverable = await deliverableForRun(run);
    const facts = await definitions.factsFor(deliverable.id);
    const requests = await db
      .select()
      .from(agentFactRequests)
      .where(
        and(
          eq(agentFactRequests.companyId, companyId),
          eq(agentFactRequests.runId, run.id),
        ),
      );
    const requestByKey = new Map(requests.map((row) => [row.factKey, row]));

    const pending: string[] = [];
    for (const fact of facts) {
      const value = await db
        .select()
        .from(factValues)
        .where(and(eq(factValues.runId, run.id), eq(factValues.factId, fact.id)))
        .then((rows) => rows[0] ?? null);
      if (!value || value.status !== "asked") continue;

      const ask = requestByKey.get(fact.key);
      if (!ask) {
        // The value says it was asked and no ask exists. Refusing to guess: the
        // approver sees a hole with a reason on it.
        await upsertValue(run.id, companyId, fact.id, {
          status: "missing",
          value: null,
          flagged: true,
          flagReason: "ask_not_found",
        });
        continue;
      }

      if (ask.status === "answered" && ask.answer) {
        await upsertValue(run.id, companyId, fact.id, {
          status: "answered",
          // Stored framed, exactly as it left the fact request. A deliverable
          // is not a place where an answer stops having come from another
          // agent, and the frame is what tells whatever reads it next.
          value: { text: ask.answer },
          sourceRef: `agent_fact_request:${ask.id}`,
          method: `agent_answer:${ask.answerSourceKind ?? "unknown"}`,
          fetchedAt: ask.answeredAt ?? new Date(),
          answeredByAgentId: ask.answeredByAgentId,
          answeredAt: ask.answeredAt,
          flagged: false,
          flagReason: null,
        });
        continue;
      }

      if (ask.status === "declined" || ask.status === "missing") {
        await upsertValue(run.id, companyId, fact.id, {
          status: "missing",
          value: null,
          flagged: true,
          flagReason:
            ask.status === "declined"
              ? `declined: ${ask.declineReason ?? "no reason given"}`
              : "missing: the escalation lease lapsed with no answer",
        });
        continue;
      }

      // asked, escalated, or held. The run waits — stalling is acceptable; this
      // system does not have to run twenty-four hours.
      pending.push(fact.key);
    }

    if (pending.length > 0) {
      return { assembled: false as const, runId: run.id, pending: pending.sort() };
    }

    const now = new Date();
    if (run.status === "collecting") {
      await db
        .update(deliverableRuns)
        .set({ status: "assembled", assembledAt: now, updatedAt: now })
        // Conditional on the run still collecting, so two assemblers racing
        // cannot both claim the transition.
        .where(and(eq(deliverableRuns.id, run.id), eq(deliverableRuns.status, "collecting")))
        .returning();

      await workflow.emit({
        companyId,
        pipelineId: pipelineIdFor(deliverable.key),
        runId: run.id,
        stepKey: "assemble",
        eventType: "step_completed",
        actorKind: "agent",
        durationMs: elapsedMsBetween(run.openedAt, now),
        payload: { taskClass: "read" },
      });
    }

    return { assembled: true as const, runId: run.id, pending: [] as string[] };
  }

  /** The run, its values, and the provenance of each. */
  async function detail(companyId: string, runId: string) {
    const run = await getRun(companyId, runId);
    const deliverable = await deliverableForRun(run);
    const facts = await definitions.factsFor(deliverable.id);
    const values = await db
      .select()
      .from(factValues)
      .where(eq(factValues.runId, run.id));
    const byFactId = new Map(values.map((row) => [row.factId, row]));

    return {
      id: run.id,
      deliverableKey: deliverable.key,
      deliverableName: deliverable.name,
      runKey: run.runKey,
      status: run.status,
      openedAt: run.openedAt.toISOString(),
      assembledAt: run.assembledAt ? run.assembledAt.toISOString() : null,
      checkedAt: run.checkedAt ? run.checkedAt.toISOString() : null,
      checkPassed: run.checkPassed,
      values: facts.map((fact) => {
        const value = byFactId.get(fact.id) ?? null;
        return {
          factKey: fact.key,
          label: fact.label,
          derivation: fact.derivation,
          sourceType: fact.sourceType,
          value: value?.value ?? null,
          provenance: {
            status: value?.status ?? "missing",
            sourceRef: value?.sourceRef ?? null,
            method: value?.method ?? null,
            fetchedAt: value?.fetchedAt ? value.fetchedAt.toISOString() : null,
            answeredByAgentId: value?.answeredByAgentId ?? null,
            answeredAt: value?.answeredAt ? value.answeredAt.toISOString() : null,
            flagged: value?.flagged ?? false,
            flagReason: value?.flagReason ?? null,
            appliedCorrectionId: value?.appliedCorrectionId ?? null,
          },
        };
      }),
    };
  }

  /**
   * Open every cycle that is due and has not been opened.
   *
   * Called on a timer from the server entry point. Doing nothing is the normal
   * outcome: the unique index means a re-tick within the same period is a
   * no-op, so the frequency of the tick does not have to be tuned against the
   * cadence.
   */
  async function sweepDueDeliverableRuns(at: Date = new Date()) {
    const due = await db
      .select({
        companyId: deliverables.companyId,
        key: deliverables.key,
      })
      .from(deliverables)
      .innerJoin(companies, eq(companies.id, deliverables.companyId))
      .where(
        and(
          eq(deliverables.status, "active"),
          // Profile-scoped, so a default-profile company's behaviour is
          // unchanged: no runs appear for a pipeline it does not have.
          eq(companies.productProfile, "agentdash_mk"),
        ),
      );

    let opened = 0;
    for (const row of due) {
      try {
        const result = await openRun(row.companyId, row.key, { at });
        if (result.opened) opened += 1;
      } catch (error) {
        // Logged rather than thrown: one deliverable whose connector is
        // misconfigured must not stop every other company's cycle from opening.
        logger.error(
          { err: error, companyId: row.companyId, deliverableKey: row.key },
          "[deliverables] opening a due run failed",
        );
      }
    }
    return { opened, considered: due.length };
  }

  return {
    openRun,
    collect,
    assemble,
    detail,
    getRun,
    deliverableForRun,
    sweepDueDeliverableRuns,
    pipelineIdFor,
  };
}
