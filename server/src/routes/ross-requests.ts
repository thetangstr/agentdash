import type { Request, Response, Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  buildRossRequestBody,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  readIssueRecoveryBudget,
  ROSS_REQUEST_KEY_PATTERN,
  stripRossRequestMentions,
  submitRossRequestSchema,
  type RossRequestSubmitStatus,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { notFound } from "../errors.js";
import { issueService } from "../services/issues.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { issueCurrentAuthority } from "../services/issue-current-authority.js";
import {
  issueCommentActions,
  IssueCommentAcceptanceUncertain,
  IssueCommentPolicyRefusal,
} from "../services/issue-mutation-actions.js";
import {
  classifyRossRequestComments,
  findRossRequestComments,
  readRossRequestStatus,
  readRossReview,
} from "../services/ross-requests.js";
import { assertCompanyAccess, assistantGrantAttribution, getActorInfo } from "./authz.js";

/**
 * AgentDash (Ross launch M2): the governed question-to-Ross request as a
 * route, so an assistant's write surface reaches it through ONE allowlisted
 * loopback entry (`agentdash:work`, body `{requestKey, question}`).
 *
 * POST /issues/:id/ross-requests is the canonical issue-comment pipeline
 * (issueCommentActions.accept + dispatch) with one addition: the request-key
 * check runs inside acceptance, after the company and issue rows are locked,
 * so two deliveries of the same key cannot both post. What it guarantees:
 *
 * - Company scope and the A5 project rule come from the issues router
 *   (`router.param("id")` → 404 for a restricted project).
 * - Only a named person may file a request; agent keys are refused.
 * - An issue with no assigned agent, or whose recovery budget is exhausted
 *   (#890: every ordinary wake is refused there), is refused BEFORE any write.
 * - A same-author anchored re-delivery with the same question coalesces onto
 *   the original comment; any other use of the key is a conflict.
 * - The assignee wake is the comment pipeline's own. Under #869 a wake an
 *   assistant grant queues is recorded as automatic (`assistant_grant`), so
 *   it never stands in for a person starting a run. The response never says
 *   a run started: inference is delegated to the native heartbeat gates.
 *
 * GET /issues/:id/ross-requests/:requestKey is the matching single read.
 */

type Heartbeat = Parameters<typeof issueCommentActions>[1];

class RossRequestOutcome extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: { status: RossRequestSubmitStatus; reason: string; [key: string]: unknown },
  ) {
    super(body.reason);
  }
}

class RossRequestCoalesced extends Error {
  constructor(readonly commentId: string, readonly requestedAt: Date) {
    super("ross request coalesced");
  }
}

const ATTRIBUTION_LIMITS =
  "verified means the stored comment author equals the authenticated person. It is API attribution only: " +
  "it cannot tell a direct sign-in from a board key or an assistant grant acting for that person, and it is not consent evidence.";

function personActor(req: Request): string | null {
  if (req.actor.type !== "board") return null;
  return typeof req.actor.userId === "string" && req.actor.userId.length > 0 ? req.actor.userId : null;
}

