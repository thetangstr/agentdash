// AgentDash (scan 3, lane G): the Chief of Staff hands out work from chat.
//
// The steady-state CoS reply has no tools. Instead it may end with one JSON
// trailer:
//
//   ```json
//   {"create_issue":{"title":"…","description":"…","assigneeAgentId":"…"}}
//   ```
//
// The trailer never creates anything by itself. It becomes a "Create this
// task?" card (issue_proposal_v1) that only the person whose message the CoS
// was answering can confirm. Chat messages carry no author, so in a shared
// conversation the model cannot tell who asked for the work; the confirm click
// is the requester's own, explicit consent, made in their own request.
//
// Proposing: strict zod parse, the triggering message must still be the newest
// person-written message, the assignee must be an active agent of the same
// company that the requester can see (agent visibility), never the CoS, the
// requester needs tasks:assign, and a conversation may propose at most five
// tasks per ten minutes.
//
// Confirming: the requester only; every check runs again with the confirming
// request's own visibility and authority; the card is claimed with a
// compare-and-set (pending -> creating), so two clicks or a retry create one
// issue, and the issue records the card as its origin. The issue is created
// through the normal issue service (company default status, or `todo` when the
// requester picks "Create and start"), with references synced, an
// issue.created activity entry and the assignee's wake-up.
//
// Scan 4, lane N: the card itself turns into the "Task created" card. Nothing
// else is posted (a second issue_created_v1 message used to double it); each
// state change is pushed to every open chat as message.updated instead.
//
// Every refusal is a short, polite note; nothing here throws.

import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { assistantMessages, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { accessService } from "./access.js";
import { logActivity } from "./activity-log.js";
import { agentService } from "./agents.js";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { issueReferenceService } from "./issue-references.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { defaultStatusForNewIssue, type NewIssueStatus } from "./issue-start-policy.js";
import { emitMessageUpdated } from "../realtime/conversation-events.js";

export const ISSUE_PROPOSAL_CARD_KIND = "issue_proposal_v1";
/** Legacy: older conversations hold a separate "Task created" message of this kind. */
export const ISSUE_CREATED_CARD_KIND = "issue_created_v1";
/** issues.origin_kind for a task created from a confirmed CoS proposal; origin_id is the card's message id. */
export const COS_CHAT_ORIGIN_KIND = "cos_chat_request";

export const COS_PROPOSAL_CAP = { max: 5, windowMs: 10 * 60 * 1000 } as const;

/** Exactly one issue per reply; unknown keys are refused. */
export const cosCreateIssueTrailerSchema = z
  .object({
    create_issue: z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(8000).optional(),
        assigneeAgentId: z.string().uuid(),
      })
      .strict(),
  })
  .strict();

export type CosCreateIssueRequest = z.infer<typeof cosCreateIssueTrailerSchema>["create_issue"];

/** A board user, with the agent visibility resolved for their own request. */
export interface CosIssueRequester {
  userId: string;
  /** req.actor.source — "local_implicit" is the local founder. */
  source?: string | null;
  isInstanceAdmin?: boolean;
  /** Agent ids this person may see; null means every agent (routes/visibility.ts). */
  visibleAgentIds: ReadonlySet<string> | null;
}

/** Agent statuses that can take new work. */
const ASSIGNABLE_AGENT_STATUSES = new Set(["active", "idle", "running"]);

export const COS_ISSUE_NOTES = {
  invalid:
    "I meant to suggest a task for this, but the details didn't come through cleanly, so nothing was set up. Tell me again what you'd like done and who should do it.",
  noRequester: "I can only suggest tasks when a person asks me directly, so nothing was set up.",
  superseded: "A newer message came in while I was answering, so I didn't set up a task. Ask me again if you still want it.",
  unknownAssignee: "I couldn't find that teammate in this workspace, so I didn't set up the task.",
  inactiveAssignee: (name: string) =>
    `${name} can't take new work right now, so I didn't set up the task. You can resume them from Team, or ask me to give it to someone else.`,
  forbidden:
    "You don't have permission to hand out work in this workspace, so I didn't set up the task. A workspace owner or admin can.",
  capped: "I've suggested several tasks in the last few minutes, so I'm pausing here. Ask me again in a few minutes.",
  failed: "I couldn't set up that task just now. You can add it from Work, or ask me again in a moment.",
  notRequester: "Only the person who asked for this task can confirm it.",
  alreadyHandled: "This task suggestion was already handled.",
  notFound: "That task suggestion no longer exists.",
} as const;

