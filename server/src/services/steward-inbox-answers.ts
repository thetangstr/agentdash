import { and, eq, gt, isNull } from "drizzle-orm";
import { ZodError } from "zod";
import type { Db } from "@paperclipai/db";
import { bridgeEndpoints, issues, stewardInboxActionHandles } from "@paperclipai/db";
import type { AskUserQuestionsInteraction, RespondIssueThreadInteraction } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { insertActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import type { heartbeatService } from "./heartbeat.js";
import { dispatchResolvedInteractionContinuation } from "./issue-interaction-continuation.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import {
  STEWARD_INBOX_ANSWER_KIND,
  STEWARD_INBOX_TOKEN_PROVIDER,
  resolveAddressedQuestion,
  resolveOptionAlias,
  resolveQuestionAlias,
  stewardInboxService,
  type StoredQuestionPayload,
} from "./steward-inbox.js";

/**
 * AgentDash-MK: answering an agent's question from a steward inbox.
 *
 * The same rule as deciding an approval from the inbox: **the endpoint
 * credential answers nothing.** What authorises an answer is a handle minted
 * for one endpoint, one person and one question, delivered in that person's
 * digest and spent once. Whether the question is still theirs to answer is
 * then re-resolved from current state, so a steward whose agent was handed to
 * someone else since the sync is refused even holding a valid handle.
 *
 * The write itself is the canonical one the web page uses:
 * `issueThreadInteractionService.answerQuestions` (answer validation, the
 * named-owner checks, the status guard), the same `issue.thread_interaction_answered`
 * activity row, and the same `dispatchResolvedInteractionContinuation`, which
 * is what wakes the asking agent with the answer.
 */

/** The longest free-text answer accepted, matching the stored answer limit. */
const MAX_ANSWER_TEXT = 4000;

export interface InboxAnswerRequest {
  token: string;
  /** The chosen option's alias (`q1.o2`), for a single-question ask. */
  optionId?: string;
  /** Several chosen options, for a single multi-select question. */
  optionIds?: string[];
  /**
   * Free text. Answers a text question; on a selection question it travels as
   * the person's note alongside (or, when the question is optional, instead
   * of) a chosen option.
   */
  text?: string;
  /** One entry per question, for an ask with more than one. */
  answers?: Array<{ questionId: string; optionIds?: string[]; text?: string }>;
}

type Outcome = {
  ok: boolean;
  interactionId?: string;
  issueId?: string;
  identifier?: string | null;
  /** Whether the asking agent was queued to run with the answer. */
  agentWoken?: boolean;
  reason?: string;
};

/**
 * Turn what the person said into the canonical answer shape.
 *
 * The person answers with the digest's aliases (`q1`, `q1.o2`), which are
 * mapped back by position to the agent's stored ids here -- so an agent's id
 * containing whitespace or anything else is still answerable, and never has
 * to be shown. Every judgement about whether the answer is acceptable
 * (required question unanswered, text on a selection question) is left to
 * the canonical validator, so the inbox never accepts an answer the web page
 * would not.
 *
 * Exported for the unit tests.
 */
