import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, deliverableRuns, evaluationEvents, evaluationScorecards, issues } from "@paperclipai/db";
import {
  AGENT_CARD_SCORECARD_KIND,
  AGENT_CARD_VERSION,
  AGENT_CASE_FILTER_NONE,
  AGENT_METRICS_VERSION,
  EVALUATION_ADVISORY_EVENT_TYPES,
  evaluationCriterionRefKey,
  normalizeAgentUrlKey,
  type AgentCardDependencyCitation,
  type AgentCardSectionView,
  type AgentCardSnapshotResult,
  type AgentCardStoredSection,
  type AgentCardSummary,
  type AgentCardV1,
  type AgentCardVerifyResult,
  type AgentCardVersionSummary,
  type AgentCardView,
  type AgentCardViewerPermissions,
  type AgentCaseFilter,
  type AgentCaseList,
  type AgentCaseRow,
  type AgentPerformanceWindow,
  type EvaluationAccessClass,
  type EvaluationAgentDisposition,
  type EvaluationContractV2,
  type EvaluationCriterionRef,
  type EvaluationMilestoneRef,
} from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import { agentAccountabilityService } from "../agent-accountability.js";
import { viewerClassFilter, viewerReadsClass, type EvaluationViewer } from "./access-class.js";
import { agentContractOf } from "./agent-obligations.js";
import {
  accountableMilestoneRefs,
  agentCardHash,
  agentCardsEquivalent,
  agentCaseRows,
  milestoneDependencyRowIds,
  scoreAgent,
  type AgentCardDependencyInput,
} from "./agent-scoring.js";
import { criterionToken, selectCalibrationSample, syncCalibrationReviewItems, type CalibrationSampleItem } from "./calibration.js";
import { withCompanyLock } from "./ingest.js";
import { evaluationLedger, hashCanonical, orderEvents, type EvaluationEventInput, type EvaluationEventRow, type LedgerDb } from "./ledger.js";
import { evaluationReplay } from "./replay.js";
import { cardHash, FORMULA_VERSION as MILESTONE_FORMULA_VERSION, openFromLedger, scoreMilestone } from "./scoring/card.js";
import { buildTimeline } from "./scoring/timeline.js";

/**
 * AgentDash: Agent Performance Management gate 3 — stored agent cards
 * (evaluation LLD §2, §6.1, §11–§12). P3.1 froze the signatures; P3.3
 * implements them and the routes in `routes/evaluation-agents.ts`.
 *
 * Storage: `evaluation_scorecards` with `milestone_kind = 'agent'`
 * (`AGENT_CARD_SCORECARD_KIND`), `milestone_id = agentId`, `contract_version`
 * `v2` or `none`, `formula_version = AGENT_METRICS_VERSION`, `card_hash =
 * agentCardHash(card)`. Cards are computed from every access class and are
 * NEVER served raw: every read returns an `AgentCardView` for the viewer
 * (`AgentCardView` says how). Milestone scorecards are untouched.
 *
 * The cut. A card is cut at the newest ledger row that is not the
 * evaluator's own output (`actor_type <> 'evaluator'`): the findings a
 * snapshot appends are not inputs to any agent card, so a second snapshot
 * with no new source facts finds the same cut and reuses the version.
 *
 * P3.3 change to the frozen signatures (additive): `listAgentCards` takes an
 * optional `{ visibleAgentIds }` (agent visibility is a request-level rule the
 * evaluation viewer does not carry).
 */

/** A drill-down row before the class filter. `accessClasses` decide visibility and are never served. */
export interface StoredAgentCase extends AgentCaseRow {
  accessClasses: EvaluationAccessClass[];
}

// P3.7: the snapshot and verify results are shared types (the UI reads them as they are).
export type { AgentCardSnapshotResult, AgentCardVerifyResult } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Who may act on a card: the guards the routes apply, also used for the
// card view's `viewer` flags (P3.7) so the two never differ.
// ---------------------------------------------------------------------------

/** The caller as the card guards see it. Built by the route from the request. */
export interface AgentCardActor {
  /** A person (board actor). Agents read no cards and record no dispositions. */
  person: boolean;
  userId: string | null;
  /** `isCompanyAdministrator` (local implicit board and instance admins included): the snapshot/verify guard. */
  companyAdmin: boolean;
  /** `seesEverything || isCompanyAdministrator`: the dispositions guard. */
  dispositionAdmin: boolean;
}

/** Snapshot and verify: a company admin, or the agent's accountable person (the agent record or resolved accountability). */
export function agentCardSnapshotAllowed(actor: AgentCardActor, accountable: { agentUserId: string | null; resolvedUserId: string | null }): boolean {
  if (!actor.person) return false;
  if (actor.companyAdmin) return true;
  return !!actor.userId && (actor.userId === accountable.agentUserId || actor.userId === accountable.resolvedUserId);
}

