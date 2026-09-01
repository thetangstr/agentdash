import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  deliverableChecks,
  deliverableFacts,
  deliverables,
} from "@paperclipai/db";
import type {
  CreateDeliverable,
  CreateDeliverableCheck,
  CreateDeliverableFact,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { logActivity } from "./activity-log.js";

/**
 * AgentDash-MK: the deliverable definition — the implementer's surface.
 *
 * ## Why nobody at the customer authors anything
 *
 * Self-service process capture does not work. There is no evidence of it
 * working anywhere, and every analogue that does work has a third party doing
 * the encoding — Prialto's Engagement Managers being the clearest. So the fact
 * list is produced by an implementer watching one real cycle, and the routes
 * above this service are administrator-only. That is a deliberate absence, not
 * a missing feature: shipping a customer-facing authoring surface would be
 * shipping the thing that has never worked.
 *
 * ## Why the acceptance tests live here too
 *
 * `deliverable_checks` is written on the same administrator-only path as the
 * fact list, and this is the load-bearing half of "the check is independent".
 * Running a checker on a separate execution path buys nothing if the assembling
 * agent wrote the criteria — self-certification would simply move from check
 * time to definition time, where it is invisible. So the assembler is refused
 * here, and the refusal is what the adversarial test attempts.
 */
export function deliverableService(db: Db) {
  async function requireCompanyAgent(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    // 404 rather than 400: an agent in another company must not be discoverable
    // by the shape of the refusal.
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function getByKey(companyId: string, key: string) {
    const row = await db
      .select()
      .from(deliverables)
      .where(and(eq(deliverables.companyId, companyId), eq(deliverables.key, key)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Deliverable not found");
    return row;
  }

  async function create(companyId: string, input: CreateDeliverable, byUserId: string) {
    await requireCompanyAgent(companyId, input.assemblerAgentId);

    let row: typeof deliverables.$inferSelect;
    try {
      row = await db
        .insert(deliverables)
        .values({
          companyId,
          key: input.key,
          name: input.name,
          cadence: input.cadence,
          assemblerAgentId: input.assemblerAgentId,
          firstApproverUserId: input.firstApproverUserId,
          secondApproverUserId: input.secondApproverUserId,
        })
        .returning()
        .then((rows) => rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("A deliverable with that key already exists in this workspace");
      }
      throw error;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: byUserId,
      action: "deliverable.defined",
      entityType: "deliverable",
      entityId: row.id,
      details: { key: row.key, cadence: row.cadence },
    });
    return row;
  }

  /**
   * Add one fact to the list.
   *
   * The assembler cannot own a `human` fact. The collection mechanism for those
   * is the agent-to-agent request, whose requester is always the assembler, and
   * an agent asking itself would manufacture provenance for a figure nobody
   * produced. Refused here rather than at collection time, where the run is
   * already open and the definition is already wrong.
   */
  async function addFact(companyId: string, deliverableKey: string, input: CreateDeliverableFact) {
    const deliverable = await getByKey(companyId, deliverableKey);
    await requireCompanyAgent(companyId, input.ownerAgentId);

    if (input.sourceType === "human" && input.ownerAgentId === deliverable.assemblerAgentId) {
      throw badRequest(
        "The assembling agent cannot own a human fact; it would be asking itself, " +
          "which manufactures provenance for a figure nobody produced",
      );
    }

    try {
      return await db
        .insert(deliverableFacts)
        .values({
          companyId,
          deliverableId: deliverable.id,
          key: input.key,
          label: input.label,
          sourceType: input.sourceType,
          derivation: input.derivation,
          ownerAgentId: input.ownerAgentId,
          connectorProvider: input.connectorProvider ?? null,
          connectorConfig: input.connectorConfig ?? null,
          orderIndex: input.orderIndex ?? 0,
        })
        .returning()
        .then((rows) => rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("That fact key already exists on this deliverable");
      }
      throw error;
    }
  }

  async function addCheck(
    companyId: string,
    deliverableKey: string,
    input: CreateDeliverableCheck,
  ) {
    const deliverable = await getByKey(companyId, deliverableKey);
    try {
      return await db
        .insert(deliverableChecks)
        .values({
          companyId,
          deliverableId: deliverable.id,
          key: input.key,
          kind: input.kind,
          config: input.config,
          severity: input.severity ?? "blocking",
        })
        .returning()
        .then((rows) => rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("That check key already exists on this deliverable");
      }
      throw error;
    }
  }

  async function factsFor(deliverableId: string) {
    return db
      .select()
      .from(deliverableFacts)
      .where(eq(deliverableFacts.deliverableId, deliverableId))
      .orderBy(asc(deliverableFacts.orderIndex), asc(deliverableFacts.key));
  }

  async function checksFor(deliverableId: string) {
    return db
      .select()
      .from(deliverableChecks)
      .where(eq(deliverableChecks.deliverableId, deliverableId))
      .orderBy(asc(deliverableChecks.key));
  }

  async function detail(companyId: string, key: string) {
    const deliverable = await getByKey(companyId, key);
    return {
      ...deliverable,
      facts: await factsFor(deliverable.id),
      checks: await checksFor(deliverable.id),
    };
  }

  async function list(companyId: string) {
    return db
      .select()
      .from(deliverables)
      .where(eq(deliverables.companyId, companyId))
      .orderBy(asc(deliverables.key));
  }

  return { create, addFact, addCheck, detail, list, getByKey, factsFor, checksFor };
}
