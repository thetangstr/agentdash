import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentCorrections, agents, authUsers, heartbeatRuns, issues } from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { featureFlagsService } from "./feature-flags.js";

/**
 * AgentDash (co-worker learning loop): "what changed" for an agent whose work
 * a person or another agent corrected.
 *
 * Every correction signal goes through {@link recordAgentCorrection}. The row
 * waits in `agent_corrections` and is delivered on the agent's next wake, in
 * the wake payload the agent already reads (`paperclipWake.corrections`,
 * rendered as a "What changed" section; see heartbeat.ts). The agent's mandate
 * (managed block `agent-learning-loop`) tells it to save the lessons into its
 * own memory.
 *
 * The signals, and who emits them:
 *
 * - `steward_send_back`: the steward sent work back through their own Claude
 *   (`POST /api/bridge/work/confirm`): the agent's draft against the final
 *   revision, the answer against the agent's recommendation, the comment, and
 *   the lessons the person kept.
 * - `steward_answer`: the steward answered the agent's question (web page or
 *   bridge) with something other than the option the agent marked as
 *   recommended. A question with no recommendation, or an answer that took
 *   it, is not a correction.
 * - `approval_rejected`: an approval the agent requested was rejected, with
 *   the decider's note (approval-decision-effects.ts, every decision surface).
 * - `task_reopened`: a person moved an issue the agent had closed back open,
 *   with their comment as the reason.
 * - `requester_change_request`: the person who requested the work asked for
 *   changes to the delivered result (emitted by the request close-out path).
 * - `handoff_returned`: another agent sent a hand-off back (agent-handoffs.ts).
 *
 * Behind the company flag `coworker_bridge_enabled`, like the rest of the
 * co-worker loop: with it off nothing is recorded and nothing is delivered.
 *
 * Text rules. The summary is server-written. Anything quoted in it was written
 * by the person or agent it is attributed to, is flattened to one line and
 * capped, and is information about how the work was received: the rendering
 * says it never outranks the agent's mandate.
 */

export const AGENT_CORRECTION_KINDS = [
  "steward_send_back",
  "steward_answer",
  "approval_rejected",
  "task_reopened",
  "requester_change_request",
  "handoff_returned",
] as const;
export type AgentCorrectionKind = (typeof AGENT_CORRECTION_KINDS)[number];

export const AGENT_CORRECTION_LIMITS = {
  summaryChars: 4_000,
  quoteChars: 600,
  lessonChars: 300,
  lessons: 5,
  diffExcerptLines: 30,
  diffExcerptChars: 1_500,
  diffLineChars: 200,
  /** Above this many cells the diff is counted, not aligned. */
  diffCells: 4_000_000,
  /** Corrections delivered with one run; the rest come with the next. */
  perRun: 5,
  /** A correction whose runs keep failing is offered at most this often. */
  deliveryAttempts: 3,
} as const;

type Executor = Pick<Db, "select" | "insert" | "update">;

/** One line, no control or format characters, capped with an ellipsis. */
export function quoteLine(value: string | null | undefined, max: number = AGENT_CORRECTION_LIMITS.quoteChars): string {
  const flat = String(value ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The lessons a person kept: trimmed, one line each, capped, empty ones dropped. */
export function normalizeLessons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => quoteLine(entry, AGENT_CORRECTION_LIMITS.lessonChars))
    .filter((entry) => entry.length > 0)
    .slice(0, AGENT_CORRECTION_LIMITS.lessons);
}

