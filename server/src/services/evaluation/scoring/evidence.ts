import type { EvaluationContractV1, EvaluationEvidenceClass, EvaluationSourceTier } from "@paperclipai/shared";
import { parseRecordCheck, type ResolvedContract } from "./contract.js";
import { contributors, isSyntheticUser, reviewIndependence, type Independence } from "./independence.js";
import {
  createdAt,
  doneAt,
  latestGoal,
  latestProject,
  obj,
  projectAt,
  snapshotAt,
  startedAt,
  str,
  terminalAt,
  type Handoff,
  type ItemTimeline,
  type Timeline,
} from "./timeline.js";

/**
 * AgentDash: Company Evaluator — required evidence classes per item
 * (spec §4.1) and acceptance-criterion dispositions (§4 item 3).
 *
 * Rule 4: evidence dated after the item's close does not satisfy that close.
 * Rule 10: a missing record where a source exists is `failed`; `undecidable`
 * only when the deployment has no source for the class at all.
 * Rule 11: the DoD that counts is the earliest one in force after the item
 * left backlog. Rule 15 / §4.2: synthetic identities and contributors never
 * confer independence; a non-independent review-class event is a violation
 * (E4) and never evidence.
 */

export type ClassState = "satisfied" | "failed" | "undecidable";

export interface ClassResult {
  state: ClassState;
  reason: string;
  refs: string[];
  tiers: EvaluationSourceTier[];
  /** Evidence that exists but post-dates the close (rule 4): shown, never credited. */
  lateRefs: string[];
  /** Rule 19: satisfied only by reviews inside a concentrated reviewer pair — limited-evidence weight. */
  limited?: boolean;
}

export interface ReviewViolation {
  eventId: string;
  time: Date;
  actorType: string;
  actorId: string | null;
  kind: "verdict" | "handoff" | "approval";
  reason: Extract<Independence, { independent: false }>["reason"];
  sharedAccountability: boolean;
}

export interface ItemEvidence {
  classes: Partial<Record<EvaluationEvidenceClass, ClassResult>>;
  violations: ReviewViolation[];
  /** Rule 19 marking: independent reviews between actors sharing an accountable human. */
  sharedAccountabilityReviews: number;
  /** Rule 19: independent reviews that came from a concentrated reviewer pair (limited-evidence weight). */
  concentratedPairReviews: number;
  /** Review-class events with no attributable actor: neither credited nor a violation. */
  unattributedReviews: number;
}

/** Rule 19 pairs (from `e14ReviewerConcentration`): `a|b` sorted keys of agents whose mutual reviews exceed 80 %. */
export type ConcentratedPairs = ReadonlySet<string>;

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

const GATE_KEYS = ["typecheck", "test", "build"] as const;

/**
 * §4.1 `ci_green`: typecheck, test and build all `pass` AND `pre_existing_failures`
 * named (an array, possibly empty). Null when the payload carries no gate result.
 */
export function gatesPass(gates: Record<string, unknown> | null): boolean | null {
  if (!gates) return null;
  let saw = false;
  for (const k of GATE_KEYS) {
    const v = gates[k];
    if (typeof v !== "string") continue;
    saw = true;
    if (v !== "pass") return false;
  }
  if (!saw) return null;
  return Array.isArray(gates.pre_existing_failures);
}

function closeTime(it: ItemTimeline, asOf: Date): Date {
  return doneAt(it) ?? terminalAt(it)?.time ?? asOf;
}

/** The moment an item left backlog: its start, else its first transition out of backlog, else creation. */
export function leftBacklogAt(it: ItemTimeline): Date | null {
  const start = startedAt(it);
  const out = it.transitions.find((t) => t.from === "backlog" && t.to !== "backlog");
  if (start && out) return start < out.time ? start : out.time;
  return start ?? out?.time ?? createdAt(it);
}

/** Rule 11: a later DoD version that removed criteria or reduced their count after the item left backlog. */
export function dodNarrowedAfter(it: ItemTimeline, boundary: Date | null): { eventId: string; time: Date } | null {
  for (const d of it.dods) {
    if (!d.hasPrevious) continue;
    if (boundary && d.time < boundary) continue;
    const countDown = d.previousCriteriaCount != null && d.criteriaCount != null && d.criteriaCount < d.previousCriteriaCount;
    const removed = d.previousCriteriaIds && d.criteriaIds ? d.previousCriteriaIds.some((id) => id && !d.criteriaIds!.includes(id)) : false;
    if (countDown || removed) return { eventId: d.eventId, time: d.time };
  }
  return null;
}

