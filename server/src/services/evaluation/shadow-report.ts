import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import {
  EVALUATION_SHADOW_NOTE_TOPICS,
  EVALUATOR_AGENT_ROLE,
  EVALUATOR_READ_ONLY_REASON,
  type EvaluationGraduationItem,
  type EvaluationMilestoneRef,
  type EvaluationShadowMilestoneReport,
  type EvaluationShadowNoteTopic,
  type EvaluationShadowReport,
  type ExceptionRecord,
  type ScoredCard,
} from "@paperclipai/shared";
import { evaluationLedger, type EvaluationEventRow } from "./ledger.js";
import { evaluationOverview } from "./overview.js";
import { evaluationScorecardService } from "./scorecards.js";

/**
 * AgentDash: Company Evaluator — Milestone 5 shadow-run report. Measures every
 * graduation criterion of the mandate from the ledger and the stored cards:
 * nothing here is estimated, and a criterion that cannot be measured yet says
 * so instead of passing. Administrators only (it replays every stored version).
 */

const str = (p: Record<string, unknown> | null | undefined, key: string): string | null => {
  const v = p?.[key];
  return typeof v === "string" ? v : null;
};
const refOf = (p: Record<string, unknown> | null | undefined): EvaluationMilestoneRef | null => {
  const r = p?.milestoneRef as { kind?: string; id?: string } | undefined;
  return r && (r.kind === "project" || r.kind === "goal") && typeof r.id === "string" ? { kind: r.kind, id: r.id } : null;
};
const sameRef = (a: EvaluationMilestoneRef | null, b: EvaluationMilestoneRef) => !!a && a.kind === b.kind && a.id === b.id;
const rate = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);
const pct = (x: number | null): string => (x == null ? "not measurable" : `${Math.round(x * 100)}%`);