/** `disagreement_noted`: an admin or the accountable person of the agent's contract (the agent record when the contract names none). */
export function agentDisagreementAllowed(actor: AgentCardActor, accountableUserId: string | null): boolean {
  if (!actor.person) return false;
  return actor.dispositionAdmin || (!!actor.userId && actor.userId === accountableUserId);
}

/**
 * The people a declared criterion names as its attester: the `human_attest`
 * check's person and the responsibility's human judge. Null when the tuple
 * names no criterion of `contract` (unknown key or id, or a changed check).
 */
export function namedAttestersOf(contract: EvaluationContractV2 | null, criterion: EvaluationCriterionRef): Set<string> | null {
  const responsibility = contract?.responsibilities.find((r) => r.key === criterion.responsibilityKey) ?? null;
  const declared = responsibility?.criteria.find((c) => c.id === criterion.criterionId) ?? null;
  if (!responsibility || !declared || hashCanonical({ check: declared.check ?? null }).slice(0, 16) !== criterion.checkHash) return null;
  const named = new Set<string>();
  if (declared.check?.kind === "human_attest") named.add(declared.check.attesterUserId);
  if (responsibility.judges.human) named.add(responsibility.judges.human.userId);
  return named;
}

/** No action at all: an agent, or a view built without an actor (the list). */
export const AGENT_CARD_NO_PERMISSIONS: AgentCardViewerPermissions = { canSnapshot: false, canNoteDisagreement: false, canConfirmUse: false, attestableCriteria: [] };

export interface AgentCardComputeOptions {
  /** The observation time. Read by the caller (route or cadence), never inside scoring. */
  asOf: Date;
  /** Defaults to the 30 days ending at `asOf` (the gate 1 projection default). */
  window?: AgentPerformanceWindow;
}

export const AGENT_CARD_WINDOW_DAYS_DEFAULT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const AGENT_CARD_NOT_VISIBLE = "Not visible to you";
const PARTIAL_NOTE = "Some records behind this section are not visible to you; the numbers count only what you can see.";
const CASES_LIMIT_DEFAULT = 100;
const CASES_LIMIT_MAX = 500;

export function defaultAgentCardWindow(asOf: Date, days = AGENT_CARD_WINDOW_DAYS_DEFAULT): AgentPerformanceWindow {
  return { from: new Date(asOf.getTime() - days * DAY_MS).toISOString(), to: asOf.toISOString() };
}

type ScorecardRow = typeof evaluationScorecards.$inferSelect;

// ---------------------------------------------------------------------------
// The per-viewer projection (pure)
// ---------------------------------------------------------------------------

export interface AgentCardViewInput {
  /** The card as computed from every class (stored, or a fresh "Compute now"). */
  card: AgentCardV1;
  stored: { version: number; storedAt: string; cardHash: string } | null;
  sideEffectFree: boolean;
  viewer: EvaluationViewer;
  /** The same card recomputed over only the rows this viewer may read (called only when the viewer can't read every class). */
  readableCard: () => AgentCardV1;
  /** Whether the viewer may read every row a cited milestone result rests on. */
  dependencyReadable: (citation: AgentCardDependencyCitation) => boolean;
  /** Burden details that name people: admins and the accountable user only (LLD §11). */
  canSeePeople: boolean;
  /** What the viewer may do (`viewer` on the view); none when omitted. */
  permissions?: AgentCardViewerPermissions;
}

function sectionView<T>(stored: AgentCardStoredSection<unknown>, body: T, viewer: EvaluationViewer, readsAll: boolean): AgentCardSectionView<T> {
  if (readsAll || stored.accessClasses.length === 0) return { visibility: "visible", body };
  const readable = stored.accessClasses.filter((c) => viewerReadsClass(viewer, c)).length;
  if (readable === 0) return { visibility: "not_visible", note: AGENT_CARD_NOT_VISIBLE };
  if (readable === stored.accessClasses.length) return { visibility: "visible", body };
  return { visibility: "partial", body, note: PARTIAL_NOTE };
}

/**
 * What one viewer receives (LLD §9.1, §11). Side-effect-free. A viewer who
 * reads every class the card rests on gets the stored bodies. Anyone else
 * gets the card recomputed over the rows they may read (scoring is pure, so
 * this is deterministic and nothing hidden enters a number), and each
 * section is labelled from the classes it rests on: none readable → "Not
 * visible to you" with no body and no counts; some → partial.
 */