export function evidenceForItem(it: ItemTimeline, tl: Timeline, resolved: ResolvedContract, concentrated: ConcentratedPairs = new Set()): ItemEvidence {
  const contract = resolved.contract;
  const close = closeTime(it, tl.asOf);
  const violations: ReviewViolation[] = [];
  let sharedCount = 0;
  let concentratedCount = 0;
  let unattributed = 0;
  const classes: Partial<Record<EvaluationEvidenceClass, ClassResult>> = {};
  const reviewCtx = (at: Date) => ({ entityType: "issue" as const, projectId: projectAt(it, at), goalId: snapshotAt(it, at)?.goalId ?? contract.goalId ?? null, at });
  const inConcentratedPair = (reviewer: string | null, at: Date) =>
    !!reviewer &&
    [...contributors(it, at)]
      .filter((k) => k.startsWith("agent:"))
      .map((k) => k.slice(6))
      .some((c) => concentrated.has(pairKey(reviewer, c)));

  // ---- dod_present ----
  {
    const boundary = leftBacklogAt(it);
    const dodEvents = it.dods.filter((d) => (d.criteriaCount ?? 0) > 0);
    const firstDod = dodEvents[0] ?? null;
    const snapWithDod = it.snapshots.find((s) => (s.dodCriteria ?? 0) > 0) ?? null;
    const narrowed = dodNarrowedAfter(it, boundary);
    if (narrowed) {
      classes.dod_present = { state: "failed", reason: "definition of done narrowed after the item left backlog", refs: [narrowed.eventId], tiers: ["T0"], lateRefs: [] };
    } else if (firstDod) {
      if (doneAt(it) && firstDod.time > doneAt(it)!) {
        classes.dod_present = { state: "failed", reason: "definition of done first set after the item was done", refs: [firstDod.eventId], tiers: ["T0"], lateRefs: [firstDod.eventId] };
      } else if (!boundary) {
        classes.dod_present = { state: "undecidable", reason: "definition of done present but when the item left backlog is unknown", refs: [firstDod.eventId], tiers: ["T0"], lateRefs: [] };
      } else if (firstDod.time <= boundary) {
        classes.dod_present = { state: "satisfied", reason: "definition of done in force before the item left backlog", refs: [firstDod.eventId], tiers: ["T0"], lateRefs: [] };
      } else {
        classes.dod_present = { state: "failed", reason: "definition of done set after the item left backlog", refs: [firstDod.eventId], tiers: ["T0"], lateRefs: [] };
      }
    } else if (snapWithDod) {
      // A DoD exists but no dod_set record says when it was set.
      if (!boundary || snapWithDod.time <= boundary) {
        classes.dod_present = { state: "satisfied", reason: "definition of done present before work started", refs: [snapWithDod.eventId], tiers: ["T0"], lateRefs: [] };
      } else {
        classes.dod_present = { state: "undecidable", reason: "definition of done present but no record says when it was set", refs: [snapWithDod.eventId], tiers: ["T0"], lateRefs: [] };
      }
    } else {
      classes.dod_present = { state: "failed", reason: "no definition of done", refs: [], tiers: ["T0"], lateRefs: [] };
    }
  }

  // ---- review-class events: verdicts, tester handoffs, decided approvals ----
  const passedIndependent: string[] = [];
  const anyIndependentReview: string[] = [];
  const lateReview: string[] = [];
  let syntheticOnly = false;
  const limitedReview: string[] = [];
  for (const v of it.verdicts) {
    const reviewer = v.reviewerAgentId ? { actorType: "agent", actorId: v.reviewerAgentId } : { actorType: "user", actorId: v.reviewerUserId };
    const ind = reviewIndependence(reviewer, it, tl, contract, reviewCtx(v.time));
    if (!ind.independent) {
      if (ind.reason === "synthetic") syntheticOnly = true;
      else if (ind.reason === "no_actor") unattributed++; // a malformed record is not a self-review
      else violations.push({ eventId: v.eventId, time: v.time, actorType: reviewer.actorType, actorId: reviewer.actorId, kind: "verdict", reason: ind.reason, sharedAccountability: ind.sharedAccountability });
      continue;
    }
    if (ind.sharedAccountability) sharedCount++;
    if (v.time > close) {
      lateReview.push(v.eventId);
      continue;
    }
    if (inConcentratedPair(v.reviewerAgentId, v.time)) {
      concentratedCount++;
      limitedReview.push(v.eventId);
    }
    anyIndependentReview.push(v.eventId);
    if (v.outcome === "passed") passedIndependent.push(v.eventId);
  }
  for (const h of it.handoffs) {
    if (h.type !== "tester_to_reviewer") continue;
    const ind = reviewIndependence({ actorType: h.actorType, actorId: h.actorId }, it, tl, contract, reviewCtx(h.time));
    if (!ind.independent) {
      if (ind.reason === "no_actor") unattributed++;
      else if (ind.reason !== "synthetic") violations.push({ eventId: h.eventId, time: h.time, actorType: h.actorType, actorId: h.actorId, kind: "handoff", reason: ind.reason, sharedAccountability: ind.sharedAccountability });
      continue;
    }
    if (ind.sharedAccountability) sharedCount++;
    if (h.time > close) lateReview.push(h.eventId);
    else {
      if (h.actorType === "agent" && inConcentratedPair(h.actorId, h.time)) {
        concentratedCount++;
        limitedReview.push(h.eventId);
      }
      anyIndependentReview.push(h.eventId);
    }
  }
  for (const a of it.approvals) {
    if (a.kind !== "decided" || a.actorType !== "user") continue;
    if (isSyntheticUser(a.actorId)) {
      syntheticOnly = syntheticOnly || anyIndependentReview.length === 0;
      continue;
    }
    const ind = reviewIndependence({ actorType: "user", actorId: a.actorId }, it, tl, contract, reviewCtx(a.time));
    if (!ind.independent) {
      if (ind.reason === "no_actor") unattributed++;
      else violations.push({ eventId: a.eventId, time: a.time, actorType: "user", actorId: a.actorId, kind: "approval", reason: ind.reason, sharedAccountability: false });
      continue;
    }
    if (a.time > close) {
      lateReview.push(a.eventId);
      continue;
    }
    anyIndependentReview.push(a.eventId);
    if (a.type === "verdict_escalation" && a.decision === "approved") passedIndependent.push(a.eventId);
  }

  // ---- neutral_verdict ----
  if (passedIndependent.length > 0) {
    classes.neutral_verdict = { state: "satisfied", reason: "independent passed verdict before close", refs: passedIndependent, tiers: ["T0"], lateRefs: lateReview };
  } else if (!tl.sources.verdicts && !tl.sources.approvalsDecided) {
    classes.neutral_verdict = { state: "undecidable", reason: "no verdict source: no verdict has ever been recorded on this company — reviews through the verdict flow make this class decidable", refs: [], tiers: [], lateRefs: lateReview };
  } else if (syntheticOnly && violations.length === 0 && it.verdicts.length + it.approvals.length > 0) {
    classes.neutral_verdict = { state: "undecidable", reason: "only a synthetic identity decided", refs: [], tiers: ["T0"], lateRefs: lateReview };
  } else {
    const selfOnly = violations.some((v) => v.kind === "verdict");
    classes.neutral_verdict = { state: "failed", reason: selfOnly ? "only non-independent verdicts: the contributor reviewed their own work" : lateReview.length > 0 ? "passed verdict recorded only after the item was closed" : "no independent passed verdict", refs: [], tiers: ["T0"], lateRefs: lateReview };
  }

  // ---- independent_review ----
  if (anyIndependentReview.length > 0) {
    const onlyLimited = anyIndependentReview.every((id) => limitedReview.includes(id));
    classes.independent_review = {
      state: "satisfied",
      reason: onlyLimited ? "independent review only from a concentrated reviewer pair — limited evidence" : "review-class event by an independent actor before close",
      refs: anyIndependentReview,
      tiers: ["T0"],
      lateRefs: lateReview,
      limited: onlyLimited,
    };
  } else if (!tl.sources.verdicts && !tl.sources.approvalsDecided && !tl.sources.handoffs) {
    classes.independent_review = { state: "undecidable", reason: "no review source on this company", refs: [], tiers: [], lateRefs: lateReview };
  } else if (syntheticOnly && violations.length === 0) {
    classes.independent_review = { state: "undecidable", reason: "only a synthetic identity decided", refs: [], tiers: ["T0"], lateRefs: lateReview };
  } else {
    classes.independent_review = {
      state: "failed",
      reason: violations.length > 0 ? "only self-review" : lateReview.length > 0 ? "independent review only after the item was closed" : "no independent review",
      refs: [],
      tiers: ["T0"],
      lateRefs: lateReview,
    };
  }

  // ---- delivery_ref ----
  {
    const before = (h: Handoff) => h.time <= close;
    const merged = it.handoffs.filter((h) => h.type === "tpm_merge_report" && str(h.payload, "merge_result") === "shipped" && obj(h.payload, "pr"));
    const verified = it.handoffs.filter((h) => h.type === "reviewer_to_tpm" && obj(h.payload, "pr"));
    const opened = it.handoffs.filter((h) => h.type === "builder_to_ci" && obj(h.payload, "pr"));
    const good = [...merged, ...verified].filter(before);
    const late = [...merged, ...verified].filter((h) => !before(h)).map((h) => h.eventId);
    if (good.length > 0) {
      classes.delivery_ref = { state: "satisfied", reason: merged.some(before) ? "merge report with PR before close" : "reviewer handoff names the PR before close", refs: good.map((h) => h.eventId), tiers: ["T2"], lateRefs: late };
    } else if (!tl.sources.deliveryRefs) {
      classes.delivery_ref = { state: "undecidable", reason: "no delivery source: no GitHub adapter and no merge report on this company — merge reports or the GitHub adapter make this class decidable", refs: [], tiers: [], lateRefs: [] };
    } else {
      classes.delivery_ref = {
        state: "failed",
        reason: late.length > 0 ? "delivery reference only after the item was closed" : opened.length > 0 ? "PR opened, no merge or verification record" : "no delivery reference",
        refs: opened.filter(before).map((h) => h.eventId),
        tiers: ["T2"],
        lateRefs: late,
      };
    }
  }

  // ---- ci_green ----
  {
    const gateReports = it.handoffs
      .map((h) => ({ h, pass: gatesPass(obj(h.payload, "regression_gates")) }))
      .filter((x) => x.pass !== null);
    const passing = gateReports.filter((x) => x.pass === true && x.h.time <= close);
    const latePassing = gateReports.filter((x) => x.pass === true && x.h.time > close).map((x) => x.h.eventId);
    if (passing.length > 0) {
      classes.ci_green = { state: "satisfied", reason: "structured regression gates passing before close", refs: passing.map((x) => x.h.eventId), tiers: ["T2"], lateRefs: latePassing };
    } else if (!tl.sources.regressionGates) {
      classes.ci_green = { state: "undecidable", reason: "no CI evidence source: no structured regression gates and no GitHub check runs on this company — structured gate results make this class decidable", refs: [], tiers: [], lateRefs: [] };
    } else {
      classes.ci_green = {
        state: "failed",
        reason: gateReports.some((x) => x.pass === false) ? "regression gates reported failing or without pre-existing failures named" : latePassing.length > 0 ? "gates passed only after the item was closed" : "no regression gate record",
        refs: gateReports.filter((x) => x.pass === false).map((x) => x.h.eventId),
        tiers: ["T2"],
        lateRefs: latePassing,
      };
    }
  }

  return { classes, violations, sharedAccountabilityReviews: sharedCount, concentratedPairReviews: concentratedCount, unattributedReviews: unattributed };
}