export function toCanonicalAnswer(
  payload: StoredQuestionPayload,
  request: Omit<InboxAnswerRequest, "token">,
): { ok: true; body: RespondIssueThreadInteraction } | { ok: false; reason: string } {
  const text = typeof request.text === "string" ? request.text.trim() : "";
  if (text.length > MAX_ANSWER_TEXT) {
    return { ok: false, reason: `Keep the answer under ${MAX_ANSWER_TEXT.toLocaleString("en-US")} characters.` };
  }
  const unknownOption = (alias: string) => ({
    ok: false as const,
    reason: `"${alias.slice(0, 40)}" is not one of this question's options. Use an option id from inbox_sync, like q1.o1.`,
  });

  if (Array.isArray(request.answers) && request.answers.length > 0) {
    const answers = [];
    for (const answer of request.answers) {
      const index = resolveQuestionAlias(payload, String(answer.questionId ?? ""));
      if (index === null) {
        return { ok: false, reason: `"${String(answer.questionId).slice(0, 40)}" is not a question here. Use q1, q2, … from inbox_sync.` };
      }
      const question = payload.questions[index]!;
      const optionIds: string[] = [];
      for (const alias of Array.isArray(answer.optionIds) ? answer.optionIds : []) {
        const id = resolveOptionAlias(payload, index, alias);
        if (id === null) return unknownOption(alias);
        optionIds.push(id);
      }
      const own = typeof answer.text === "string" ? answer.text.trim() : "";
      answers.push(
        question.selectionMode === "text"
          ? { questionId: question.id, optionIds, text: own }
          : { questionId: question.id, optionIds, ...(own ? { text: own } : {}) },
      );
    }
    return {
      ok: true,
      body: { answers, ...(text ? { summaryMarkdown: text } : {}) } as RespondIssueThreadInteraction,
    };
  }

  if (payload.questions.length !== 1) {
    return {
      ok: false,
      reason: `This asks ${payload.questions.length} questions. Answer each one with \`answers\` (questionId q1, q2, … plus optionIds or text).`,
    };
  }
  const question = payload.questions[0]!;
  if (question.selectionMode === "text") {
    if (!text) return { ok: false, reason: "This question takes a written answer. Pass `text`." };
    return { ok: true, body: { answers: [{ questionId: question.id, optionIds: [], text }] } as RespondIssueThreadInteraction };
  }
  const aliases = [
    ...(typeof request.optionId === "string" && request.optionId ? [request.optionId] : []),
    ...(Array.isArray(request.optionIds) ? request.optionIds : []),
  ];
  const optionIds: string[] = [];
  for (const alias of aliases) {
    const id = resolveOptionAlias(payload, 0, alias);
    if (id === null) return unknownOption(alias);
    optionIds.push(id);
  }
  if (optionIds.length === 0 && !text) {
    return { ok: false, reason: "Choose an option (`optionId`, like q1.o1) or give a written answer (`text`)." };
  }
  return {
    ok: true,
    body: {
      answers: [{ questionId: question.id, optionIds }],
      // The person's own words on a choice question are the summary the
      // asking agent reads with the answer.
      ...(text ? { summaryMarkdown: text } : {}),
    } as RespondIssueThreadInteraction,
  };
}

/**
 * What to tell the person when the canonical answer path refuses, or null
 * for a real fault. Exported for the tests.
 *
 * A 409 means the question was resolved by someone else between the
 * re-check and the write: the handle rolled back with the transaction, but
 * there is nothing left to answer with it, so it must not be offered again.
 * Anything else the validator refuses (an answer shape it rejects) leaves a
 * handle worth correcting and retrying.
 */
export function answerRefusalFor(error: unknown): { ok: false; reason: string } | null {
  const status = (error as { status?: number } | null)?.status;
  if (status === 409) {
    return { ok: false, reason: "This question was already answered or closed. Sync again for the current state." };
  }
  if (error instanceof ZodError || status === 422 || status === 403 || status === 404 || status === 400) {
    return {
      ok: false,
      reason: `Not answered: ${
        error instanceof ZodError ? error.issues.map((issue) => issue.message).join("; ") : (error as Error).message
      }. Your handle is still good; correct the answer and try again.`,
    };
  }
  return null;
}