export function projectAgentCardView(input: AgentCardViewInput): AgentCardView {
  const { card, viewer } = input;
  const readsAll = viewer.admin || card.accessClasses.every((c) => viewerReadsClass(viewer, c));
  const body = readsAll ? card : input.readableCard();
  const accountable = card.worker.acceptance.body.accountable.filter((a) => readsAll || input.dependencyReadable(a.citation));
  const dependencies = card.replay.dependencies.filter((d) => readsAll || input.dependencyReadable(d));
  const cost = { ...body.worker.cost.body, byPerson: input.canSeePeople ? body.worker.cost.body.byPerson : null };
  return {
    kind: "agent_card_view",
    cardVersion: AGENT_CARD_VERSION,
    formulaVersion: AGENT_METRICS_VERSION,
    companyId: card.companyId,
    agentId: card.subjectRef.id,
    agentName: card.agentName,
    stored: input.stored,
    sideEffectFree: input.sideEffectFree,
    contract: card.contract,
    replay: { ...card.replay, dependencies },
    restricted: !viewer.admin,
    // fatal classes first, whatever the averages (LLD §6.4)
    fatal: sectionView(card.fatal, body.fatal.body, viewer, readsAll),
    worker: {
      obligations: sectionView(card.worker.obligations, body.worker.obligations.body, viewer, readsAll),
      quality: sectionView(card.worker.quality, body.worker.quality.body, viewer, readsAll),
      acceptance: sectionView(card.worker.acceptance, { ...body.worker.acceptance.body, accountable }, viewer, readsAll),
      cost: sectionView(card.worker.cost, cost, viewer, readsAll),
      bounds: sectionView(card.worker.bounds, body.worker.bounds.body, viewer, readsAll),
      decisions: sectionView(card.worker.decisions, body.worker.decisions.body, viewer, readsAll),
    },
    reviewer: sectionView(card.reviewer, body.reviewer.body, viewer, readsAll),
    gaps: sectionView(card.gaps, body.gaps.body, viewer, readsAll),
    markers: body.markers,
    viewer: input.permissions ?? AGENT_CARD_NO_PERMISSIONS,
  };
}

/** The url key every agent route resolves today: the agent's current name, normalized, or its id. */
export function agentUrlKeyOf(agent: { id: string; name: string | null }): string {
  return normalizeAgentUrlKey(agent.name) ?? agent.id;
}

/** One row of the list, from a view (never from the stored card). `urlKey` is the agent's current one, not the name stored on the card. */
export function agentCardSummaryOf(view: AgentCardView, stored: { version: number; storedAt: string; cardHash: string; throughSeq: number } | null, urlKey?: string): AgentCardSummary {
  const obligations = view.worker.obligations;
  return {
    agentId: view.agentId,
    agentName: view.agentName,
    urlKey: urlKey ?? agentUrlKeyOf({ id: view.agentId, name: view.agentName }),
    stored,
    contractSource: view.contract.source,
    fatalFlags: view.fatal.visibility === "not_visible" ? null : view.fatal.body.length,
    obligations:
      obligations.visibility === "not_visible"
        ? null
        : obligations.body.responsibilities.map((r) => ({ responsibilityKey: r.responsibilityKey, owed: r.owed, delivered: r.byEndState.delivered_on_time + r.byEndState.delivered_late })),
    restricted: view.restricted,
  };
}

