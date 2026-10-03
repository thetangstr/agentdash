import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { type Db, deepInterviewSpecs as deepInterviewSpecsTable } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { unauthorized, badRequest, notFound, forbidden, conflict } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";
import {
  companyService,
  conversationService,
  conversationDispatch,
  agentService,
  cosReplier,
  cosOnboardingStateService,
  agentSummoner,
  agentInstructionsService,
} from "../services/index.js";
import { llmSummonAdapter } from "../services/agent-summoner.js";
import type { DeepInterviewSpecsService } from "../services/cos-replier.js";
import { dispatchLLM } from "../services/dispatch-llm.js";
import { DISPATCH_ERROR_CARD_KIND, STALLED_REPLY_RETRY_AFTER_MS, isNoBalanceFailure, postDispatchFailure } from "../services/cos-dispatch-failure.js";
import { buildPhase0Greeting } from "../services/onboarding-orchestrator.js";
import { cosIssueActionForDb, type CosIssueAction } from "../services/cos-issue-action.js";
import { companyMemberName, listCompanyMemberNames } from "../services/cos-plan-naming.js";
import { visibleAgentIdsFor } from "./visibility.js";

const COMPANY_INBOX_TITLE = "Company Inbox";

export function conversationRoutes(
  db: Db,
  // AgentDash (scan 3, lane G): injectable for route tests.
  opts: { issueAction?: CosIssueAction } = {},
) {
  const router = Router();
  const svc = conversationService(db);
  // AgentDash (scan 3, lane G): CoS task proposals and their confirmation.
  const issueAction = opts.issueAction ?? cosIssueActionForDb(db);
  const agents = agentService(db);

  const cosResolver = {
    findByCompany: async (companyId: string) => {
      const all = await agents.list(companyId);
      return all.find((a: any) => a.role === "chief_of_staff") ?? null;
    },
  };

  const dispatcher = conversationDispatch({
    conversations: svc,
    agents: {
      listForCompany: (companyId: string) => agents.list(companyId),
      getById: (id: string) => agents.getById(id),
    },
    summoner: agentSummoner({
      conversations: svc,
      agents: { getById: (id: string) => agents.getById(id) },
      // One adapter for every `adapterType`, deliberately: `dispatchLLM` already
      // selects the model from AGENTDASH_DEFAULT_ADAPTER, which is the same
      // selection the `replier` below uses. Branching on the agent's own
      // `adapterType` here would let a summoned agent answer through a different
      // model than the CoS in the same conversation, for no stated reason.
      adapterFor: (_t: string) =>
        llmSummonAdapter({
          instructions: agentInstructionsService(),
          dispatch: (input) => dispatchLLM(input),
        }),
    }),
    // dispatchLLM routes to the CoS chat adapter selected via `agentdash setup`
    // (AGENTDASH_DEFAULT_ADAPTER). Defaults to claude_api; also supports
    // hermes_local and claude_local. Unsupported adapters fail explicitly.
    replier: cosReplier({
      conversations: svc,
      llm: dispatchLLM,
      db, // AgentDash (Cloud SKU, G3): enables usage metering of CoS replies
      cosState: cosOnboardingStateService(db),
      deepInterviewSpecs: deepInterviewSpecsLoader(db),
      // AgentDash (scan 3, lane G): the CoS may create and assign one task per reply.
      issueAction: issueAction,
      // AgentDash (scan 4, lane N): never name a proposed agent after a member.
      memberNames: (companyId: string) => listCompanyMemberNames(db, companyId),
      // AgentDash (review-1006 finding 4): frame the answered message by
      // author name instead of quoting its text into the system prompt.
      requesterName: (companyId: string, userId: string) => companyMemberName(db, companyId, userId),
    } as any),
    cosResolver,
  });

  // AgentDash (first-session test, Lane A item 4): a fresh company's inbox used
  // to open empty, so the founder faced a blank Ask page. The CoS opens the
  // inbox with the interview's first question, but only for a genuinely fresh
  // company (#953 review):
  // - no conversation existed before this inbox, so no CoS interview has run
  //   (cos onboarding state is per conversation, so none exists either) and a
  //   founder who finished the /cos interview is never greeted again;
  // - the company has never hired: its only agent, terminated ones included,
  //   is the Chief of Staff.
  // Best effort: a failure here never blocks returning the inbox.
  async function postCosOpener(companyId: string, conversationId: string) {
    try {
      const all = await agents.list(companyId, { includeTerminated: true });
      const cos = all.find((a: any) => a.role === "chief_of_staff");
      if (!cos || all.some((a: any) => a.role !== "chief_of_staff")) return;
      let companyName: string | null = null;
      try {
        companyName = (await companyService(db).getById(companyId))?.name ?? null;
      } catch {
        // The greeting falls back to the product name.
      }
      await svc.postMessage({
        conversationId,
        authorKind: "agent",
        authorId: cos.id,
        body: buildPhase0Greeting(null, companyName),
        companyId,
      });
    } catch (err) {
      logger.warn({ err, companyId, conversationId }, "could not post the CoS opener");
    }
  }

  // AgentDash (security): every `/:id` route resolves the conversation first
  // and authorizes against the conversation's own company. The company is
  // never taken from the request body — a caller-supplied companyId used to
  // pick which company's live-event stream a message was broadcast on.
  async function loadAuthorizedConversation(req: Request) {
    // Authenticate before the lookup, so an anonymous caller cannot tell an
    // existing conversation id (401) from a missing one (404).
    assertAuthenticated(req);
    const conversation = await svc.getById(req.params.id as string);
    if (!conversation) {
      throw notFound("Conversation not found");
    }
    assertCompanyAccess(req, conversation.companyId);
    return conversation;
  }

  // GET /api/conversations/companies/:companyId/inbox
  router.get("/companies/:companyId/inbox", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    let conversation = await svc.findByCompany(companyId, { title: COMPANY_INBOX_TITLE });
    if (!conversation) {
      // Any earlier conversation (e.g. the /cos bootstrap one) means the
      // company is not fresh: it already has its CoS thread and greeting.
      const earlierConversation = await svc.findByCompany(companyId);
      conversation = await svc.create({
        companyId,
        userId: req.actor.userId,
        title: COMPANY_INBOX_TITLE,
      });
      await svc.addParticipant(conversation.id, req.actor.userId, "owner");
      if (!earlierConversation) await postCosOpener(companyId, conversation.id);
    }
    res.json(conversation);
  });

  // AgentDash (P0, v2026.1002.0): a failed dispatch is never silent. The
  // error is logged as before AND posted into the conversation as a
  // `cos_dispatch_error_v1` card ("CoS couldn't reply: <reason>. Retry"),
  // which publishes `message.created` so the open chat drops its "thinking"
  // state and offers Retry.
  //
  // When the failure is Z.AI's "no balance" (code 1113) the pinned endpoint
  // may have lapsed (a Coding Plan that ended). The endpoints are probed again,
  // at most once per 10 minutes per instance, and if the pin moved the message
  // is dispatched once more before the person sees an error.
  async function runDispatch(input: Parameters<typeof dispatcher.onMessage>[0]) {
    let failure: unknown;
    try {
      await dispatcher.onMessage(input);
      return;
    } catch (err) {
      failure = err;
      logger.error({ err, conversationId: input.conversationId }, "conversation dispatch failed");
    }
    if (isNoBalanceFailure(failure instanceof Error ? failure.message : String(failure))) {
      try {
        const { hermesProviderReconciler } = await import("../services/hermes-provider-reconcile.js");
        const repin = await hermesProviderReconciler(db).repinEndpoint(input.companyId);
        if (repin.repinned) {
          logger.warn({ conversationId: input.conversationId }, "[hermes-provider] re-pinned the Z.AI endpoint after a no-balance failure; retrying once");
          try {
            await dispatcher.onMessage(input);
            return;
          } catch (err) {
            failure = err;
            logger.error({ err, conversationId: input.conversationId }, "conversation dispatch failed after re-pinning");
          }
        }
      } catch (repinErr) {
        logger.warn({ err: repinErr, conversationId: input.conversationId }, "[hermes-provider] could not re-pin the Z.AI endpoint");
      }
    }
    try {
      const cos = await cosResolver.findByCompany(input.companyId);
      await postDispatchFailure(svc, {
        conversationId: input.conversationId,
        companyId: input.companyId,
        authorId: cos?.id ?? "system",
        retryMessageId: input.messageId,
        err: failure,
      });
    } catch (postErr) {
      logger.error(
        { err: postErr, conversationId: input.conversationId },
        "could not post the dispatch failure into the conversation",
      );
    }
  }

  // AgentDash (scan 3, lane G): the sender's identity, carried to the CoS so a
  // task it suggests is checked against exactly their authority and the agents
  // they may see (resolved for their own request, once).
  function senderAuthority(req: Request, companyId: string) {
    let visible: Promise<ReadonlySet<string> | null> | null = null;
    return {
      authorSource: req.actor.source ?? null,
      authorIsInstanceAdmin: req.actor.isInstanceAdmin === true,
      authorVisibleAgentIds: () => (visible ??= visibleAgentIdsFor(db, req, companyId)),
    };
  }

  function dispatchInBackground(
    input: Parameters<typeof runDispatch>[0],
    onSettled?: () => void,
  ) {
    void runDispatch(input).finally(() => onSettled?.());
  }

  // Conversations with a Retry running, so two tabs cannot dispatch twice.
  const retriesInFlight = new Set<string>();

  // POST /api/conversations/:id/messages/:messageId/retry
  // Re-runs the dispatch for one of the person's own earlier messages (the
  // Retry on a dispatch error card) without posting the message again.
  router.post("/:id/messages/:messageId/retry", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const conversation = await loadAuthorizedConversation(req);
    const message = await svc.getMessage(conversation.id, req.params.messageId as string);
    if (!message || message.role !== "user") {
      throw notFound("Message not found");
    }
    // The CoS acts with the authority of the person who sent the words, so
    // only that person may re-run them. company access (above) is not enough:
    // a teammate must not retry someone else's message under their own
    // identity. Messages from before the author was recorded are not retryable;
    // the person sends them again.
    if (!message.authorUserId || message.authorUserId !== req.actor.userId) {
      throw forbidden("Only the person who sent this message can retry it");
    }
    // Only a reply that failed or never came can be retried. Either the newest
    // agent message is the dispatch error card for exactly this message, or
    // nothing at all followed this message and it is older than the point the
    // chat calls a reply overdue (a dispatch that hung or died leaves no card).
    // Either way this must still be the person's newest message. Under that
    // guard the conversation tail is [..., this message, (the error card)]; the
    // replier skips error cards, so it answers this message exactly as the
    // original dispatch would have.
    const [lastAgent, lastUser] = await Promise.all([
      svc.latestByRole(conversation.id, "agent"),
      svc.latestByRole(conversation.id, "user"),
    ]);
    const card = lastAgent?.cardPayload as { retryMessageId?: unknown } | null | undefined;
    const failedReply =
      Boolean(lastAgent) && lastAgent!.cardKind === DISPATCH_ERROR_CARD_KIND && card?.retryMessageId === message.id;
    const sentAt = new Date(message.createdAt).getTime();
    const nothingAfter = !lastAgent || new Date(lastAgent.createdAt).getTime() <= sentAt;
    const overdue = Number.isFinite(sentAt) && Date.now() - sentAt >= STALLED_REPLY_RETRY_AFTER_MS;
    if (lastUser?.id !== message.id || !(failedReply || (nothingAfter && overdue))) {
      throw conflict("This message has no failed or missing reply to retry");
    }
    if (retriesInFlight.has(conversation.id)) {
      throw conflict("A retry for this conversation is already running");
    }
    retriesInFlight.add(conversation.id);
    dispatchInBackground(
      {
        messageId: message.id,
        conversationId: conversation.id,
        companyId: conversation.companyId,
        authorUserId: req.actor.userId,
        body: message.content,
        // The route has checked this is the message's own author.
        ...senderAuthority(req, conversation.companyId),
      },
      () => retriesInFlight.delete(conversation.id),
    );
    res.status(202).json({ ok: true, messageId: message.id });
  });

  // POST /api/conversations/:id/messages
  router.post("/:id/messages", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { body } = req.body as { body: string };
    if (typeof body !== "string" || !body.trim()) {
      throw badRequest("Message body required");
    }
    const conversation = await loadAuthorizedConversation(req);
    const companyId = conversation.companyId;
    const msg = await svc.postMessage({
      conversationId: conversation.id,
      authorKind: "user",
      authorId: req.actor.userId,
      body,
      companyId,
    });
    dispatchInBackground({
      messageId: msg.id,
      conversationId: conversation.id,
      companyId,
      authorUserId: req.actor.userId,
      body,
      ...senderAuthority(req, companyId),
    });
    res.status(201).json(msg);
  });

  // GET /api/conversations/:id/messages?before=<ts>&limit=50
  router.get("/:id/messages", async (req, res) => {
    const conversation = await loadAuthorizedConversation(req);
    const before =
      typeof req.query.before === "string" ? req.query.before : undefined;
    const limit = Math.min(
      parseInt(String(req.query.limit ?? "50"), 10) || 50,
      200,
    );
    const messages = await svc.paginate(conversation.id, { before, limit });
    res.json(messages);
  });

  // PATCH /api/conversations/:id/read
  router.patch("/:id/read", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { lastReadMessageId } = req.body as { lastReadMessageId: string };
    if (!lastReadMessageId) {
      throw badRequest("lastReadMessageId required");
    }
    const conversation = await loadAuthorizedConversation(req);
    const updated = await svc.setReadPointer(
      conversation.id,
      req.actor.userId,
      lastReadMessageId,
      conversation.companyId,
    );
    if (!updated) {
      throw badRequest("lastReadMessageId is not a message in this conversation");
    }
    res.status(204).end();
  });

  // AgentDash (scan 3, lane G): the person whose message the CoS answered
  // confirms (or declines) its "Create this task?" card. Every check runs
  // again with this request's own agent visibility and authority.
  const proposalStatus = { not_found: 404, forbidden: 403, conflict: 409, unprocessable: 422, failed: 503 } as const;

  // POST /api/conversations/:id/task-proposals/:messageId/confirm
  router.post("/:id/task-proposals/:messageId/confirm", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const conversation = await loadAuthorizedConversation(req);
    const result = await issueAction.confirmProposal({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      cardMessageId: req.params.messageId as string,
      // AgentDash (scan 4, lane N): "Create and start" starts it now (todo).
      start: (req.body as { start?: unknown } | undefined)?.start === true,
      actor: {
        userId: req.actor.userId,
        source: req.actor.source ?? null,
        isInstanceAdmin: req.actor.isInstanceAdmin === true,
        visibleAgentIds: await visibleAgentIdsFor(db, req, conversation.companyId),
      },
    });
    if (!result.ok) {
      res.status(proposalStatus[result.code]).json({ error: result.note, code: result.code });
      return;
    }
    res.status(201).json({ proposal: result.payload, issue: result.created });
  });

  // POST /api/conversations/:id/task-proposals/:messageId/dismiss
  router.post("/:id/task-proposals/:messageId/dismiss", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const conversation = await loadAuthorizedConversation(req);
    const result = await issueAction.dismissProposal({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      cardMessageId: req.params.messageId as string,
      actor: { userId: req.actor.userId },
    });
    if (!result.ok) {
      res.status(proposalStatus[result.code]).json({ error: result.note, code: result.code });
      return;
    }
    res.json({ proposal: result.payload });
  });

  // GET /api/conversations/:id/participants
  router.get("/:id/participants", async (req, res) => {
    const conversation = await loadAuthorizedConversation(req);
    const ps = await svc.listParticipants(conversation.id);
    res.json(ps);
  });

  return router;
}

// AgentDash (Phase F): minimal spec loader the cos-replier uses to fetch a
// crystallized deep_interview_specs row by id. Kept inline here (not a full
// service) because no other call site reads specs in v1.
function deepInterviewSpecsLoader(db: Db): DeepInterviewSpecsService {
  return {
    getById: async (specId: string) => {
      const rows = await db
        .select()
        .from(deepInterviewSpecsTable)
        .where(eq(deepInterviewSpecsTable.id, specId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        goal: row.goal,
        constraints: Array.isArray(row.constraints) ? (row.constraints as unknown[]) : [],
        criteria: Array.isArray(row.criteria) ? (row.criteria as unknown[]) : [],
      };
    },
  };
}