export function registerRossRequestRoutes(router: Router, deps: { db: Db; heartbeat: Heartbeat }) {
  const { db, heartbeat } = deps;
  const svc = issueService(db);

  router.post("/issues/:id/ross-requests", validate(submitRossRequestSchema), async (req: Request, res: Response) => {
    const issue = await svc.getById(req.params.id as string);
    if (!issue) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const { requestKey, question } = req.body as { requestKey: string; question: string };
    const base = { requestKey, issueId: issue.id, companyId: issue.companyId };
    const actorUserId = personActor(req);
    if (!actorUserId) {
      res.status(403).json({ error: "ross_request_person_only", status: "denied", reason: "person-actor-required", ...base });
      return;
    }
    // Scope the request to the assignee: the comment pipeline wakes every
    // agent a comment @-mentions, so mention syntax is removed before posting.
    const normalizedQuestion = stripRossRequestMentions(question).trim();
    if (!normalizedQuestion) {
      res.status(422).json({ error: "ross_request_refused", status: "refused", reason: "empty-question", ...base });
      return;
    }
    const mentionsStripped = normalizedQuestion !== question.trim();
    const body = buildRossRequestBody(requestKey, normalizedQuestion);
    const actions = issueCommentActions(db, heartbeat);
    try {
      const accepted = await actions.accept({
        issueId: issue.id,
        companyId: issue.companyId,
        actor: getActorInfo(req),
        actorKind: req.actor.type,
        attribution: { ...assistantGrantAttribution(req), rossRequestKey: requestKey },
        intent: { body },
        stageAuthority: issueCurrentAuthority(req),
        // Runs inside acceptance with the company row and (on the final pass)
        // the issue row locked, so every check below sees committed state and
        // no concurrent comment can slip between the key scan and the write.
        validate: async (executor, current) => {
          const policyDb = executor as Db;
          const workspace = current.executionWorkspaceId
            ? await executionWorkspaceService(policyDb).getById(current.executionWorkspaceId)
            : null;
          if (workspace && isClosedIsolatedExecutionWorkspace(workspace)) {
            throw new IssueCommentPolicyRefusal(409, { error: getClosedIsolatedExecutionWorkspaceMessage(workspace) });
          }
          // The key first: a re-delivery of a request already recorded is
          // reported as that request (coalesced), even if the issue has since
          // become unassigned or exhausted — the status read says what then.
          const rows = await findRossRequestComments(policyDb, { companyId: current.companyId, issueId: current.id, requestKey });
          const { own, contested } = classifyRossRequestComments(rows, { requestKey, actorUserId });
          if (own) {
            if (own.question === normalizedQuestion) throw new RossRequestCoalesced(own.id, own.createdAt);
            throw new RossRequestOutcome(409, { status: "conflict", reason: "request-key-carries-different-question", ...base });
          }
          if (contested) {
            throw new RossRequestOutcome(409, { status: "conflict", reason: "request-key-contested-by-foreign-comment", ...base });
          }
          if (readIssueRecoveryBudget(current.executionState)) {
            throw new RossRequestOutcome(409, {
              status: "refused",
              reason: "recovery-exhausted",
              ...base,
              detail:
                "This task's automatic-retry budget is exhausted, so no ordinary run can start from a request. " +
                "A person must clear the recovery block, or authorize one bound run, first. Nothing was posted; the request key stays unused.",
            });
          }
          // A person's comment on a done/cancelled task (or an unblocked
          // blocked one) implicitly reopens it in the comment pipeline. Asking
          // Ross must never change a task's state as a side effect the person
          // did not review, so closed and blocked tasks refuse before writing.
          if (current.status === "done" || current.status === "cancelled") {
            throw new RossRequestOutcome(409, {
              status: "refused",
              reason: "task-closed",
              ...base,
              detail: "Ross can't be asked on a closed task. Reopen it first if you mean to. Nothing was posted.",
            });
          }
          if (current.status === "blocked") {
            throw new RossRequestOutcome(409, {
              status: "refused",
              reason: "task-blocked",
              ...base,
              detail: "Ross can't be asked on a blocked task, because the request could unblock and reopen it. Resolve or unblock it first. Nothing was posted.",
            });
          }
          if (!current.assigneeAgentId) {
            throw new RossRequestOutcome(422, { status: "unavailable", reason: "no-assigned-agent", ...base });
          }
          // Defence in depth for the mention strip above: the body must wake
          // no agent but the assignee.
          const mentioned = await issueService(policyDb).findMentionedAgents(current.companyId, body);
          if (mentioned.length > 0) {
            throw new RossRequestOutcome(422, { status: "refused", reason: "question-mentions-agents", ...base });
          }
        },
      });
      const effects = await actions.dispatch(accepted);
      const assigneeId = accepted.currentIssue.assigneeAgentId;
      const wakeOutcome = effects.outcomes.find((outcome) => outcome.effect === "wakeup" && outcome.targetId === assigneeId);
      // Unlike POST /comments (500 "read before retrying"), unresolved effects
      // still answer 201 submitted: the comment IS committed and its id is
      // the receipt, and a retry with the same requestKey coalesces onto it
      // under the issue lock, so there is no duplicate-post hazard to warn
      // about. The uncertainty is the wake, and `wake.assignee` reports it
      // as "unknown" rather than "requested".
      if (effects.unresolved) {
        logger.warn({ issueId: issue.id, mutationId: accepted.mutationId, effects: effects.outcomes },
          "ross request accepted with unresolved effects");
      }
      const review = await readRossReview(db, { companyId: issue.companyId, issueId: issue.id }).catch(() => null);
      const comment = accepted.comment;
      res.status(201).json({
        status: "submitted" satisfies RossRequestSubmitStatus,
        reason: null,
        ...base,
        receipt: { commentId: comment.id, requestedAt: new Date(comment.createdAt).toISOString(), reused: false },
        baselineRevisionId: review?.revisionId ?? null,
        reopened: accepted.plan.reopened,
        mentionsStripped,
        attribution: {
          actorUserId,
          authorUserId: comment.authorUserId ?? null,
          verified: comment.authorUserId === actorUserId,
          credential: req.actor.source ?? null,
          assistantGrantId: req.actor.assistantGrantId ?? null,
          limits: ATTRIBUTION_LIMITS,
        },
        wake: {
          assignee: !wakeOutcome ? "not-requested" : wakeOutcome.status === "confirmed" ? "requested" : wakeOutcome.status,
          // #869: an assistant grant's wake is automation, never a person starting a run.
          automatic: req.actor.source === "assistant_grant",
        },
        inference: {
          state: "delegated-to-native-run-gates",
          // This call posts a comment and observes no run admission; whether
          // a run starts is decided later by the heartbeat gates.
          runAdmission: "not_observed",
          guarantee: "A model call begins only if native heartbeat admission (budget, quota, ownership, holds, recovery budget) admits a run.",
        },
      });
    } catch (err) {
      if (err instanceof RossRequestCoalesced) {
        res.status(200).json({
          status: "coalesced" satisfies RossRequestSubmitStatus,
          reason: "identical-request-already-recorded",
          ...base,
          receipt: { commentId: err.commentId, requestedAt: err.requestedAt.toISOString(), reused: true },
          inference: { state: "delegated-to-native-run-gates", runAdmission: "not_observed" },
        });
        return;
      }
      if (err instanceof RossRequestOutcome) {
        res.status(err.httpStatus).json({ error: `ross_request_${err.body.status}`, ...err.body });
        return;
      }
      if (err instanceof IssueCommentAcceptanceUncertain) {
        res.status(500).json({
          error: "ross_request_uncertain",
          status: "uncertain",
          reason: "acceptance-uncertain-read-before-retry",
          ...base,
        });
        return;
      }
      if (err instanceof IssueCommentPolicyRefusal) {
        res.status(err.status).json({
          error: typeof err.body.error === "string" ? err.body.error : "ross_request_refused",
          status: err.status === 401 || err.status === 403 ? "denied" : "refused",
          reason: err.status === 401 || err.status === 403 ? "actor-not-permitted" : "request-refused-by-policy",
          ...base,
        });
        return;
      }
      throw err;
    }
  });

  router.get("/issues/:id/ross-requests/:requestKey", async (req: Request, res: Response) => {
    const issue = await svc.getById(req.params.id as string);
    if (!issue) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const requestKey = req.params.requestKey as string;
    if (!ROSS_REQUEST_KEY_PATTERN.test(requestKey)) {
      res.status(400).json({ error: "invalid_request_key" });
      return;
    }
    const actorUserId = personActor(req);
    if (!actorUserId) {
      res.status(403).json({ error: "ross_request_person_only", status: "denied", reason: "person-actor-required" });
      return;
    }
    res.json(await readRossRequestStatus(db, { issue, requestKey, actorUserId }));
  });
}