/** Agent exceptions become ledger facts, like milestone findings: identity in the version, phrasing outside it. */
export function agentFindingEvents(companyId: string, card: AgentCardV1, cardVersion: number): EvaluationEventInput[] {
  return card.worker.decisions.body.exceptions.map((e) => {
    const identity = { kind: e.kind, severity: e.severity, subject: card.subjectRef, item: e.item, criterion: e.criterion, routeToUserId: e.routeToUserId, evidenceRefs: e.evidenceRefs, raisedAt: e.raisedAt };
    return {
      companyId,
      projectId: null,
      goalId: null,
      actorType: "evaluator" as const,
      actorId: null,
      sourceTable: "evaluation",
      sourceId: e.key,
      sourceVersion: hashCanonical(identity).slice(0, 32),
      eventType: "evaluation.finding" as const,
      eventTime: new Date(e.raisedAt),
      payload: { ...identity, note: e.note, agentRef: card.subjectRef, cardVersion, formulaVersion: card.formulaVersion },
      correlationId: `finding:${e.key}`,
      subjectAgentId: card.subjectRef.id,
    };
  });
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export function agentCardService(db: Db) {
  const ledger = evaluationLedger(db);

  async function versionsOf(q: LedgerDb, companyId: string, agentId: string): Promise<ScorecardRow[]> {
    return q
      .select()
      .from(evaluationScorecards)
      .where(and(eq(evaluationScorecards.companyId, companyId), eq(evaluationScorecards.milestoneKind, AGENT_CARD_SCORECARD_KIND), eq(evaluationScorecards.milestoneId, agentId)))
      .orderBy(desc(evaluationScorecards.version));
  }

  /**
   * The newest row that is not the evaluator's own output. AgentDash (APM gate
   * 4): advisory records (recommendations and their decisions) are not inputs
   * either, so filing one never cuts a new card version.
   */
  async function cutFor(q: LedgerDb, companyId: string): Promise<number> {
    const [row] = await q
      .select({ m: sql<number>`coalesce(max(${evaluationEvents.seq}), 0)::bigint` })
      .from(evaluationEvents)
      .where(
        and(
          eq(evaluationEvents.companyId, companyId),
          ne(evaluationEvents.actorType, "evaluator"),
          notInArray(evaluationEvents.eventType, [...EVALUATION_ADVISORY_EVENT_TYPES]),
        ),
      );
    return Number(row?.m ?? 0);
  }

  /** Every milestone the agent led or owned in the window, recomputed with `scoreMilestone` from the same rows and cut. */
  async function dependenciesFor(q: LedgerDb, companyId: string, agentId: string, rows: EvaluationEventRow[], cut: number, window: AgentPerformanceWindow): Promise<AgentCardDependencyInput[]> {
    const refs = accountableMilestoneRefs(rows, agentId, window, cut);
    if (refs.length === 0) return [];
    const tl = buildTimeline(orderEvents(rows.filter((r) => Number(r.seq) <= cut)));
    const replay = evaluationReplay(q);
    const out: AgentCardDependencyInput[] = [];
    for (const ref of refs) {
      const fallbackOpen = openFromLedger(tl, ref) ?? (await replay.milestoneOpen(companyId, ref));
      const card = scoreMilestone(rows, ref, cut, companyId, { fallbackOpen });
      out.push({ citation: { kind: ref.kind, id: ref.id, throughSeq: cut, formulaVersion: MILESTONE_FORMULA_VERSION, hash: cardHash(card), fallbackOpen }, card });
    }
    return out;
  }

  async function agentRow(companyId: string, agentId: string) {
    return db
      .select({ id: agents.id, accountableUserId: agents.accountableUserId, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((r) => r[0] ?? null);
  }

  /**
   * The `viewer` flags of a view, from the guards the routes apply. Attestable
   * criteria are those the view shows (the contract in force and the quality
   * rows the viewer reads), each checked against its own declared contract.
   */
  async function permissionsFor(actor: AgentCardActor, companyId: string, agentId: string, view: AgentCardView | null): Promise<AgentCardViewerPermissions> {
    if (!actor.person) return AGENT_CARD_NO_PERMISSIONS;
    const agent = await agentRow(companyId, agentId);
    const resolved = await agentAccountabilityService(db).resolveForAgent(companyId, agentId);
    const refs = new Map<string, EvaluationCriterionRef>();
    if (view) {
      for (const r of view.contract.responsibilities) for (const c of r.criteria) refs.set(evaluationCriterionRefKey(c.ref), c.ref);
      if (view.worker.quality.visibility !== "not_visible") for (const c of view.worker.quality.body.criteria) refs.set(evaluationCriterionRefKey(c.criterion), c.criterion);
    }
    const contracts = new Map<string, EvaluationContractV2 | null>();
    const attestable: string[] = [];
    if (actor.userId) {
      for (const [key, ref] of refs) {
        if (!contracts.has(ref.contractEventId)) {
          const event = await ledger.get(companyId, ref.contractEventId);
          contracts.set(ref.contractEventId, event ? agentContractOf(event, agentId) : null);
        }
        if (namedAttestersOf(contracts.get(ref.contractEventId) ?? null, ref)?.has(actor.userId)) attestable.push(key);
      }
    }
    return {
      canSnapshot: agentCardSnapshotAllowed(actor, { agentUserId: agent?.accountableUserId ?? null, resolvedUserId: resolved?.userId ?? null }),
      canNoteDisagreement: agentDisagreementAllowed(actor, view?.contract.accountableUserId ?? agent?.accountableUserId ?? null),
      // the card routes already required a person who can see the agent: the `use_confirmed` guard
      canConfirmUse: true,
      attestableCriteria: attestable.sort(),
    };
  }

  /** The view of one card for one viewer; `rows` may be passed in when several cards share one load. */
  async function viewFor(viewer: EvaluationViewer, card: AgentCardV1, stored: AgentCardView["stored"], sideEffectFree: boolean, preloaded?: EvaluationEventRow[], actor?: AgentCardActor): Promise<AgentCardView> {
    const readsAll = viewer.admin || card.accessClasses.every((c) => viewerReadsClass(viewer, c));
    let rows: EvaluationEventRow[] | null = null;
    const load = async () => (rows ??= preloaded ?? (await ledger.windowUpTo(card.companyId, card.replay.throughSeq)));
    if (!readsAll) await load();
    const filter = viewerClassFilter(viewer);
    const byId = rows ? new Map((rows as EvaluationEventRow[]).map((r) => [r.id, r] as const)) : new Map<string, EvaluationEventRow>();
    const tl = rows ? buildTimeline(orderEvents((rows as EvaluationEventRow[]).filter((r) => Number(r.seq) <= card.replay.throughSeq))) : null;
    const agent = await agentRow(card.companyId, card.subjectRef.id);
    const accountable = card.contract.accountableUserId ?? agent?.accountableUserId ?? null;
    const userId = viewer.principal.type === "board" ? viewer.principal.userId : null;
    const view = projectAgentCardView({
      card,
      stored,
      sideEffectFree,
      viewer,
      readableCard: () =>
        scoreAgent({
          companyId: card.companyId,
          agentId: card.subjectRef.id,
          events: (rows as EvaluationEventRow[]).filter(filter),
          throughSeq: card.replay.throughSeq,
          asOf: card.replay.asOf,
          window: card.replay.window,
          dependencies: [],
        }),
      dependencyReadable: (citation) => {
        if (!rows || !tl) return true;
        const ref: EvaluationMilestoneRef = { kind: citation.kind, id: citation.id };
        return milestoneDependencyRowIds(rows, tl, ref).every((id) => {
          const r = byId.get(id);
          return !!r && filter(r);
        });
      },
      canSeePeople: viewer.admin || (!!userId && userId === accountable),
    });
    if (!actor) return view;
    return { ...view, viewer: await permissionsFor(actor, card.companyId, card.subjectRef.id, view) };
  }

  async function storedRow(companyId: string, agentId: string, version?: number): Promise<ScorecardRow | null> {
    const rows = await versionsOf(db, companyId, agentId);
    return (version == null ? rows[0] : rows.find((r) => r.version === version)) ?? null;
  }

  const storedOf = (row: ScorecardRow) => ({ version: row.version, storedAt: row.createdAt.toISOString(), cardHash: row.cardHash });

  /** The agent's V2 contracts at a cut (for calibration routing). */
  function contractsIn(rows: EvaluationEventRow[], agentId: string): EvaluationContractV2[] {
    const out = new Map<string, EvaluationContractV2>();
    for (const r of orderEvents(rows)) {
      const c = agentContractOf(r, agentId);
      if (c) out.set(c.profileRevisionId, c);
    }
    return [...out.values()];
  }

  return {
    /**
     * Compute the agent's card at the current ledger cut and store it as the
     * next version, under the company's evaluator lock (as milestone
     * snapshots). Has side effects: appends findings and syncs calibration
     * review items. Reuse: when the newest stored version has the same
     * `throughSeq` and a card equal to the new one apart from `replay.asOf`
     * and `replay.window`, that version is returned with `reused: true` (it
     * stays exactly reproducible at its own replay inputs). Callers enforce
     * who may snapshot (admin or the accountable user).
     */
    async snapshotAgentCard(companyId: string, agentId: string, opts: AgentCardComputeOptions & { fallbackUserId: string | null }): Promise<AgentCardSnapshotResult> {
      const window = opts.window ?? defaultAgentCardWindow(opts.asOf);
      const locked = await withCompanyLock(db, companyId, async (tx) => {
        const cut = await cutFor(tx, companyId);
        const rows = await evaluationLedger(tx).windowUpTo(companyId, cut);
        const dependencies = await dependenciesFor(tx, companyId, agentId, rows, cut, window);
        const card = scoreAgent({ companyId, agentId, events: rows, throughSeq: cut, asOf: opts.asOf.toISOString(), window, dependencies });
        const versions = await versionsOf(tx, companyId, agentId);
        const latest = versions[0] ?? null;
        let row: ScorecardRow;
        let reused = false;
        if (latest && latest.formulaVersion === AGENT_METRICS_VERSION && Number(latest.throughSeq) === cut && agentCardsEquivalent(latest.card as unknown as AgentCardV1, card)) {
          row = latest;
          reused = true;
        } else {
          const [inserted] = await tx
            .insert(evaluationScorecards)
            .values({
              companyId,
              milestoneKind: AGENT_CARD_SCORECARD_KIND,
              milestoneId: agentId,
              version: (latest?.version ?? 0) + 1,
              contractVersion: card.contract.contractVersion,
              formulaVersion: AGENT_METRICS_VERSION,
              throughSeq: cut,
              throughEventId: rows.length > 0 ? rows.reduce((m, r) => (Number(r.seq) > Number(m.seq) ? r : m), rows[0]!).id : null,
              card: card as unknown as Record<string, unknown>,
              cardHash: agentCardHash(card),
            })
            .returning();
          row = inserted!;
        }
        const storedCard = row.card as unknown as AgentCardV1;
        const findings = await evaluationLedger(tx).append(agentFindingEvents(companyId, storedCard, row.version));
        return { row, reused, storedCard, contracts: contractsIn(rows, agentId), findings };
      });
      // calibration review items: deterministic server code outside the ledger lock, like milestone review items
      const sample = new Map<string, CalibrationSampleItem>();
      for (const c of locked.contracts) {
        const routed = c.accountableUserId ? c : { ...c, accountableUserId: opts.fallbackUserId };
        for (const x of selectCalibrationSample(locked.storedCard, routed)) if (!sample.has(x.key)) sample.set(x.key, x);
      }
      const reviewItems =
        sample.size === 0
          ? null
          : await syncCalibrationReviewItems(db, { companyId, agentId, card: locked.storedCard, cardVersion: locked.row.version, sample: [...sample.values()] });
      return {
        version: locked.row.version,
        reused: locked.reused,
        throughSeq: Number(locked.row.throughSeq),
        cardHash: locked.row.cardHash,
        formulaVersion: locked.row.formulaVersion,
        findings: { inserted: locked.findings.inserted, skipped: locked.findings.skipped },
        reviewItems,
      };
    },

    /**
     * Re-run `scoreAgent` from the stored replay inputs (each dependency
     * recomputed at its pinned cut and open flag) and compare hashes. A
     * different stored `formulaVersion` reports `formula_changed`.
     */
    async verifyAgentCard(companyId: string, agentId: string, version?: number): Promise<AgentCardVerifyResult> {
      const stored = await storedRow(companyId, agentId, version);
      if (!stored) return { ok: false, status: "missing", reason: "no stored card" };
      if (stored.formulaVersion !== AGENT_METRICS_VERSION) {
        return { ok: false, status: "formula_changed", reason: `formula changed (${stored.formulaVersion} → ${AGENT_METRICS_VERSION})`, version: stored.version };
      }
      const card = stored.card as unknown as AgentCardV1;
      const cut = card.replay.throughSeq;
      const rows = await ledger.windowUpTo(companyId, cut);
      const depResults: Array<{ kind: "project" | "goal"; id: string; storedHash: string; replayHash: string; ok: boolean }> = [];
      const dependencies: AgentCardDependencyInput[] = [];
      for (const citation of card.replay.dependencies) {
        const ms = scoreMilestone(rows, { kind: citation.kind, id: citation.id }, citation.throughSeq, companyId, { fallbackOpen: citation.fallbackOpen });
        const replayHash = cardHash(ms);
        depResults.push({ kind: citation.kind, id: citation.id, storedHash: citation.hash, replayHash, ok: replayHash === citation.hash });
        // a dependency that no longer reproduces is cited by what it is now, so the card hash shows the disagreement
        dependencies.push({ citation: { ...citation, formulaVersion: MILESTONE_FORMULA_VERSION, hash: replayHash }, card: ms });
      }
      const replayCard = scoreAgent({ companyId, agentId, events: rows, throughSeq: cut, asOf: card.replay.asOf, window: card.replay.window, dependencies });
      const replayHash = agentCardHash(replayCard);
      const ok = replayHash === stored.cardHash && depResults.every((d) => d.ok);
      return { ok, status: ok ? "agree" : "disagree", version: stored.version, throughSeq: Number(stored.throughSeq), storedHash: stored.cardHash, replayHash, dependencies: depResults };
    },

    /** The stored version (latest when omitted), projected for the viewer, with `viewer` flags for `actor`. Null when no version exists. */
    async getAgentCard(viewer: EvaluationViewer, agentId: string, opts?: { version?: number; actor?: AgentCardActor }): Promise<AgentCardView | null> {
      const row = await storedRow(viewer.companyId, agentId, opts?.version);
      if (!row) return null;
      return viewFor(viewer, row.card as unknown as AgentCardV1, storedOf(row), true, undefined, opts?.actor);
    },

    /** The `viewer` flags with no card to show (none stored yet): snapshot and the agent-level guards; no criterion to attest. */
    async cardPermissions(actor: AgentCardActor, companyId: string, agentId: string): Promise<AgentCardViewerPermissions> {
      return permissionsFor(actor, companyId, agentId, null);
    },

    /**
     * The stored versions of one agent's card, newest first: identity and
     * replay inputs only, no card content (nothing a viewer's class filter
     * would hide). The caller has already checked company access and agent
     * visibility, as for the card itself.
     */
    async listAgentCardVersions(companyId: string, agentId: string): Promise<AgentCardVersionSummary[]> {
      const rows = await db
        .select({
          version: evaluationScorecards.version,
          cardHash: evaluationScorecards.cardHash,
          throughSeq: evaluationScorecards.throughSeq,
          asOf: sql<string | null>`${evaluationScorecards.card} -> 'replay' ->> 'asOf'`,
          createdAt: evaluationScorecards.createdAt,
        })
        .from(evaluationScorecards)
        .where(and(eq(evaluationScorecards.companyId, companyId), eq(evaluationScorecards.milestoneKind, AGENT_CARD_SCORECARD_KIND), eq(evaluationScorecards.milestoneId, agentId)))
        .orderBy(desc(evaluationScorecards.version));
      return rows.map((r) => ({ version: r.version, cardHash: r.cardHash, throughSeq: Number(r.throughSeq), asOf: r.asOf ?? r.createdAt.toISOString(), createdAt: r.createdAt.toISOString() }));
    },

    /** Latest stored version per agent the viewer may see (agent visibility), each projected for the viewer. */
    async listAgentCards(viewer: EvaluationViewer, opts: { visibleAgentIds?: ReadonlySet<string> | null } = {}): Promise<AgentCardSummary[]> {
      const rows = await db
        .select()
        .from(evaluationScorecards)
        .where(
          and(
            eq(evaluationScorecards.companyId, viewer.companyId),
            eq(evaluationScorecards.milestoneKind, AGENT_CARD_SCORECARD_KIND),
            sql`${evaluationScorecards.version} = (select max(s2.version) from ${evaluationScorecards} s2 where s2.company_id = ${evaluationScorecards.companyId} and s2.milestone_kind = ${evaluationScorecards.milestoneKind} and s2.milestone_id = ${evaluationScorecards.milestoneId})`,
          ),
        );
      const visible = rows.filter((r) => !opts.visibleAgentIds || opts.visibleAgentIds.has(r.milestoneId));
      // one window load for every card this viewer needs recomputed
      const needsRows = visible.some((r) => {
        const card = r.card as unknown as AgentCardV1;
        return !(viewer.admin || card.accessClasses.every((c) => viewerReadsClass(viewer, c)));
      });
      const maxCut = visible.reduce((m, r) => Math.max(m, Number(r.throughSeq)), 0);
      const shared = needsRows ? await ledger.windowUpTo(viewer.companyId, maxCut) : undefined;
      // links use the agent's url key today (its current name), not the name stored on the card
      const ids = visible.map((r) => r.milestoneId);
      const names = new Map<string, string>();
      if (ids.length > 0) {
        for (const a of await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, viewer.companyId), inArray(agents.id, ids)))) names.set(a.id, a.name);
      }
      const out: AgentCardSummary[] = [];
      for (const r of visible) {
        const card = r.card as unknown as AgentCardV1;
        const view = await viewFor(viewer, card, storedOf(r), true, shared);
        out.push(agentCardSummaryOf(view, { ...storedOf(r), throughSeq: Number(r.throughSeq) }, agentUrlKeyOf({ id: r.milestoneId, name: names.get(r.milestoneId) ?? null })));
      }
      return out.sort((a, b) => (a.agentName ?? "").localeCompare(b.agentName ?? "") || (a.agentId < b.agentId ? -1 : 1));
    },

    /**
     * Drill-down for one version (latest when `filter.version` is omitted),
     * at that version's replay inputs. Rows are filtered by class
     * (`viewerReadsClass` on every class of the row) BEFORE they are
     * counted, filtered by `responsibility`/`state`/`section`/`fact`/
     * `criterion`/`judge` or paged. `AGENT_CASE_FILTER_NONE` as the
     * responsibility or criterion matches rows with none.
     */
    async agentCases(viewer: EvaluationViewer, agentId: string, filter: AgentCaseFilter): Promise<AgentCaseList> {
      const row = await storedRow(viewer.companyId, agentId, filter.version);
      if (!row) return { agentId, version: null, throughSeq: null, rows: [], total: 0, nextCursor: null, restricted: !viewer.admin };
      const card = row.card as unknown as AgentCardV1;
      const all = await ledger.windowUpTo(viewer.companyId, card.replay.throughSeq);
      const readable = viewerClassFilter(viewer);
      const cases = agentCaseRows({
        companyId: card.companyId,
        agentId,
        // the same rows the viewer's card is computed from, so its cases match its numbers
        events: viewer.admin ? all : all.filter(readable),
        throughSeq: card.replay.throughSeq,
        asOf: card.replay.asOf,
        window: card.replay.window,
        dependencies: [],
      });
      const visible = cases
        .filter((c) => viewer.admin || c.accessClasses.every((cls) => viewerReadsClass(viewer, cls)))
        .filter((c) => (filter.responsibility ? c.responsibilityKey === (filter.responsibility === AGENT_CASE_FILTER_NONE ? null : filter.responsibility) : true))
        .filter((c) => (filter.state ? c.state === filter.state : true))
        .filter((c) => (filter.section ? c.section === filter.section : true))
        .filter((c) => (filter.fact ? c.fact === filter.fact : true))
        .filter((c) =>
          !filter.criterion ? true : filter.criterion === AGENT_CASE_FILTER_NONE ? c.criterion === null : c.criterion !== null && evaluationCriterionRefKey(c.criterion) === filter.criterion,
        )
        .filter((c) => (filter.judge ? c.judge === filter.judge : true));
      const limit = Math.min(Math.max(1, filter.limit ?? CASES_LIMIT_DEFAULT), CASES_LIMIT_MAX);
      const offset = filter.cursor && /^\d+$/.test(filter.cursor) ? Number(filter.cursor) : 0;
      const page = visible.slice(offset, offset + limit).map(({ accessClasses: _classes, ...rest }) => rest);
      return {
        agentId,
        version: row.version,
        throughSeq: card.replay.throughSeq,
        rows: page,
        total: visible.length,
        nextCursor: offset + limit < visible.length ? String(offset + limit) : null,
        restricted: !viewer.admin,
      };
    },

    /** "Compute now": the card at the current cut for this viewer. Side-effect-free: stores nothing, appends nothing, creates no review item. */
    async computeAgentCard(viewer: EvaluationViewer, agentId: string, opts: AgentCardComputeOptions & { actor?: AgentCardActor }): Promise<AgentCardView> {
      const window = opts.window ?? defaultAgentCardWindow(opts.asOf);
      const cut = await cutFor(db, viewer.companyId);
      const rows = await ledger.windowUpTo(viewer.companyId, cut);
      const dependencies = await dependenciesFor(db, viewer.companyId, agentId, rows, cut, window);
      const card = scoreAgent({ companyId: viewer.companyId, agentId, events: rows, throughSeq: cut, asOf: opts.asOf.toISOString(), window, dependencies });
      return viewFor(viewer, card, null, true, rows, opts.actor);
    },
  };
}