export function stewardInboxAnswerService(
  db: Db,
  options: { heartbeat: Pick<ReturnType<typeof heartbeatService>, "wakeup"> },
) {
  const inbox = stewardInboxService(db);

  /** Spend a handle inside the answer's own transaction. Conditional, so two redemptions cannot both win. */
  async function consume(tx: Db, token: string, endpointId: string) {
    const now = new Date();
    return tx
      .update(stewardInboxActionHandles)
      .set({ consumedAt: now })
      .where(
        and(
          eq(stewardInboxActionHandles.token, token),
          eq(stewardInboxActionHandles.bridgeEndpointId, endpointId),
          eq(stewardInboxActionHandles.kind, STEWARD_INBOX_ANSWER_KIND),
          isNull(stewardInboxActionHandles.consumedAt),
          gt(stewardInboxActionHandles.expiresAt, now),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Answer one question from one machine.
   *
   * The handle is spent in the SAME transaction as the answer. An answer the
   * canonical validator refuses (an unknown option, a required question left
   * empty) therefore rolls the spend back too, and the person can correct it
   * with the handle they already hold. A handle that was spent, expired, or
   * minted for another machine is refused before anything is read.
   */
  async function answer(endpointId: string, request: InboxAnswerRequest): Promise<Outcome> {
    const endpoint = await inbox.requireInboxEndpoint(endpointId);
    const person = { companyId: endpoint.companyId, userId: endpoint.userId };
    const publications: ActivityPublication[] = [];
    type Settled =
      | { refused: Outcome }
      | { refused?: undefined; interaction: AskUserQuestionsInteraction; issueId: string; identifier: string | null };

    let settled: Settled;
    try {
      settled = await db.transaction(async (txRaw): Promise<Settled> => {
        const tx = txRaw as unknown as Db;
        // Hold the endpoint for the length of the answer, so a revocation
        // either lands before it (and refuses it) or after it -- never during.
        const live = await tx
          .select({ id: bridgeEndpoints.id })
          .from(bridgeEndpoints)
          .where(and(eq(bridgeEndpoints.id, endpointId), isNull(bridgeEndpoints.revokedAt)))
          .for("share")
          .then((rows) => rows[0] ?? null);
        if (!live) return { refused: { ok: false, reason: "This machine's inbox connection was revoked." } };

        const record = await consume(tx, request.token, endpointId);
        const interactionId = (record?.payload as { interactionId?: unknown } | undefined)?.interactionId;
        if (
          !record ||
          record.companyId !== endpoint.companyId ||
          record.actorUserId !== endpoint.userId ||
          typeof interactionId !== "string"
        ) {
          return { refused: { ok: false, reason: "This answer handle is no longer valid. Sync again." } };
        }

        // Re-resolved now, not trusted from the sync that minted the handle.
        const addressed = await resolveAddressedQuestion(tx, person, interactionId);
        // Spent on purpose when refused here: the question moved on, so the
        // handle is dead and the transaction commits the spend.
        if (!addressed.ok) return { refused: { ok: false, interactionId, reason: addressed.reason } };

        const mapped = toCanonicalAnswer(addressed.payload, request);
        if (!mapped.ok) throw new AnswerRefused(mapped.reason, interactionId);

        const updated = await issueThreadInteractionService(tx).answerQuestions(
          { id: addressed.issue.id, companyId: addressed.issue.companyId },
          interactionId,
          mapped.body,
          { userId: endpoint.userId },
          { executor: tx, publications },
        );
        // The receipt the web page writes, plus where the answer came from.
        publications.push(
          await insertActivity(tx, {
            companyId: addressed.issue.companyId,
            actorType: "user",
            actorId: endpoint.userId,
            action: "issue.thread_interaction_answered",
            entityType: "issue",
            entityId: addressed.issue.id,
            details: {
              interactionId: updated.id,
              interactionKind: updated.kind,
              interactionStatus: updated.status,
              answeredQuestionCount:
                updated.kind === "ask_user_questions" ? updated.result?.answers?.length ?? 0 : 0,
              channel: STEWARD_INBOX_TOKEN_PROVIDER,
              bridgeEndpointId: endpointId,
            },
          }),
        );
        return {
          interaction: updated as AskUserQuestionsInteraction,
          issueId: addressed.issue.id,
          identifier: addressed.issue.identifier,
        };
      });
    } catch (error) {
      if (error instanceof AnswerRefused) {
        return { ok: false, interactionId: error.interactionId, reason: error.message };
      }
      const refusal = answerRefusalFor(error);
      if (!refusal) throw error;
      logger.info({ err: error, endpointId }, "steward inbox answer refused");
      return refusal;
    }

    if (settled.refused) return settled.refused;
    const answered = settled;
    for (const publication of publications) publishActivity(publication);

    // The wake, exactly as the web page's answer queues it: read the issue as
    // it stands after the answer and let the shared continuation decide.
    const issue = await db
      .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, answered.issueId))
      .then((rows) => rows[0] ?? null);
    let agentWoken = false;
    if (issue) {
      try {
        const run = dispatchResolvedInteractionContinuation({
          heartbeat: options.heartbeat,
          issue,
          interaction: answered.interaction,
          actor: { actorType: "user", actorId: endpoint.userId },
          source: "issue.interaction.respond",
        });
        // Null when the continuation policy wakes nobody, or the wake was
        // skipped (a paused agent, a budget stop); the answer stands either way.
        if (run) agentWoken = (await run) != null;
      } catch (err) {
        // The answer is committed. A failed wake is logged, not thrown: the
        // agent still reads the answer on its next run.
        agentWoken = false;
        logger.warn({ err, interactionId: answered.interaction.id }, "steward inbox answer wake failed");
      }
    }

    return {
      ok: true,
      interactionId: answered.interaction.id,
      issueId: answered.issueId,
      identifier: answered.identifier,
      agentWoken,
    };
  }

  return { answer };
}

class AnswerRefused extends Error {
  constructor(
    message: string,
    readonly interactionId: string,
  ) {
    super(message);
  }
}