export interface CriterionDisposition {
  criterionId: string;
  state: ClassState;
  reason: string;
  refs: string[];
}

/** Dispositions of every contract criterion for one item (§4 item 3, rule 17). */
export function criterionDispositions(it: ItemTimeline, tl: Timeline, resolved: ResolvedContract, evidence: ItemEvidence): CriterionDisposition[] {
  const out: CriterionDisposition[] = [];
  const terminal = terminalAt(it)?.time ?? null;
  for (const c of resolved.contract.acceptanceCriteria) {
    const declaredAt = resolved.criterionDeclaredAt.get(c.id) ?? resolved.declaredAt;
    if (declaredAt && terminal && declaredAt > terminal) {
      out.push({ criterionId: c.id, state: "undecidable", reason: "criteria were declared after this item closed, so they cannot judge it — declare criteria before work starts", refs: resolved.eventId ? [resolved.eventId] : [] });
      continue;
    }
    if (!c.check) {
      out.push({ criterionId: c.id, state: "undecidable", reason: "unmeasurable: no check declared", refs: [] });
      continue;
    }
    switch (c.check.kind) {
      case "record": {
        const rc = parseRecordCheck(c.check.record);
        const cls = (k: EvaluationEvidenceClass) => evidence.classes[k];
        if (rc.kind === "verdict.passed") out.push(fromClass(c.id, cls("neutral_verdict")));
        else if (rc.kind === "pr.merged") out.push(fromClass(c.id, cls("delivery_ref")));
        else if (rc.kind === "ci.green") out.push(fromClass(c.id, cls("ci_green")));
        else if (rc.kind === "dod.present") out.push(fromClass(c.id, cls("dod_present")));
        else if (rc.kind === "project.status" || rc.kind === "goal.status") {
          const ref = resolved.contract.milestoneRef;
          const snap = rc.kind === "project.status" ? latestProject(tl, ref.kind === "project" ? ref.id : "") : latestGoal(tl, resolved.contract.goalId ?? "");
          if (!snap) out.push({ criterionId: c.id, state: "undecidable", reason: "no roster snapshot for the milestone", refs: [] });
          else if (snap.status === rc.value) out.push({ criterionId: c.id, state: "satisfied", reason: `${rc.kind} is ${rc.value}`, refs: [snap.eventId] });
          else out.push({ criterionId: c.id, state: "failed", reason: `${rc.kind} is ${snap.status ?? "unknown"}, not ${rc.value}`, refs: [snap.eventId] });
        } else out.push({ criterionId: c.id, state: "undecidable", reason: `unknown record check "${c.check.record}"`, refs: [] });
        break;
      }
      case "human_attest": {
        const attester = c.check.attesterUserId;
        const attest = tl.dispositions.filter((d) => {
          const p = (d.payload ?? {}) as Record<string, unknown>;
          return d.eventType === "evaluation.disposition" && str(p, "kind") === "criterion_attest" && str(p, "criterionId") === c.id && (str(p, "issueId") == null || str(p, "issueId") === it.issueId) && d.actorType === "user" && d.actorId === attester;
        });
        const last = attest[attest.length - 1];
        if (!last) out.push({ criterionId: c.id, state: "undecidable", reason: "awaiting attestation by the criterion's named human — nothing recorded yet", refs: [] });
        else if (isSyntheticUser(attester) || reviewIndependenceKey(attester, it, tl, resolved.contract, last.eventTime)) {
          out.push({ criterionId: c.id, state: "undecidable", reason: "the attester is not independent of this item", refs: [last.id] });
        } else {
          const result = str((last.payload ?? {}) as Record<string, unknown>, "result");
          out.push({ criterionId: c.id, state: result === "satisfied" ? "satisfied" : "failed", reason: `attested ${result ?? "unknown"} by ${attester}`, refs: [last.id] });
        }
        break;
      }
      case "metric":
        out.push({ criterionId: c.id, state: "undecidable", reason: "no measurement source: goal measurements are not recorded on this deployment", refs: [] });
        break;
    }
  }
  return out;
}

function reviewIndependenceKey(userId: string, it: ItemTimeline, tl: Timeline, contract: EvaluationContractV1, at: Date): boolean {
  const ind = reviewIndependence({ actorType: "user", actorId: userId }, it, tl, contract, { entityType: "issue", at });
  return !ind.independent;
}

function fromClass(criterionId: string, cls: ClassResult | undefined): CriterionDisposition {
  if (!cls) return { criterionId, state: "undecidable", reason: "no evidence record was computed for this item", refs: [] };
  return { criterionId, state: cls.state, reason: cls.reason, refs: cls.refs };
}