// ---------------------------------------------------------------------------
// Dispositions bound to an agent subject (LLD §4, §10, §12)
// ---------------------------------------------------------------------------

export interface AgentDispositionActor {
  userId: string;
  /** Company admin (or the local implicit board). */
  admin: boolean;
}

/**
 * Record `use_confirmed`, `disagreement_noted`, or a `criterion_attest` bound
 * to an agent criterion. Who may record:
 * - `criterion_attest`: the criterion's named attester (a `human_attest`
 *   check's person, or the responsibility's named human judge) — not admins
 *   as such; the tuple must name a criterion of the agent's declared contract.
 * - `use_confirmed`: a person (any member who can see the agent).
 * - `disagreement_noted`: the agent's accountable user or an admin.
 * The disposition is appended under the evaluator lock; nothing else changes.
 */
export async function recordAgentDisposition(
  db: Db,
  input: { companyId: string; actor: AgentDispositionActor; body: EvaluationAgentDisposition },
): Promise<{ inserted: number; skipped: number; eventId: string | null; sourceId: string }> {
  const { companyId, actor, body } = input;
  const ledger = evaluationLedger(db);
  const agentId = body.kind === "criterion_attest" ? body.binding.subjectRef.id : body.subjectRef.id;
  const item = body.kind === "criterion_attest" ? body.binding.item : body.item;
  const agent = await db
    .select({ id: agents.id, accountableUserId: agents.accountableUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((r) => r[0] ?? null);
  if (!agent) throw new HttpError(404, "Agent not found");
  let projectId: string | null = null;
  if (item.kind === "issue") {
    const issue = await db.select({ id: issues.id, projectId: issues.projectId }).from(issues).where(and(eq(issues.id, item.id), eq(issues.companyId, companyId))).then((r) => r[0] ?? null);
    if (!issue) throw new HttpError(404, "Item not found");
    projectId = issue.projectId ?? null;
  } else {
    const run = await db.select({ id: deliverableRuns.id }).from(deliverableRuns).where(and(eq(deliverableRuns.id, item.id), eq(deliverableRuns.companyId, companyId))).then((r) => r[0] ?? null);
    if (!run) throw new HttpError(404, "Item not found");
  }
  const criterion = body.kind === "criterion_attest" ? body.binding.criterion : body.kind === "disagreement_noted" ? body.criterion : null;
  let contract: EvaluationContractV2 | null = null;
  if (criterion) {
    const event = await ledger.get(companyId, criterion.contractEventId);
    contract = event ? agentContractOf(event, agentId) : null;
    const named = namedAttestersOf(contract, criterion);
    if (!named) throw new HttpError(422, "The criterion tuple does not name a criterion of this agent's declared contract");
    if (body.kind === "criterion_attest" && !named.has(actor.userId)) throw new HttpError(403, "Only the criterion's named attester can record this attestation");
  }
  const guardActor: AgentCardActor = { person: true, userId: actor.userId, companyAdmin: actor.admin, dispositionAdmin: actor.admin };
  if (body.kind === "disagreement_noted" && !agentDisagreementAllowed(guardActor, contract?.accountableUserId ?? agent.accountableUserId)) {
    throw new HttpError(403, "Only the agent's accountable person or an admin can note a disagreement");
  }
  const referenced = body.kind === "disagreement_noted" ? body.judgmentEventIds : body.evidenceRefs;
  const exists = await ledger.existing(companyId, referenced);
  const missing = referenced.filter((r) => !exists.has(r));
  if (missing.length > 0) throw new HttpError(404, `Referenced ledger events not found in this company: ${missing.join(", ")}`);
  const sourceId = `${body.kind}:${agentId}:${item.kind}:${item.id}${criterion ? `:${criterionToken(criterion)}` : ""}`;
  const content: Record<string, unknown> = { ...body, decidedBy: actor.userId };
  const result = await withCompanyLock(db, companyId, (tx) =>
    evaluationLedger(tx).append([
      {
        companyId,
        projectId,
        goalId: null,
        actorType: "user",
        actorId: actor.userId,
        sourceTable: "evaluation_dispositions",
        sourceId,
        sourceVersion: hashCanonical(content).slice(0, 32),
        eventType: "evaluation.disposition",
        eventTime: new Date(),
        payload: content,
        correlationId: null,
        subjectAgentId: agentId,
      },
    ]),
  );
  const eventId = result.insertedIds[0] ?? (await ledger.findBySource(companyId, "evaluation_dispositions", sourceId, hashCanonical(content).slice(0, 32)))?.id ?? null;
  return { inserted: result.inserted, skipped: result.skipped, eventId, sourceId };
}