function words(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * A line diff of two document bodies: counts, plus the first changed lines.
 *
 * Aligned with a longest-common-subsequence table while the bodies are small
 * enough; above {@link AGENT_CORRECTION_LIMITS.diffCells} it counts lines as
 * multisets instead and says so (`approximate`), because a quadratic table on
 * two long documents is not worth a request's latency.
 */
export function summarizeLineDiff(before: string, after: string) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const excerpt: string[] = [];
  let excerptChars = 0;
  const push = (sign: "-" | "+", line: string) => {
    if (excerpt.length >= AGENT_CORRECTION_LIMITS.diffExcerptLines) return;
    const shown = `${sign} ${quoteLine(line, AGENT_CORRECTION_LIMITS.diffLineChars)}`;
    if (excerptChars + shown.length > AGENT_CORRECTION_LIMITS.diffExcerptChars) return;
    excerpt.push(shown);
    excerptChars += shown.length;
  };

  if (a.length * b.length > AGENT_CORRECTION_LIMITS.diffCells) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let unchanged = 0;
    let added = 0;
    for (const line of b) {
      const n = counts.get(line) ?? 0;
      if (n > 0) {
        counts.set(line, n - 1);
        unchanged += 1;
      } else {
        added += 1;
        push("+", line);
      }
    }
    return { removed: a.length - unchanged, added, unchanged, excerpt, approximate: true };
  }

  // lcs[i][j]: common lines of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  let removed = 0;
  let added = 0;
  let unchanged = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      unchanged += 1;
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      removed += 1;
      push("-", a[i]!);
      i += 1;
    } else {
      added += 1;
      push("+", b[j]!);
      j += 1;
    }
  }
  for (; i < a.length; i += 1) {
    removed += 1;
    push("-", a[i]!);
  }
  for (; j < b.length; j += 1) {
    added += 1;
    push("+", b[j]!);
  }
  return { removed, added, unchanged, excerpt, approximate: false };
}

// ---------------------------------------------------------------------------
// The agent's recommendation against what was chosen
// ---------------------------------------------------------------------------

type QuestionOption = { id: string; label: string; description?: string | null };
type Question = { id: string; prompt: string; selectionMode: string; options?: QuestionOption[] };
type Answer = { questionId: string; optionIds?: string[]; text?: string };

/**
 * The option the agent marked as its recommendation, or null.
 *
 * The mandate tells agents to put their recommendation first and label it
 * recommended; the label is the signal, never the position alone, so a
 * question whose options are merely listed carries no recommendation.
 */
export function recommendedOption(question: Question): QuestionOption | null {
  for (const option of question.options ?? []) {
    const text = `${option.label} ${option.description ?? ""}`;
    if (/\brecommended\b/i.test(text) && !/\bnot\s+recommended\b/i.test(text)) return option;
  }
  return null;
}

export interface AnswerComparison {
  prompt: string;
  recommended: string;
  chosen: string;
}

/**
 * Each question where the person's answer differs from the agent's
 * recommendation. Questions without a recommendation, or answered with it,
 * are left out: agreeing is not a correction.
 */
