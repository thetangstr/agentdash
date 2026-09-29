import type { Request } from 'express';
import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { authUsers, companyMemberships, issues, issueThreadInteractions } from '@paperclipai/db';
import { askUserQuestionsPayloadSchema, type WaitingOnYouQuestion } from '@paperclipai/shared';
import { projectScopedVisibilityCondition } from '../routes/visibility.js';
import type { Db } from "@paperclipai/db";
import { assistantDigestService } from "./assistant-digest.js";
import { approvalAuthorityService } from "./approval-authority.js";
import { approvalService, issueApprovalService } from "./index.js";
import {
  APPROVAL_KIND_PHRASES,
  decisionConsequences,
  scopeAndRankOpenApprovals,
  type WaitingApprovalLike as ApprovalLike,
} from "./waiting-on-you-rules.js";

/**
 * AgentDash: UX-3 (#784) — the ONE definition of "waiting on you".
 *
 * Before this module the definition lived inline in the assistant route and a
 * second copy lived in the web dashboard (`awaitingCount = pendingApprovals`),
 * and the two disagreed: the dashboard said "awaiting you 0, all clear" beside
 * an inbox full of issues assigned to the person. Now the assistant's
 * `list_pending_decisions` (through GET /assistant/pending-decisions), the
 * weekly `whats_new` digest (through `scopeAndRankOpenApprovals`) and the web
 * Home (the same route) all read from here.
 *
 * Waiting on you =
 *   1. open approvals (`pending` or `revision_requested`) requested by an
 *      agent this person answers for (stewarded or accountable, see
 *      `assistantDigestService.audienceAgents`), plus agentless board-filed
 *      approvals, most urgent first by the board's risk order, then longest
 *      wait; and
 *   2. open issues (not done, not cancelled, not hidden) assigned to the
 *      person (`assistantDigestService.tasksAssignedTo`); and
 *   3. pending questions pinned to that active human, within issue visibility.
 *
 * A user-less board actor (the local bootstrap operator) answers for the whole
 * company for approvals and assigned issues. Named questions require a user identity.
 */

export {
  APPROVAL_KIND_PHRASES,
  WAITING_APPROVAL_STATUSES,
  scopeAndRankOpenApprovals,
} from "./waiting-on-you-rules.js";

export interface WaitingOnYouActor {
  userId?: string | null;
  [key: string]: unknown;
}