/** Does this trailer try to create an issue at all (valid or not)? */
export function isCreateIssueTrailer(trailer: unknown): boolean {
  return Boolean(trailer) && typeof trailer === "object" && !Array.isArray(trailer) && "create_issue" in (trailer as object);
}

export function parseCreateIssueTrailer(
  trailer: unknown,
): { ok: true; request: CosCreateIssueRequest } | { ok: false } {
  const parsed = cosCreateIssueTrailerSchema.safeParse(trailer);
  return parsed.success ? { ok: true, request: parsed.data.create_issue } : { ok: false };
}

interface ActionAgent {
  id: string;
  companyId: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status: string;
}

interface CreatedIssue {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
}

/** The pending card the CoS posts; only `requesterUserId` may confirm it. */
export interface IssueProposalPayload {
  status: "pending" | "creating" | "created" | "dismissed";
  title: string;
  description: string | null;
  assigneeAgentId: string;
  assigneeName: string;
  requesterUserId: string;
  triggerMessageId: string;
  cosAgentId: string;
  issueId?: string;
  identifier?: string | null;
  issueStatus?: string;
  /**
   * The company's status for a new issue when the card was posted. With
   * `backlog` the card offers "Create" (parks it) and "Create and start".
   */
  defaultStatus?: NewIssueStatus;
}

export interface IssueCreatedPayload {
  issueId: string;
  identifier: string | null;
  title: string;
  assigneeName: string;
  status: string;
}

export interface CosIssueActionDeps {
  getAgent: (id: string) => Promise<ActionAgent | null>;
  listAgents: (companyId: string) => Promise<ActionAgent[]>;
  canAssign: (companyId: string, requester: CosIssueRequester) => Promise<boolean>;
  /** Proposal cards posted in this conversation since `since`. */
  countRecentProposals: (conversationId: string, since: Date) => Promise<number>;
  getCard: (conversationId: string, messageId: string) => Promise<{ id: string; cardKind: string | null; cardPayload: unknown } | null>;
  /** Compare-and-set on the card's payload status; true when this caller won. */
  claimCard: (messageId: string, fromStatus: IssueProposalPayload["status"], next: IssueProposalPayload) => Promise<boolean>;
  findIssueByOrigin: (companyId: string, originId: string) => Promise<CreatedIssue | null>;
  createIssue: (
    companyId: string,
    input: {
      title: string;
      description: string | null;
      assigneeAgentId: string;
      createdByUserId: string;
      originId: string;
      /** Set only for "Create and start"; otherwise the company default applies. */
      status?: "todo";
    },
  ) => Promise<CreatedIssue>;
  syncReferences: (issueId: string) => Promise<void>;
  logActivity: (input: Parameters<typeof logActivity>[1]) => Promise<void>;
  heartbeat: () => IssueAssignmentWakeupDeps;
  /** The company's status for a new issue with none named. */
  defaultStatus?: (companyId: string) => Promise<NewIssueStatus>;
  /** Push a card's new state to every open chat (message.updated). */
  publishCardUpdate?: (input: {
    companyId: string;
    conversationId: string;
    messageId: string;
    payload: IssueProposalPayload;
  }) => void;
}

export type CosIssueProposalResult = { ok: true; payload: IssueProposalPayload } | { ok: false; note: string };

export type CosIssueConfirmResult =
  | { ok: true; issue: CreatedIssue; payload: IssueProposalPayload; created: IssueCreatedPayload }
  | { ok: false; code: "not_found" | "forbidden" | "conflict" | "unprocessable" | "failed"; note: string };

export interface CosIssueRosterEntry {
  id: string;
  name: string;
  role: string;
}

function isChiefOfStaff(agent: ActionAgent, cosAgentId: string | null): boolean {
  return agent.id === cosAgentId || agent.role === "chief_of_staff";
}

function readProposal(value: unknown): IssueProposalPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const statuses = ["pending", "creating", "created", "dismissed"];
  if (
    typeof v.status !== "string" ||
    !statuses.includes(v.status) ||
    typeof v.title !== "string" ||
    typeof v.assigneeAgentId !== "string" ||
    typeof v.requesterUserId !== "string" ||
    typeof v.cosAgentId !== "string"
  ) {
    return null;
  }
  return value as IssueProposalPayload;
}

