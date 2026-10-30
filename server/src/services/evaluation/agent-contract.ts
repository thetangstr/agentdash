import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { evaluationEvents } from "@paperclipai/db";
import {
  EVALUATION_CONTRACT_V2_VERSION,
  evaluationContractV2Schema,
  type AgentOperatingProfileV1,
  type EvaluationContractV2,
} from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import { insertActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { withCompanyLock } from "./ingest.js";
import { dedupeKeyFor, evaluationLedger, type EvaluationEventInput } from "./ledger.js";
import { INDEPENDENCE_RULE } from "./scoring/independence.js";

/**
 * AgentDash: Agent Performance Management gate 2 — the agent contract
 * (evaluation LLD §2–3; gate 2 spec P2.4).
 *
 * P2.2 calls `declareAgentContract` as application step (f) `contract`.
 *
 * Gate 2 DECLARES the contract; scoring the agent subject is gate 3. The
 * event is a `contract.declared` ledger append with source id
 * `agent:<agentId>`, through the same append path, company lock and dedupe as
 * `POST /companies/:companyId/evaluation/contracts`. Milestone (V1) contracts
 * and their scoring are unchanged — and the milestone resolver skips a `v2`
 * payload rather than counting it as an invalid milestone contract
 * (`scoring/contract.ts`, `evaluationContractVersionOf`).
 */

/** The ledger `source_id` of an agent's contract events. */
export function agentContractSourceId(agentId: string): string {
  return `agent:${agentId}`;
}

/** Same `source_table` as milestone contracts: one place in the ledger holds every declared contract. */
const CONTRACT_SOURCE_TABLE = "evaluation_contracts";

/**
 * The dedupe key's version part. Keyed by the revision, not by the contract's
 * hash, so the contract is idempotent PER PROFILE REVISION: a resumed
 * application whose accountable user changed in between still finds the event
 * the first attempt wrote instead of declaring a second contract for the same
 * revision.
 */
function agentContractSourceVersion(profileRevisionId: string): string {
  return `revision:${profileRevisionId}`;
}

export interface DeclareAgentContractInput {
  companyId: string;
  agentId: string;
  /** The revision being applied; the contract is idempotent per revision. */
  profileRevisionId: string;
  body: AgentOperatingProfileV1;
  /** The agent's accountable user at application time. */
  accountableUserId: string | null;
  /** Attributed actor for the ledger event (the approver, for an application). */
  actor: { actorType: "user" | "agent" | "system"; actorId: string };
}

/**
 * The V2 contract for a revision: one entry per responsibility, carrying its
 * `performance` contract under its `key`. Pure; the result parses with
 * `evaluationContractV2Schema` (it throws a 422 when the body cannot form one,
 * which the profile validator should already have prevented).
 */
export function buildAgentContractV2(input: Omit<DeclareAgentContractInput, "actor">): EvaluationContractV2 {
  const candidate = {
    contractVersion: EVALUATION_CONTRACT_V2_VERSION,
    companyId: input.companyId,
    subjectRef: { kind: "agent" as const, id: input.agentId },
    accountableUserId: input.accountableUserId,
    profileRevisionId: input.profileRevisionId,
    independenceRule: INDEPENDENCE_RULE,
    responsibilities: input.body.responsibilities.map((responsibility) => ({
      key: responsibility.key,
      ...responsibility.performance,
    })),
  };
  const parsed = evaluationContractV2Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new HttpError(422, "The profile revision does not form a valid agent contract", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** Lock retries: an ingest pass holds the company lock briefly; an application step should wait for it, not fail. */
const LOCK_RETRY_DELAYS_MS = [100, 300, 900];

function isLockBusy(err: unknown): boolean {
  return err instanceof HttpError && err.status === 409 && err.message.startsWith("evaluation_ingest:");
}

/**
 * Append `contract.declared` for `subjectRef: { kind: "agent", id: agentId }`.
 * Idempotent per profile revision: a second call for the same revision
 * inserts nothing and returns the existing event id (`inserted: false`).
 *
 * The event and its `evaluation.contract_declared` activity row are written in
 * one transaction under the company's evaluator lock (the lock `POST
 * /contracts`, ingest and snapshots share), so the seq order of the ledger is
 * preserved. A busy lock (an ingest pass) is retried briefly; if it stays
 * busy the 409 propagates and the application step can be resumed.
 */
export async function declareAgentContract(
  db: Db,
  input: DeclareAgentContractInput,
): Promise<{ eventId: string; inserted: boolean }> {
  const contract = buildAgentContractV2(input);
  const event: EvaluationEventInput = {
    companyId: input.companyId,
    // Not a milestone fact: no project or goal scope, so milestone membership never picks it up.
    projectId: null,
    goalId: null,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    sourceTable: CONTRACT_SOURCE_TABLE,
    sourceId: agentContractSourceId(input.agentId),
    sourceVersion: agentContractSourceVersion(input.profileRevisionId),
    eventType: "contract.declared",
    eventTime: new Date(),
    payload: { contract, companyId: input.companyId },
  };
  const dedupeKey = dedupeKeyFor(event);

  const attempt = () =>
    withCompanyLock(db, input.companyId, async (tx) => {
      const result = await evaluationLedger(tx).append([event]);
      const insertedId = result.insertedIds[0] ?? null;
      if (!insertedId) {
        const [existing] = await tx
          .select({ id: evaluationEvents.id })
          .from(evaluationEvents)
          .where(and(eq(evaluationEvents.companyId, input.companyId), eq(evaluationEvents.dedupeKey, dedupeKey)))
          .limit(1);
        if (!existing) throw new Error("agent contract: the dedupe key collided but no event carries it");
        return { eventId: existing.id, inserted: false, publication: null as ActivityPublication | null };
      }
      const publication = await insertActivity(tx as unknown as Db, {
        companyId: input.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        action: "evaluation.contract_declared",
        entityType: "agent",
        entityId: input.agentId,
        agentId: input.agentId,
        details: {
          contractVersion: contract.contractVersion,
          eventId: insertedId,
          profileRevisionId: input.profileRevisionId,
          responsibilities: contract.responsibilities.length,
          criteria: contract.responsibilities.reduce((total, responsibility) => total + responsibility.criteria.length, 0),
        },
      });
      return { eventId: insertedId, inserted: true, publication };
    });

  for (let tries = 0; ; tries++) {
    try {
      const { eventId, inserted, publication } = await attempt();
      if (publication) publishActivity(publication);
      return { eventId, inserted };
    } catch (err) {
      const delay = LOCK_RETRY_DELAYS_MS[tries];
      if (!isLockBusy(err) || delay === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