export function waitingOnYouService(db: Db) {
  const digest = assistantDigestService(db);
  const authority = approvalAuthorityService(db);
  const approvals = approvalService(db);
  const issueApprovals = issueApprovalService(db);

  async function pendingQuestions(companyId: string, actor: WaitingOnYouActor) {
    // A memberless local operator has no named answer identity. It does not
    // inherit someone else's questions or become an arbitrary answer owner.
    if (!actor.userId) return { items: [] as WaitingOnYouQuestion[], total: 0 };
    const ownerId = sql<string>`${issueThreadInteractions.payload} ->> 'answerOwnerUserId'`;
    const visibility = projectScopedVisibilityCondition({ actor: { ...actor, type: 'board' } } as Request, companyId, issues.projectId);
    const rows = await db.select({
      interactionId: issueThreadInteractions.id, issueId: issues.id, identifier: issues.identifier,
      issueTitle: issues.title, title: issueThreadInteractions.title, payload: issueThreadInteractions.payload,
      createdAt: issueThreadInteractions.createdAt, ownerName: authUsers.name, total: sql<number>`count(*) over()`,
    }).from(issueThreadInteractions)
      .innerJoin(issues, and(eq(issues.id, issueThreadInteractions.issueId), eq(issues.companyId, companyId)))
      .innerJoin(companyMemberships, and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, 'user'), eq(companyMemberships.principalId, actor.userId), eq(companyMemberships.status, 'active')))
      .leftJoin(authUsers, eq(authUsers.id, actor.userId))
      .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.kind, 'ask_user_questions'), eq(issueThreadInteractions.status, 'pending'), eq(ownerId, actor.userId), isNull(issues.hiddenAt), notInArray(issues.status, ['done', 'cancelled']), visibility))
      .orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id)).limit(50);
    return {
      total: Number(rows[0]?.total ?? 0),
      items: rows.map(row => ({
        interactionId: row.interactionId, issueId: row.issueId, identifier: row.identifier,
        issueTitle: row.issueTitle, title: row.title ?? 'Input requested',
        questionSummary: askUserQuestionsPayloadSchema.parse(row.payload).questions.map(q => q.prompt).join(' ').slice(0, 1000),
        waitingSince: row.createdAt.toISOString(), answerOwnerUserId: actor.userId!, answerOwnerName: row.ownerName ?? actor.userId!,
      })),
    };
  }

  return {
    /**
     * The pending-decisions payload: approvals with `canDecide` computed per
     * row by probing the one authority service, plus the person's open
     * issues. A `canDecide:false` row is still listed: "Priya's request is
     * waiting but you cannot decide it" is an answer a person needs.
     */
    list: async (companyId: string, actor: WaitingOnYouActor, opts: { decisionLimit?: number } = {}) => {
      const userId = actor.userId ?? null;
      const rows = await approvals.list(companyId, undefined);
      const audience = await digest.audienceAgents(companyId, userId);
      const nameById = new Map(audience.map((agent) => [agent.id, agent.name]));
      const ranked = scopeAndRankOpenApprovals(rows as ApprovalLike[], new Set(nameById.keys()));

      const decisions = await Promise.all(
        ranked.slice(0, opts.decisionLimit ?? 50).map(async ({ approval, risk }) => {
          let canDecide = false;
          try {
            // Match the real decision path: requireDecisionActor returns null
            // when the company needs no decision role (non-MK), and the caller
            // substitutes "admin" — null means allowed, not refused. Only a
            // thrown refusal means this person cannot decide.
            await authority.requireDecisionActor(approval as never, actor as never);
            canDecide = true;
          } catch {
            canDecide = false;
          }
          const linked = await issueApprovals.listIssuesForApproval(approval.id).catch(() => []);
          const first = Array.isArray(linked) ? linked[0] : null;
          const phrase = APPROVAL_KIND_PHRASES[approval.type] ?? `act on "${approval.type}"`;
          const asker = approval.requestedByAgentId
            ? nameById.get(approval.requestedByAgentId) ?? "An agent"
            : "The board";
          return {
            approvalId: approval.id,
            kind: approval.type,
            revision: (approval as ApprovalLike & { revision?: number }).revision,
            askedBy: approval.requestedByAgentId ? nameById.get(approval.requestedByAgentId) ?? null : null,
            summary: `${asker} asks to ${phrase}.`,
            relatedItem: first
              ? { id: first.id, identifier: first.identifier ?? null, title: first.title ?? null }
              : null,
            waitingSince: approval.createdAt?.toISOString?.() ?? null,
            canDecide,
            risk,
            // UX-7 (#788): the Decisions row states what yes/no do without
            // opening the detail — same phrasing family as the assistant's
            // confirm read-back.
            effects: decisionConsequences(approval),
          };
        }),
      );

      const tasks = await digest.tasksAssignedTo(companyId, userId);
      const questions = await pendingQuestions(companyId, actor);
      return {
        decisions,
        pendingQuestions: questions.items,
        pendingQuestionsTotal: questions.total,
        total: ranked.length,
        shown: decisions.length,
        // UX-7 (#788): the manual/machine split is decided here, not in any
        // client. `tasksAssignedToYou` is the main list (manual-origin
        // issues only) and `tasksAssignedToYouTotal` is its uncapped count —
        // so Home, the Decisions page, the sidebar badge and the assistant's
        // list_pending_decisions all read the same number. Machine-filed
        // issues live in `otherTasksAssignedToYou`.
        tasksAssignedToYou: tasks.manual.items,
        tasksAssignedToYouTotal: tasks.manual.total,
        otherTasksAssignedToYou: tasks.other.items,
        otherTasksAssignedToYouTotal: tasks.other.total,
      };
    },
  };
}