export function cosIssueAction(deps: CosIssueActionDeps) {
  /** Best effort: a viewer who misses it still sees the new state on reload. */
  function publish(companyId: string, conversationId: string, messageId: string, payload: IssueProposalPayload) {
    try {
      deps.publishCardUpdate?.({ companyId, conversationId, messageId, payload });
    } catch (err) {
      logger.warn({ err, messageId }, "cos-issue-action: could not push the card update");
    }
  }

  /** Same-company, can take work, visible to this person, not the CoS. */
  async function checkAssignee(
    companyId: string,
    agentId: string,
    requester: CosIssueRequester,
    cosAgentId: string | null,
  ): Promise<{ ok: true; agent: ActionAgent } | { ok: false; code: "not_found" | "unprocessable"; note: string }> {
    const agent = await deps.getAgent(agentId);
    const visible = !requester.visibleAgentIds || requester.visibleAgentIds.has(agentId);
    if (!agent || agent.companyId !== companyId || !visible || isChiefOfStaff(agent, cosAgentId)) {
      return { ok: false, code: "not_found", note: COS_ISSUE_NOTES.unknownAssignee };
    }
    if (!ASSIGNABLE_AGENT_STATUSES.has(agent.status)) {
      return { ok: false, code: "unprocessable", note: COS_ISSUE_NOTES.inactiveAssignee(agent.name) };
    }
    return { ok: true, agent };
  }

  return {
    /** Agents this person may hand work to, for the steady-state prompt. */
    roster: async (companyId: string, requester: CosIssueRequester | null | undefined, cosAgentId: string | null) => {
      if (!requester?.userId) return [];
      const all = await deps.listAgents(companyId);
      return all
        .filter(
          (a) =>
            a.companyId === companyId &&
            ASSIGNABLE_AGENT_STATUSES.has(a.status) &&
            !isChiefOfStaff(a, cosAgentId) &&
            (!requester.visibleAgentIds || requester.visibleAgentIds.has(a.id)),
        )
        .map((a): CosIssueRosterEntry => ({ id: a.id, name: a.name, role: a.title || a.role || "agent" }));
    },

    /** Turn a trailer into a pending proposal card payload, or a polite note. */
    proposeFromTrailer: async (input: {
      companyId: string;
      conversationId: string;
      cosAgentId: string;
      requester: CosIssueRequester | null | undefined;
      triggerMessageId: string | null | undefined;
      /** Is the triggering message still the newest one a person wrote? */
      triggerIsNewest: boolean;
      trailer: unknown;
      now?: Date;
    }): Promise<CosIssueProposalResult> => {
      const parsed = parseCreateIssueTrailer(input.trailer);
      if (!parsed.ok) return { ok: false, note: COS_ISSUE_NOTES.invalid };
      const requester = input.requester;
      if (!requester?.userId || !input.triggerMessageId) return { ok: false, note: COS_ISSUE_NOTES.noRequester };
      if (!input.triggerIsNewest) return { ok: false, note: COS_ISSUE_NOTES.superseded };
      try {
        const checked = await checkAssignee(input.companyId, parsed.request.assigneeAgentId, requester, input.cosAgentId);
        if (!checked.ok) return { ok: false, note: checked.note };
        if (!(await deps.canAssign(input.companyId, requester))) return { ok: false, note: COS_ISSUE_NOTES.forbidden };
        const since = new Date((input.now ?? new Date()).getTime() - COS_PROPOSAL_CAP.windowMs);
        if ((await deps.countRecentProposals(input.conversationId, since)) >= COS_PROPOSAL_CAP.max) {
          return { ok: false, note: COS_ISSUE_NOTES.capped };
        }
        let defaultStatus: NewIssueStatus | undefined;
        try {
          defaultStatus = deps.defaultStatus ? await deps.defaultStatus(input.companyId) : undefined;
        } catch (err) {
          logger.warn({ err, companyId: input.companyId }, "cos-issue-action: could not read the default issue status");
        }
        return {
          ok: true,
          payload: {
            status: "pending",
            title: parsed.request.title,
            description: parsed.request.description && parsed.request.description.length > 0 ? parsed.request.description : null,
            assigneeAgentId: checked.agent.id,
            assigneeName: checked.agent.name,
            requesterUserId: requester.userId,
            triggerMessageId: input.triggerMessageId,
            cosAgentId: input.cosAgentId,
            ...(defaultStatus ? { defaultStatus } : {}),
          },
        };
      } catch (err) {
        logger.warn({ err, conversationId: input.conversationId }, "cos-issue-action: could not prepare the task");
        return { ok: false, note: COS_ISSUE_NOTES.failed };
      }
    },

    /** The requester confirms a pending proposal card; creates the issue once. */
    confirmProposal: async (input: {
      companyId: string;
      conversationId: string;
      cardMessageId: string;
      actor: CosIssueRequester;
      /** "Create and start": the issue starts as `todo` (and wakes the assignee) whatever the default. */
      start?: boolean;
    }): Promise<CosIssueConfirmResult> => {
      const card = await deps.getCard(input.conversationId, input.cardMessageId);
      const proposal = card && card.cardKind === ISSUE_PROPOSAL_CARD_KIND ? readProposal(card.cardPayload) : null;
      if (!proposal) return { ok: false, code: "not_found", note: COS_ISSUE_NOTES.notFound };
      if (proposal.requesterUserId !== input.actor.userId) {
        return { ok: false, code: "forbidden", note: COS_ISSUE_NOTES.notRequester };
      }
      if (proposal.status !== "pending") return { ok: false, code: "conflict", note: COS_ISSUE_NOTES.alreadyHandled };

      const checked = await checkAssignee(input.companyId, proposal.assigneeAgentId, input.actor, proposal.cosAgentId);
      if (!checked.ok) return checked;
      if (!(await deps.canAssign(input.companyId, input.actor))) {
        return { ok: false, code: "forbidden", note: COS_ISSUE_NOTES.forbidden };
      }

      // Claim the card: two clicks, or a retry, create one issue.
      if (!(await deps.claimCard(input.cardMessageId, "pending", { ...proposal, status: "creating" }))) {
        return { ok: false, code: "conflict", note: COS_ISSUE_NOTES.alreadyHandled };
      }

      let issue: CreatedIssue;
      try {
        issue =
          (await deps.findIssueByOrigin(input.companyId, input.cardMessageId)) ??
          (await deps.createIssue(input.companyId, {
            title: proposal.title,
            description: proposal.description,
            assigneeAgentId: checked.agent.id,
            createdByUserId: input.actor.userId,
            originId: input.cardMessageId,
            ...(input.start ? { status: "todo" as const } : {}),
          }));
      } catch (err) {
        logger.warn({ err, conversationId: input.conversationId }, "cos-issue-action: could not create the issue");
        try {
          await deps.claimCard(input.cardMessageId, "creating", { ...proposal, status: "pending" });
        } catch (releaseErr) {
          logger.warn({ err: releaseErr }, "cos-issue-action: could not release the task card");
        }
        return { ok: false, code: "failed", note: COS_ISSUE_NOTES.failed };
      }

      const done: IssueProposalPayload = {
        ...proposal,
        status: "created",
        assigneeName: checked.agent.name,
        issueId: issue.id,
        identifier: issue.identifier ?? null,
        issueStatus: issue.status,
      };
      const created: IssueCreatedPayload = {
        issueId: issue.id,
        identifier: issue.identifier ?? null,
        title: issue.title,
        assigneeName: checked.agent.name,
        status: issue.status,
      };

      // From here the issue exists; everything else is best effort.
      try {
        if (await deps.claimCard(input.cardMessageId, "creating", done)) {
          publish(input.companyId, input.conversationId, input.cardMessageId, done);
        }
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "cos-issue-action: could not mark the task card created");
      }
      try {
        await deps.syncReferences(issue.id);
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "cos-issue-action: could not sync issue references");
      }
      try {
        await deps.logActivity({
          companyId: input.companyId,
          actorType: "user",
          actorId: input.actor.userId,
          agentId: proposal.cosAgentId,
          action: "issue.created",
          entityType: "issue",
          entityId: issue.id,
          details: {
            title: issue.title,
            identifier: issue.identifier ?? null,
            source: "cos_chat",
            conversationId: input.conversationId,
            proposalMessageId: input.cardMessageId,
            triggerMessageId: proposal.triggerMessageId,
          },
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "cos-issue-action: could not log issue.created");
      }
      void queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat(),
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "cos_chat",
        requestedByActorType: "user",
        requestedByActorId: input.actor.userId,
      });
      return { ok: true, issue, payload: done, created };
    },

    /** The requester declines a pending proposal. */
    dismissProposal: async (input: {
      conversationId: string;
      cardMessageId: string;
      actor: { userId: string };
      /** For the live update to other viewers; omitted, nothing is pushed. */
      companyId?: string;
    }): Promise<{ ok: true; payload: IssueProposalPayload } | { ok: false; code: "not_found" | "forbidden" | "conflict"; note: string }> => {
      const card = await deps.getCard(input.conversationId, input.cardMessageId);
      const proposal = card && card.cardKind === ISSUE_PROPOSAL_CARD_KIND ? readProposal(card.cardPayload) : null;
      if (!proposal) return { ok: false, code: "not_found", note: COS_ISSUE_NOTES.notFound };
      if (proposal.requesterUserId !== input.actor.userId) {
        return { ok: false, code: "forbidden", note: COS_ISSUE_NOTES.notRequester };
      }
      const next: IssueProposalPayload = { ...proposal, status: "dismissed" };
      if (proposal.status !== "pending" || !(await deps.claimCard(input.cardMessageId, "pending", next))) {
        return { ok: false, code: "conflict", note: COS_ISSUE_NOTES.alreadyHandled };
      }
      if (input.companyId) publish(input.companyId, input.conversationId, input.cardMessageId, next);
      return { ok: true, payload: next };
    },
  };
}