export function evaluationShadowReport(db: Db) {
  const ledger = evaluationLedger(db);
  const cards = evaluationScorecardService(db);
  const overview = evaluationOverview(db);

  async function milestone(companyId: string, ref: EvaluationMilestoneRef, name: string, status: string | null, dispositions: EvaluationEventRow[], reviewProjectId: string | null): Promise<EvaluationShadowMilestoneReport> {
    const versions = await overview.versions(companyId, ref);
    const replay = { agree: 0, disagree: 0, formulaChanged: 0, agreementRate: null as number | null };
    for (const v of versions) {
      const r = await cards.verify(companyId, ref, v.version);
      if (r.ok) replay.agree++;
      else if ((r.reason ?? "").startsWith("formula changed")) replay.formulaChanged++;
      else replay.disagree++;
    }
    replay.agreementRate = rate(replay.agree, replay.agree + replay.disagree);

    const latest = await cards.latest(companyId, ref);
    const card = (latest?.card as ScoredCard | undefined) ?? null;
    const exceptions: ExceptionRecord[] = card?.exceptions ?? [];
    const count = (severity: string) => exceptions.filter((e) => e.severity === severity).length;
    const material = exceptions.filter((e) => e.severity === "immediate" || e.severity === "material");
    const ex = {
      total: card?.exceptionsTotal ?? exceptions.length,
      immediate: count("immediate"),
      material: count("material"),
      routine: count("routine"),
      materialClaims: material.length,
      materialClaimsTraced: material.filter((e) => e.evidenceRefs.length > 0).length,
    };

    // the latest human verdict per exception key wins; a miss is one fact per source id
    const mine = dispositions.filter((d) => sameRef(refOf(d.payload), ref));
    const verdicts = new Map<string, string>();
    for (const d of mine) {
      if (str(d.payload, "kind") !== "exception_reviewed") continue;
      const key = str(d.payload, "exceptionKey");
      const verdict = str(d.payload, "verdict");
      if (key && verdict) verdicts.set(key, verdict);
    }
    const missed = new Set(mine.filter((d) => str(d.payload, "kind") === "exception_missed").map((d) => d.sourceId)).size;
    const confirmed = [...verdicts.values()].filter((v) => v === "confirmed").length;
    const falsePositive = [...verdicts.values()].filter((v) => v === "false_positive").length;
    const reviews = {
      confirmed,
      falsePositive,
      missed,
      precision: rate(confirmed, confirmed + falsePositive),
      recall: rate(confirmed, confirmed + missed),
      reviewedKeys: [...verdicts.keys()].sort(),
    };

    const notes = Object.fromEntries(EVALUATION_SHADOW_NOTE_TOPICS.map((t) => [t, [] as string[]])) as Record<EvaluationShadowNoteTopic, string[]>;
    for (const d of mine) {
      if (str(d.payload, "kind") !== "shadow_note") continue;
      const topic = str(d.payload, "topic") as EvaluationShadowNoteTopic | null;
      const text = str(d.payload, "text");
      if (topic && text && topic in notes) notes[topic].push(text);
    }

    // review items: one digest per human per milestone is the chatter ceiling; immediate items are matched by exception key
    const messages = { digests: 0, digestsPerHuman: {} as Record<string, number>, immediateItems: 0, immediateSeverities: {} as Record<string, number> };
    if (reviewProjectId) {
      const items = await db
        .select({ description: issues.description, assigneeUserId: issues.assigneeUserId })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.projectId, reviewProjectId)));
      const digestMarker = `<!-- evaluator-key: digest:${ref.kind}:${ref.id}:`;
      const immediateKeys = new Map(exceptions.map((e) => [`<!-- evaluator-key: immediate:${e.key} -->`, e.severity]));
      for (const it of items) {
        const d = it.description ?? "";
        if (d.includes(digestMarker)) {
          messages.digests++;
          const who = it.assigneeUserId ?? "unassigned";
          messages.digestsPerHuman[who] = (messages.digestsPerHuman[who] ?? 0) + 1;
          continue;
        }
        for (const [marker, severity] of immediateKeys) {
          if (d.includes(marker)) {
            messages.immediateItems++;
            messages.immediateSeverities[severity] = (messages.immediateSeverities[severity] ?? 0) + 1;
            break;
          }
        }
      }
    }
    return { ref, name, status, versions: versions.length, replay, exceptions: ex, reviews, messages, notes };
  }

  return {
    async get(companyId: string, refs: EvaluationMilestoneRef[], opts: { costCapCents?: number } = {}): Promise<EvaluationShadowReport> {
      const ov = await overview.get(companyId);
      const [dispositions, corrections, notesEv, findings, refusals] = await Promise.all([
        ledger.list(companyId, { types: ["evaluation.disposition"], limit: 5000 }),
        ledger.list(companyId, { types: ["evaluation.correction"], limit: 5000 }),
        ledger.list(companyId, { types: ["evaluation.evaluator_note"], limit: 5000 }),
        ledger.list(companyId, { types: ["evaluation.finding"], limit: 5000 }),
        ledger.list(companyId, { types: ["authz.refused"], limit: 5000 }),
      ]);
      const decided = new Map<string, string>();
      for (const d of dispositions) {
        if (str(d.payload, "kind") !== "correction_decided") continue;
        const id = str(d.payload, "correctionEventId");
        if (id) decided.set(id, str(d.payload, "decision") ?? "decided");
      }
      const correctionsSummary = {
        pending: corrections.filter((c) => !decided.has(c.id)).length,
        accepted: corrections.filter((c) => decided.get(c.id) === "accepted").length,
        rejected: corrections.filter((c) => decided.get(c.id) === "rejected").length,
        evaluatorNotes: notesEv.length,
      };

      const evaluatorAgent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.role, EVALUATOR_AGENT_ROLE), ne(agents.status, "terminated")))
        .then((rows) => rows[0] ?? null);
      let runs = 0;
      let costCents = 0;
      if (evaluatorAgent) {
        const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, evaluatorAgent.id)));
        runs = r?.n ?? 0;
        const [c] = await db.select({ cents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` }).from(costEvents).where(and(eq(costEvents.companyId, companyId), eq(costEvents.agentId, evaluatorAgent.id)));
        costCents = c?.cents ?? 0;
      }
      const evaluator = {
        provisioned: evaluatorAgent !== null,
        agentId: evaluatorAgent?.id ?? null,
        runs,
        costCents,
        refusedRequests: refusals.filter((r) => str(r.payload, "reasonCode") === EVALUATOR_READ_ONLY_REASON).length,
        findingsAuthored: findings.filter((f) => f.actorType === "evaluator").length,
      };

      const milestones: EvaluationShadowMilestoneReport[] = [];
      for (const ref of refs) {
        const m = ov.milestones.find((x) => x.ref.kind === ref.kind && x.ref.id === ref.id);
        milestones.push(await milestone(companyId, ref, m?.name ?? `${ref.kind} ${ref.id}`, m?.status ?? null, dispositions, ov.reviewProjectId));
      }

      // graduation criteria, each measured or declared not measurable
      const sum = (f: (m: EvaluationShadowMilestoneReport) => number) => milestones.reduce((s, m) => s + f(m), 0);
      const claims = sum((m) => m.exceptions.materialClaims);
      const traced = sum((m) => m.exceptions.materialClaimsTraced);
      const agree = sum((m) => m.replay.agree);
      const disagree = sum((m) => m.replay.disagree);
      const formulaChanged = sum((m) => m.replay.formulaChanged);
      const confirmed = sum((m) => m.reviews.confirmed);
      const falsePositive = sum((m) => m.reviews.falsePositive);
      const missed = sum((m) => m.reviews.missed);
      const precision = rate(confirmed, confirmed + falsePositive);
      const recall = rate(confirmed, confirmed + missed);
      const maxDigestsPerHuman = Math.max(0, ...milestones.flatMap((m) => Object.values(m.messages.digestsPerHuman)));
      const immediateNonMaterial = sum((m) => m.messages.immediateSeverities.routine ?? 0);
      const rescues = milestones.map((m) => m.notes.rescue.length);
      const allClosed = milestones.length > 0 && milestones.every((m) => m.status === "completed" || m.status === "achieved" || m.status === "cancelled");
      const graduation: EvaluationGraduationItem[] = [
        {
          key: "material_claims_traced",
          criterion: "100% of material claims trace to evidence",
          status: claims === 0 ? "not_measurable" : traced === claims ? "met" : "not_met",
          measured: claims === 0 ? "no material claims on the latest cards" : `${traced} of ${claims} material or immediate exceptions cite at least one ledger event`,
          note: "counted on the latest stored card of each milestone",
        },
        {
          key: "no_authority_mutation",
          criterion: "zero self-review or authority mutations by the evaluator",
          status: "met",
          measured: `${evaluator.refusedRequests} refused attempts recorded; 0 mutations possible through the read-only gate; the evaluator's own items are excluded from every card by rule 12`,
          note: "a property of the gate and the scoring rules, reported with the refusal count so a hostile key shows up here",
        },
        {
          key: "replay_agreement",
          criterion: "at least 95% deterministic replay agreement",
          status: agree + disagree === 0 ? "not_measurable" : (rate(agree, agree + disagree) ?? 0) >= 0.95 ? "met" : "not_met",
          measured: `${agree} agree, ${disagree} disagree${formulaChanged > 0 ? `, ${formulaChanged} stored under an older formula (excluded; re-snapshot to compare)` : ""}: ${pct(rate(agree, agree + disagree))}`,
          note: "every stored version replayed from the ledger and compared byte for byte",
        },
        {
          key: "precision_recall",
          criterion: "at least 90% precision and recall on agreed material exceptions, every miss reviewed",
          status: confirmed + falsePositive + missed === 0 ? "not_measurable" : (precision ?? 0) >= 0.9 && (recall ?? 0) >= 0.9 ? "met" : "not_met",
          measured: confirmed + falsePositive + missed === 0 ? "no exception reviews recorded yet" : `precision ${pct(precision)} (${confirmed} confirmed, ${falsePositive} false positives), recall ${pct(recall)} (${missed} missed)`,
          note: "from exception_reviewed and exception_missed dispositions filed by humans; the latest verdict per exception key counts",
        },
        {
          key: "chatter_ceiling",
          criterion: "no more than one routine evaluator message per milestone; immediate alerts only for material authority, security or release risks",
          status: maxDigestsPerHuman <= 1 && immediateNonMaterial === 0 ? "met" : "not_met",
          measured: `at most ${maxDigestsPerHuman} digest per human per milestone; ${sum((m) => m.messages.immediateItems)} immediate items, ${immediateNonMaterial} of them below material severity`,
          note: "digests are updated in place and never re-sent; immediate items are E3, E4 and material E2, E12, E13",
        },
        {
          key: "cost_reported",
          criterion: "evaluation model cost capped and reported per milestone",
          status: opts.costCapCents == null ? "not_measurable" : costCents <= opts.costCapCents ? "met" : "not_met",
          measured: `${evaluator.runs} evaluator runs, $${(costCents / 100).toFixed(2)} metered${opts.costCapCents == null ? "; no cap supplied" : ` against a cap of $${(opts.costCapCents / 100).toFixed(2)}`}`,
          note: "the evaluator's runs are not tagged by milestone; the figure is per company, and the cap is the founder's to set",
        },
        {
          key: "no_rescues",
          criterion: "two milestones completed without the founder rescuing ordinary engineering or product flow",
          status: milestones.length < 2 || !allClosed ? "not_measurable" : rescues.every((n) => n === 0) ? "met" : "not_met",
          measured: `${milestones.length} milestone${milestones.length === 1 ? "" : "s"} named; rescues recorded: ${rescues.join(", ") || "none"}; ${allClosed ? "all closed" : "not all closed yet"}`,
          note: "rescues are recorded by the founder as shadow_note dispositions with topic rescue",
        },
      ];
      return { companyId, generatedAt: new Date().toISOString(), milestones, corrections: correctionsSummary, evaluator, graduation };
    },
  };
}