export function answersThatDifferFromRecommendation(
  questions: Question[],
  answers: Answer[],
): AnswerComparison[] {
  const out: AnswerComparison[] = [];
  for (const question of questions) {
    const recommended = recommendedOption(question);
    if (!recommended) continue;
    const answer = answers.find((entry) => entry.questionId === question.id);
    if (!answer) continue;
    const chosenIds = answer.optionIds ?? [];
    if (chosenIds.length === 1 && chosenIds[0] === recommended.id) continue;
    const labels = chosenIds
      .map((id) => question.options?.find((option) => option.id === id)?.label)
      .filter((label): label is string => Boolean(label));
    if (chosenIds.includes(recommended.id) && labels.length > 1) {
      // A multi-select that kept the recommendation and added to it.
      out.push({
        prompt: quoteLine(question.prompt, 200),
        recommended: quoteLine(recommended.label, 120),
        chosen: labels.map((label) => quoteLine(label, 120)).join(", "),
      });
      continue;
    }
    const chosen =
      labels.length > 0
        ? labels.map((label) => quoteLine(label, 120)).join(", ")
        : answer.text?.trim()
          ? `their own answer: "${quoteLine(answer.text, 300)}"`
          : "no option";
    out.push({ prompt: quoteLine(question.prompt, 200), recommended: quoteLine(recommended.label, 120), chosen });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summaries, one per signal
// ---------------------------------------------------------------------------

function cap(text: string): string {
  const max = AGENT_CORRECTION_LIMITS.summaryChars;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function onIssue(identifier: string | null | undefined): string {
  return identifier ? ` on ${identifier}` : "";
}

export function describeAnswerDifferences(differences: AnswerComparison[]): string[] {
  return differences.map(
    (entry) => `Question "${entry.prompt}": they chose ${entry.chosen.startsWith("their own") ? entry.chosen : `"${entry.chosen}"`}; you recommended "${entry.recommended}".`,
  );
}

export function sendBackSummary(input: {
  personName: string;
  identifier: string | null;
  endpointLabel?: string | null;
  document?: {
    key: string;
    before: { body: string; revisionNumber: number; authorLabel: string } | null;
    after: { body: string; revisionNumber: number };
  } | null;
  answerDifferences?: AnswerComparison[];
  answeredWithRecommendation?: boolean;
  decision?: { decision: "approved" | "rejected"; title: string | null } | null;
  comment?: string | null;
}): string {
  const lines = [
    `${input.personName} reviewed your work${onIssue(input.identifier)} in their own Claude session${
      input.endpointLabel ? ` (${quoteLine(input.endpointLabel, 60)})` : ""
    } and sent it back.`,
  ];
  const doc = input.document;
  if (doc) {
    if (doc.before) {
      const diff = summarizeLineDiff(doc.before.body, doc.after.body);
      lines.push(
        `Document "${doc.key}": revision ${doc.before.revisionNumber} (by ${doc.before.authorLabel}, ${words(doc.before.body)} words) became their revision ${doc.after.revisionNumber} (${words(doc.after.body)} words): ${diff.removed} ${diff.removed === 1 ? "line" : "lines"} removed, ${diff.added} added, ${diff.unchanged} unchanged${diff.approximate ? " (counted, not aligned)" : ""}.`,
      );
      if (diff.excerpt.length > 0) {
        lines.push("First changed lines (- yours, + theirs):", ...diff.excerpt.map((line) => `  ${line}`));
      }
    } else {
      lines.push(`Document "${doc.key}": they wrote it themselves (revision ${doc.after.revisionNumber}, ${words(doc.after.body)} words); there was no draft of yours.`);
    }
  }
  for (const line of describeAnswerDifferences(input.answerDifferences ?? [])) lines.push(line);
  if (input.answeredWithRecommendation) lines.push("They took your recommendation on the questions they answered.");
  if (input.decision) {
    lines.push(
      `Decision: they ${input.decision.decision} ${input.decision.title ? `"${quoteLine(input.decision.title, 160)}"` : "your approval"}.`,
    );
  }
  if (input.comment?.trim()) lines.push(`Their comment: "${quoteLine(input.comment)}"`);
  return cap(lines.join("\n"));
}

export function answerSummary(input: {
  personName: string;
  identifier: string | null;
  differences: AnswerComparison[];
  note?: string | null;
}): string {
  const lines = [
    `${input.personName} answered your question${onIssue(input.identifier)} differently from your recommendation.`,
    ...describeAnswerDifferences(input.differences),
  ];
  if (input.note?.trim()) lines.push(`Their note: "${quoteLine(input.note)}"`);
  return cap(lines.join("\n"));
}

export function approvalRejectedSummary(input: {
  personName: string;
  identifier: string | null;
  approvalType: string;
  title: string | null;
  note: string | null;
}): string {
  const what = input.title ? `"${quoteLine(input.title, 160)}" (${input.approvalType})` : `your ${input.approvalType} request`;
  return cap(
    [
      `${input.personName} rejected ${what}${onIssue(input.identifier)}.`,
      input.note?.trim() ? `Their reason: "${quoteLine(input.note)}"` : "They gave no reason; ask if the reason is not clear from the issue.",
    ].join("\n"),
  );
}

export function taskReopenedSummary(input: {
  personName: string;
  identifier: string | null;
  fromStatus: string;
  reason: string | null;
}): string {
  return cap(
    [
      `${input.personName} reopened ${input.identifier ?? "an issue"} after it was ${input.fromStatus}.`,
      input.reason?.trim() ? `Their reason: "${quoteLine(input.reason)}"` : "They gave no reason in a comment; read the issue before you continue.",
    ].join("\n"),
  );
}

export function requesterChangeRequestSummary(input: {
  requesterName: string;
  identifier: string | null;
  request: string | null;
}): string {
  return cap(
    [
      `${input.requesterName}, who requested this work, asked for changes to the result${onIssue(input.identifier)}.`,
      input.request?.trim() ? `What they asked for: "${quoteLine(input.request)}"` : "They did not say what to change; ask them on the issue.",
    ].join("\n"),
  );
}

export function handoffReturnedSummary(input: {
  fromAgentName: string;
  identifier: string | null;
  kind: "reassigned" | "declined";
  reason: string | null;
}): string {
  return cap(
    [
      input.kind === "declined"
        ? `${input.fromAgentName} declined the hand-off ${input.identifier ?? ""} you gave it.`.replace(/\s+/g, " ")
        : `${input.fromAgentName} sent the hand-off ${input.identifier ?? ""} back to you.`.replace(/\s+/g, " "),
      input.reason?.trim()
        ? `Its reason (written by that agent): "${quoteLine(input.reason)}"`
        : "It gave no reason; read the issue before you hand it on again.",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Recording and delivery
// ---------------------------------------------------------------------------

export async function correctionsEnabled(executor: Executor, companyId: string): Promise<boolean> {
  return featureFlagsService(executor as Db).isEnabled(companyId, FEATURE_FLAG_KEYS.COWORKER_BRIDGE);
}

/** A person's display name for a summary, or a neutral role when it has none. */
export async function personDisplayName(executor: Executor, userId: string | null | undefined, fallback = "A person") {
  if (!userId) return fallback;
  const row = await executor
    .select({ name: authUsers.name })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
  return row?.name ? quoteLine(row.name, 80) : fallback;
}

export async function agentDisplayName(executor: Executor, agentId: string | null | undefined, fallback = "Another agent") {
  if (!agentId) return fallback;
  const row = await executor
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  return row?.name ? quoteLine(row.name, 80) : fallback;
}

export interface RecordAgentCorrectionInput {
  companyId: string;
  agentId: string;
  issueId: string | null;
  kind: AgentCorrectionKind;
  summary: string;
  details?: Record<string, unknown>;
  sourceActorType: "user" | "agent";
  sourceActorId: string;
}

/**
 * Queue one correction for the agent's next wake.
 *
 * The single entry point every signal uses. Pass the transaction the
 * correction belongs to, so it commits or rolls back with the write that
 * caused it. Returns null, and records nothing, when the company has not
 * switched the co-worker loop on, or when the agent corrected itself.
 */
export async function recordAgentCorrection(executor: Executor, input: RecordAgentCorrectionInput) {
  if (input.sourceActorType === "agent" && input.sourceActorId === input.agentId) return null;
  if (!(await correctionsEnabled(executor, input.companyId))) return null;
  const lessons = normalizeLessons(input.details?.lessons);
  const [row] = await executor
    .insert(agentCorrections)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      kind: input.kind,
      summary: cap(input.summary),
      details: { ...(input.details ?? {}), lessons },
      sourceActorType: input.sourceActorType,
      sourceActorId: input.sourceActorId,
    })
    .returning();
  return row ?? null;
}

/**
 * The same, for a caller whose write already committed: a failure is logged,
 * never thrown, because the correction is a note about a write that stands.
 */
export async function recordAgentCorrectionAfterCommit(db: Db, input: RecordAgentCorrectionInput) {
  try {
    return await recordAgentCorrection(db, input);
  } catch (err) {
    logger.warn({ err, agentId: input.agentId, kind: input.kind }, "agent correction not recorded");
    return null;
  }
}

export interface DeliveredCorrection {
  id: string;
  kind: string;
  issueId: string | null;
  issueIdentifier: string | null;
  summary: string;
  lessons: string[];
  createdAt: string;
}

const UNSUCCESSFUL_RUN_STATUSES = ["failed", "cancelled", "timed_out"];

/**
 * The corrections this run delivers, oldest first, claimed for it.
 *
 * A correction is waiting when no run has carried it yet, or the run that
 * carried it ended without succeeding (it was refused before it started, or
 * failed) -- at most {@link AGENT_CORRECTION_LIMITS.deliveryAttempts} times.
 * At most {@link AGENT_CORRECTION_LIMITS.perRun} go with one run; the rest
 * wait for the next, and `remaining` says how many.
 */
export async function claimCorrectionsForRun(
  db: Db,
  input: { companyId: string; agentId: string; runId: string },
): Promise<{ items: DeliveredCorrection[]; remaining: number }> {
  if (!(await correctionsEnabled(db, input.companyId))) return { items: [], remaining: 0 };
  const waiting = and(
    eq(agentCorrections.companyId, input.companyId),
    eq(agentCorrections.agentId, input.agentId),
    lt(agentCorrections.deliveryAttempts, AGENT_CORRECTION_LIMITS.deliveryAttempts),
    or(
      isNull(agentCorrections.deliveredRunId),
      and(
        ne(agentCorrections.deliveredRunId, input.runId),
        inArray(heartbeatRuns.status, UNSUCCESSFUL_RUN_STATUSES),
      ),
    ),
  );
  // Locked and skipped, so two runs of one agent starting together never
  // both carry the same correction.
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const rows = await tx
      .select({
        id: agentCorrections.id,
        kind: agentCorrections.kind,
        issueId: agentCorrections.issueId,
        identifier: issues.identifier,
        summary: agentCorrections.summary,
        details: agentCorrections.details,
        createdAt: agentCorrections.createdAt,
      })
      .from(agentCorrections)
      .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, agentCorrections.deliveredRunId))
      .leftJoin(issues, eq(issues.id, agentCorrections.issueId))
      .where(waiting)
      .orderBy(asc(agentCorrections.createdAt))
      .limit(AGENT_CORRECTION_LIMITS.perRun + 50)
      .for("update", { of: agentCorrections, skipLocked: true });
    if (rows.length === 0) return { items: [], remaining: 0 };

    const chosen = rows.slice(0, AGENT_CORRECTION_LIMITS.perRun);
    await tx
      .update(agentCorrections)
      .set({
        deliveredRunId: input.runId,
        deliveredAt: new Date(),
        deliveryAttempts: sql`${agentCorrections.deliveryAttempts} + 1`,
      })
      .where(inArray(agentCorrections.id, chosen.map((row) => row.id)));

    return {
      remaining: rows.length - chosen.length,
      items: chosen.map((row) => ({
        id: row.id,
        kind: row.kind,
        issueId: row.issueId,
        issueIdentifier: row.identifier ?? null,
        summary: row.summary,
        lessons: normalizeLessons((row.details as { lessons?: unknown } | null)?.lessons),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Signals other modules emit through the helpers above
// ---------------------------------------------------------------------------

/**
 * A person's answer to an agent's question, as a correction -- or null when
 * it is not one (no recommendation on the question, the recommendation was
 * taken, the issue has no agent, or the answerer is not a person).
 */
export async function answerCorrectionInput(
  executor: Executor,
  input: {
    issue: { id: string; companyId: string; identifier: string | null; assigneeAgentId: string | null };
    interaction: { kind: string; payload: unknown; result?: unknown };
    answeredByUserId: string | null;
  },
): Promise<RecordAgentCorrectionInput | null> {
  if (input.interaction.kind !== "ask_user_questions") return null;
  if (!input.answeredByUserId || !input.issue.assigneeAgentId) return null;
  const questions = ((input.interaction.payload as { questions?: unknown } | null)?.questions ?? []) as Question[];
  const result = (input.interaction.result ?? null) as { answers?: Answer[]; summaryMarkdown?: string | null } | null;
  const differences = answersThatDifferFromRecommendation(questions, result?.answers ?? []);
  if (differences.length === 0) return null;
  const personName = await personDisplayName(executor, input.answeredByUserId, "Your steward");
  return {
    companyId: input.issue.companyId,
    agentId: input.issue.assigneeAgentId,
    issueId: input.issue.id,
    kind: "steward_answer",
    summary: answerSummary({
      personName,
      identifier: input.issue.identifier,
      differences,
      note: result?.summaryMarkdown ?? null,
    }),
    details: { differences },
    sourceActorType: "user",
    sourceActorId: input.answeredByUserId,
  };
}

/** A rejected approval the agent asked for, as a correction for that agent. */
export async function approvalRejectedCorrectionInput(
  executor: Executor,
  input: {
    approval: { companyId: string; type: string; payload: unknown; requestedByAgentId: string | null };
    issueId: string | null;
    rejectedByUserId: string;
    note: string | null;
  },
): Promise<RecordAgentCorrectionInput | null> {
  if (!input.approval.requestedByAgentId) return null;
  const identifier = input.issueId
    ? await executor
        .select({ identifier: issues.identifier })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0]?.identifier ?? null)
    : null;
  const payload = (input.approval.payload ?? {}) as { title?: unknown };
  return {
    companyId: input.approval.companyId,
    agentId: input.approval.requestedByAgentId,
    issueId: input.issueId,
    kind: "approval_rejected",
    summary: approvalRejectedSummary({
      personName: await personDisplayName(executor, input.rejectedByUserId),
      identifier,
      approvalType: input.approval.type,
      title: typeof payload.title === "string" ? payload.title : null,
      note: input.note,
    }),
    details: { approvalType: input.approval.type },
    sourceActorType: "user",
    sourceActorId: input.rejectedByUserId,
  };
}

/**
 * A person moving a closed issue back open, as a correction for the agent it
 * is assigned to. Null unless the issue was done or cancelled, is open now,
 * has an agent, and a person did it.
 */
export async function taskReopenedCorrectionInput(
  executor: Executor,
  input: {
    issue: { id: string; companyId: string; identifier: string | null; assigneeAgentId: string | null; status: string };
    fromStatus: string | null | undefined;
    reopenedByUserId: string | null;
    reason: string | null;
  },
): Promise<RecordAgentCorrectionInput | null> {
  const closed = (status: string | null | undefined) => status === "done" || status === "cancelled";
  if (!input.reopenedByUserId || !input.issue.assigneeAgentId) return null;
  if (!closed(input.fromStatus) || closed(input.issue.status)) return null;
  return {
    companyId: input.issue.companyId,
    agentId: input.issue.assigneeAgentId,
    issueId: input.issue.id,
    kind: "task_reopened",
    summary: taskReopenedSummary({
      personName: await personDisplayName(executor, input.reopenedByUserId),
      identifier: input.issue.identifier,
      fromStatus: String(input.fromStatus),
      reason: input.reason,
    }),
    details: { fromStatus: input.fromStatus, toStatus: input.issue.status },
    sourceActorType: "user",
    sourceActorId: input.reopenedByUserId,
  };
}

/** A hand-off another agent sent back or declined, as a correction for the agent that gave it. */
export async function handoffReturnedCorrectionInput(
  executor: Executor,
  input: {
    companyId: string;
    issueId: string;
    fromAgentId: string;
    toAgentId: string | null;
    kind: "reassigned" | "declined";
    reason: string | null;
    rootIssueId: string;
  },
): Promise<RecordAgentCorrectionInput | null> {
  if (!input.toAgentId || input.toAgentId === input.fromAgentId) return null;
  const identifier = await executor
    .select({ identifier: issues.identifier })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .then((rows) => rows[0]?.identifier ?? null);
  return {
    companyId: input.companyId,
    agentId: input.toAgentId,
    issueId: input.issueId,
    kind: "handoff_returned",
    summary: handoffReturnedSummary({
      fromAgentName: await agentDisplayName(executor, input.fromAgentId),
      identifier,
      kind: input.kind,
      reason: input.reason,
    }),
    details: { returnKind: input.kind, rootIssueId: input.rootIssueId },
    sourceActorType: "agent",
    sourceActorId: input.fromAgentId,
  };
}

/**
 * The person who requested the work asked for changes to the result. Emitted
 * by the request close-out path (a requester's change request goes to the
 * deliverable owner's agent directly); exported here so that path and this
 * one stay one helper.
 */
export async function requesterChangeRequestCorrectionInput(
  executor: Executor,
  input: {
    issue: { id: string; companyId: string; identifier: string | null };
    ownerAgentId: string;
    requesterUserId: string;
    request: string | null;
  },
): Promise<RecordAgentCorrectionInput> {
  return {
    companyId: input.issue.companyId,
    agentId: input.ownerAgentId,
    issueId: input.issue.id,
    kind: "requester_change_request",
    summary: requesterChangeRequestSummary({
      requesterName: await personDisplayName(executor, input.requesterUserId, "The requester"),
      identifier: input.issue.identifier,
      request: input.request,
    }),
    details: {},
    sourceActorType: "user",
    sourceActorId: input.requesterUserId,
  };
}

/**
 * Record a correction inside someone else's transaction without ever failing
 * it. The correction is a note about the write, so a fault here is logged and
 * the write goes on: the flag is read first (nothing else is read while the
 * loop is off), and the rest runs in a savepoint, so a failed statement rolls
 * back only the note and never poisons the caller's transaction.
 */
export async function recordAgentCorrectionGuarded(
  executor: Executor,
  companyId: string,
  build: (reader: Executor) => Promise<RecordAgentCorrectionInput | null>,
) {
  try {
    if (!(await correctionsEnabled(executor, companyId))) return null;
    const work = async (inner: Executor) => {
      const input = await build(inner);
      return input ? recordAgentCorrection(inner, input) : null;
    };
    const withSavepoint = (executor as Partial<Db>).transaction;
    return typeof withSavepoint === "function"
      ? await (executor as Db).transaction(async (savepoint) => work(savepoint as unknown as Executor))
      : await work(executor);
  } catch (err) {
    logger.warn({ err, companyId }, "agent correction not recorded; the write it describes stands");
    return null;
  }
}