export type CosIssueAction = ReturnType<typeof cosIssueAction>;

/**
 * The production wiring: real agents, access, issue service and heartbeat.
 * Services are built on first use, so mounting the conversation routes costs
 * nothing until the CoS actually hands out work.
 */
export function cosIssueActionForDb(db: Db): CosIssueAction {
  let agents: ReturnType<typeof agentService> | null = null;
  let access: ReturnType<typeof accessService> | null = null;
  let issues: ReturnType<typeof issueService> | null = null;
  let heartbeat: IssueAssignmentWakeupDeps | null = null;
  const getAgents = () => (agents ??= agentService(db));
  const getIssues = () => (issues ??= issueService(db));
  return cosIssueAction({
    getAgent: async (id) => (await getAgents().getById(id)) as ActionAgent | null,
    listAgents: async (companyId) => (await getAgents().list(companyId)) as ActionAgent[],
    // Same rule as the issue routes' assertCanAssignTasks for a board user.
    canAssign: async (companyId, requester) => {
      if (requester.source === "local_implicit" || requester.isInstanceAdmin) return true;
      return (access ??= accessService(db)).canUser(companyId, requester.userId, "tasks:assign");
    },
    countRecentProposals: async (conversationId, since) => {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(assistantMessages)
        .where(
          and(
            eq(assistantMessages.conversationId, conversationId),
            eq(assistantMessages.cardKind, ISSUE_PROPOSAL_CARD_KIND),
            gte(assistantMessages.createdAt, since),
          ),
        );
      return Number(rows[0]?.count ?? 0);
    },
    getCard: async (conversationId, messageId) => {
      const rows = await db
        .select({ id: assistantMessages.id, cardKind: assistantMessages.cardKind, cardPayload: assistantMessages.cardPayload })
        .from(assistantMessages)
        .where(and(eq(assistantMessages.id, messageId), eq(assistantMessages.conversationId, conversationId)))
        .limit(1);
      return rows[0] ?? null;
    },
    claimCard: async (messageId, fromStatus, next) => {
      const rows = await db
        .update(assistantMessages)
        .set({ cardPayload: next as unknown as Record<string, unknown> })
        .where(
          and(
            eq(assistantMessages.id, messageId),
            eq(assistantMessages.cardKind, ISSUE_PROPOSAL_CARD_KIND),
            sql`${assistantMessages.cardPayload} ->> 'status' = ${fromStatus}`,
          ),
        )
        .returning({ id: assistantMessages.id });
      return rows.length > 0;
    },
    findIssueByOrigin: async (companyId, originId) =>
      (await getIssues().getByOrigin(companyId, COS_CHAT_ORIGIN_KIND, originId)) as CreatedIssue | null,
    // No status: the company's default for new issues applies. "Create and
    // start" passes `todo`.
    createIssue: async (companyId, input) =>
      (await getIssues().create(companyId, {
        title: input.title,
        description: input.description,
        ...(input.status ? { status: input.status } : {}),
        priority: "medium",
        assigneeAgentId: input.assigneeAgentId,
        createdByUserId: input.createdByUserId,
        originKind: COS_CHAT_ORIGIN_KIND,
        originId: input.originId,
      } as Parameters<ReturnType<typeof issueService>["create"]>[1])) as CreatedIssue,
    syncReferences: async (issueId) => {
      await issueReferenceService(db).syncIssue(issueId);
    },
    logActivity: (input) => logActivity(db, input),
    heartbeat: () => (heartbeat ??= heartbeatService(db)),
    defaultStatus: (companyId) => defaultStatusForNewIssue(db, companyId),
    publishCardUpdate: ({ companyId, conversationId, messageId, payload }) => {
      emitMessageUpdated({
        id: messageId,
        conversationId,
        companyId,
        cardKind: ISSUE_PROPOSAL_CARD_KIND,
        cardPayload: payload as unknown as Record<string, unknown>,
      });
    },
  });
}
