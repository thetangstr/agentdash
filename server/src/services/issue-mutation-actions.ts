// AgentDash: standalone comment acceptance. Authentication comes from the
// canonical route; these private plans/snapshots never grant authority.
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { companies, heartbeatRuns, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { addIssueCommentSchema } from "@paperclipai/shared";
import type { z } from "zod";
import { conflict, notFound } from "../errors.js";
import { issueService } from "./issues.js";
import { issueReferenceService } from "./issue-references.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { insertActivity, publishActivity, type ActivityPublication, type LogActivityInput } from "./activity-log.js";
import type { heartbeatService } from "./heartbeat.js";

export type IssueCommentExecutor = NonNullable<Parameters<ReturnType<typeof issueService>["update"]>[2]>;
type Issue = typeof issues.$inferSelect;
type CommentActor = { actorType: "agent" | "user"; actorId: string; agentId: string | null; runId: string | null };
type Runtime = Pick<ReturnType<typeof heartbeatService>, "cancelRun" | "wakeup" | "reportRunActivity">;
type ActivityIssueRelationSummary = { id: string; identifier: string | null; title: string };

export class IssueCommentPolicyRefusal extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

// Kept private to server callers; HTTP emits only the bounded body inherited
// from PolicyRefusal. Correlation proves possible acceptance, never delivery.
export class IssueCommentAcceptanceUncertain extends IssueCommentPolicyRefusal {
  constructor(readonly recovery: { mutationId: string; companyId: string; issueId: string; commentId: string | null }) {
    super(500, { error: "Comment acceptance is uncertain. Read the issue before retrying." });
  }
}

export interface IssueCommentContext {
  issueId: string;
  companyId: string;
  actor: CommentActor;
  actorKind: string;
  attribution: Record<string, unknown>;
  intent: z.infer<typeof addIssueCommentSchema>;
  // Bound by the route to the actual server-authenticated request, never a
  // synthetic request or a caller-supplied actor/grant.
  validate(executor: IssueCommentExecutor, issue: Issue): Promise<void>;
  stageAuthority?(executor: IssueCommentExecutor, issue: Issue, resolvePatch: (beforePolicy: (issue: Issue) => Promise<void>) => Promise<Record<string, unknown>>):
    Promise<{ validateIssue(issue: Issue): void; beforeWrite(issue: Issue, effectivePatch: Record<string, unknown>): Promise<void> }>;
  expectedSnapshot?: CommentIntentSnapshot;
}

// Canonical private digests ignore object insertion order, never select fields implicitly.
export function digestIssueIntentFacts(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(
      Object.entries(item).filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]),
    );
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export type CommentIntentSnapshot = ReturnType<typeof commentIntentSnapshot>;
function commentIntentSnapshot(issue: Issue, context: Pick<IssueCommentContext, "actor" | "intent">, effects: {
  reopened: boolean;
  domainPatch: unknown;
  interruptRunId: string | null;
  mentionedIds: string[];
  confirmationIds: string[];
}) {
  return {
    version: 1,
    companyId: issue.companyId,
    issueId: issue.id,
    intentDigest: createHash("sha256").update(JSON.stringify({ body: context.intent.body,
      reopen: context.intent.reopen === true, resume: context.intent.resume === true, interrupt: context.intent.interrupt === true })).digest("hex"),
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId,
    executionWorkspaceId: issue.executionWorkspaceId,
    ...(context.actor.actorType === "agent" ? { checkoutRunId: issue.checkoutRunId } : {}),
    ...(context.intent.interrupt || context.actor.actorType === "agent" ? { executionRunId: issue.executionRunId } : {}),
    reopened: effects.reopened,
    domainDigest: effects.reopened ? digestIssueIntentFacts(effects.domainPatch) : null,
    interruptRunId: effects.interruptRunId,
    mentionedIds: [...effects.mentionedIds].sort(),
    confirmationIds: [...effects.confirmationIds].sort(),
  };
}

export function summarizeIssueRelationForActivity(relation: {
  id: string;
  identifier: string | null;
  title: string;
}): ActivityIssueRelationSummary {
  return {
    id: relation.id,
    identifier: relation.identifier,
    title: relation.title,
  };
}

export function summarizeIssueReferenceActivityDetails(input:
  | {
      addedReferencedIssues: ActivityIssueRelationSummary[];
      removedReferencedIssues: ActivityIssueRelationSummary[];
      currentReferencedIssues: ActivityIssueRelationSummary[];
    }
  | null
  | undefined,
) {
  if (!input) return {};
  return {
    ...(input.addedReferencedIssues.length > 0 ? { addedReferencedIssues: input.addedReferencedIssues } : {}),
    ...(input.removedReferencedIssues.length > 0 ? { removedReferencedIssues: input.removedReferencedIssues } : {}),
    ...(input.currentReferencedIssues.length > 0 ? { currentReferencedIssues: input.currentReferencedIssues } : {}),
  };
}

export function isClosedIssueStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

export function shouldImplicitlyMoveCommentedIssueToTodo(input: {
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
  /**
   * True when the same mutation hands the closed issue to a different agent.
   * Assigning finished work to someone is itself the "more work" signal, so a
   * reassignment reopens; a plain comment does not (c4-stops: an FYI note on a
   * done/cancelled issue must not reopen it or wake the assignee).
   */
  assigneeChangedToAgent?: boolean;
}) {
  // Only human comments should implicitly reopen blocked work.
  // Agent-authored comments remain communicative unless reopen was explicit.
  if (input.actorType !== "user") return false;
  if (input.issueStatus === "blocked") {
    return typeof input.assigneeAgentId === "string" && input.assigneeAgentId.length > 0;
  }
  if (isClosedIssueStatus(input.issueStatus)) return input.assigneeChangedToAgent === true;
  return false;
}

export async function selectActiveIssueRun(executor: IssueCommentExecutor, issue: Pick<Issue, "id" | "executionRunId" | "assigneeAgentId">) {
  let run = issue.executionRunId
    ? (await executor.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, issue.executionRunId)))[0] ?? null : null;
  if (run?.status !== "running" && issue.assigneeAgentId) {
    const [active] = await executor.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, issue.assigneeAgentId), eq(heartbeatRuns.status, "running")))
      .orderBy(desc(heartbeatRuns.startedAt)).limit(1);
    if (active?.contextSnapshot?.issueId === issue.id) run = active;
  }
  return run?.status === "running" ? run : null;
}

export function issueCommentActions(db: Db, heartbeat: Runtime) {
  // Keep this root-bound. All composed primitives receive the distinct tx.
  const svc = issueService(db);
  const references = issueReferenceService(db);

  async function prepare(context: IssueCommentContext, executor: IssueCommentExecutor = db, beforePolicy?: (issue: Issue) => Promise<void>) {
    const intent = addIssueCommentSchema.parse(context.intent);
    const [company] = await executor.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, context.companyId));
    const [issue] = await executor.select().from(issues).where(eq(issues.id, context.issueId));
    if (!company || !issue || issue.companyId !== company.id) throw notFound("Issue not found");
    if (intent.interrupt && context.actorKind !== "board") {
      throw new IssueCommentPolicyRefusal(403, { error: "Only board users can interrupt active runs from issue comments" });
    }
    // AgentDash: a fresh preliminary read must be guarded before policy can
    // project protected workspace facts in a refusal.
    await beforePolicy?.(issue);
    await context.validate(executor, issue);
    const isClosed = isClosedIssueStatus(issue.status);
    const effectiveMove = intent.reopen === true || intent.resume === true ||
      shouldImplicitlyMoveCommentedIssueToTodo({ issueStatus: issue.status,
        assigneeAgentId: issue.assigneeAgentId, actorType: context.actor.actorType, actorId: context.actor.actorId });
    const blocked = issue.status === "blocked" && effectiveMove
      ? (await svc.getDependencyReadiness(issue.id, executor)).unresolvedBlockerCount > 0 : false;
    if (intent.resume && blocked) throw conflict("Issue follow-up blocked by unresolved blockers");
    const reopened = effectiveMove && (isClosed || (issue.status === "blocked" && !blocked));
    const domain = reopened ? await svc.prepareUpdate(issue.id, { status: "todo" }, executor) : null;
    const checkout = context.actor.actorType === "agent" && issue.status === "in_progress" &&
      issue.assigneeAgentId === context.actor.agentId
      ? await svc.evaluateCheckoutOwner(issue.id, context.actor.actorId, context.actor.runId!, executor) : null;
    // Select a target from accepted facts, before reopening clears run pointers.
    // The fallback matches the canonical newest active run for this assignee.
    const interruptRun = intent.interrupt ? await selectActiveIssueRun(executor, issue) : null;
    const mentionedIds = await issueService(executor as Db).findMentionedAgents(company.id, intent.body);
    // Only pending confirmations that this human comment can supersede are
    // relevant. No private prompt/result or unrelated interaction is pinned.
    const confirmations = context.actor.actorType === "user"
      ? await executor.select({ id: issueThreadInteractions.id, payload: issueThreadInteractions.payload })
        .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, company.id),
          eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "pending")))
      : [];
    const confirmationIds = confirmations
      .filter(row => "supersedeOnUserComment" in row.payload && row.payload.supersedeOnUserComment === true)
      .map(row => row.id);
    const snapshot = commentIntentSnapshot(issue, { ...context, intent }, {
      reopened, domainPatch: domain?.patch, interruptRunId: interruptRun?.id ?? null, mentionedIds, confirmationIds,
    });
    if (context.expectedSnapshot && JSON.stringify(snapshot) !== JSON.stringify(context.expectedSnapshot)) {
      throw conflict("Issue changed since comment preparation");
    }
    return { issue, intent, snapshot, checkout, reopened, isClosed, interruptRun, mentionedIds, domain };
  }

  async function accept(context: IssueCommentContext) {
    const mutationId = randomUUID();
    const publications: ActivityPublication[] = [];
    let readyToCommit = false;
    let writtenCommentId: string | null = null;
    try {
      return await db.transaction(async (tx) => {
        const [company] = await tx.select({ id: companies.id }).from(companies)
          .where(eq(companies.id, context.companyId)).for("no key update");
        if (!company) throw notFound("Issue not found");
        const [preflight] = await tx.select().from(issues).where(and(eq(issues.id, context.issueId), eq(issues.companyId, company.id)));
        if (!preflight) throw notFound("Issue not found");
        const finalAuthorityGuard = await context.stageAuthority?.(tx, preflight, async beforePolicy => (await prepare(context, tx, beforePolicy)).domain?.patch ?? {});
        await svc.lockBlockerIssues(context.issueId, company.id, [], tx);
        const [target] = await tx.select().from(issues)
          .where(and(eq(issues.id, context.issueId), eq(issues.companyId, company.id))).for("update");
        if (!target) throw notFound("Issue not found");
        finalAuthorityGuard?.validateIssue(target);
        const plan = await prepare(context, tx);
        const { issue, intent, reopened } = plan;
        const actor = context.actor;
        const reopenFromStatus = reopened ? issue.status : null;
        const audit = async (input: Omit<LogActivityInput, "companyId" | "actorType" | "actorId" | "agentId" | "runId">) => {
          publications.push(await insertActivity(tx, { companyId: company.id, ...actor, ...input,
            details: { ...input.details, mutationId } }));
        };
        await finalAuthorityGuard?.beforeWrite(issue, plan.domain?.patch ?? {});
        if (plan.checkout) {
          const ownership = await svc.applyCheckoutOwner(plan.checkout, tx);
          if (ownership.adoptedFromRunId) await audit({ action: "issue.checkout_lock_adopted", entityType: "issue", entityId: issue.id,
            details: { previousCheckoutRunId: ownership.adoptedFromRunId, checkoutRunId: actor.runId, reason: "stale_checkout_run" } });
        }
        const before = await references.listIssueReferenceSummary(issue.id, tx);
        const currentIssue = reopened ? await svc.update(issue.id, { status: "todo" }, tx) : issue;
        if (!currentIssue) throw notFound("Issue not found");
        if (reopened) await audit({ action: "issue.updated", entityType: "issue", entityId: issue.id,
          details: { status: "todo", reopened: true, reopenedFrom: reopenFromStatus, source: "comment",
            ...context.attribution, ...(intent.resume ? { resumeIntent: true, followUpRequested: true } : {}), identifier: currentIssue.identifier } });
        const comment = await svc.addComment(issue.id, intent.body, { agentId: actor.agentId ?? undefined,
          userId: actor.actorType === "user" ? actor.actorId : undefined, runId: actor.runId }, tx);
        writtenCommentId = comment.id;
        await references.syncComment(comment.id, tx);
        const diff = references.diffIssueReferenceSummary(before, await references.listIssueReferenceSummary(issue.id, tx));
        await audit({ action: "issue.comment_added", entityType: "issue", entityId: issue.id,
          details: { commentId: comment.id, bodySnippet: comment.body.slice(0, 120), identifier: currentIssue.identifier,
            issueTitle: currentIssue.title, ...context.attribution,
            ...(intent.resume ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
            ...(plan.interruptRun ? { requestedInterruptRunId: plan.interruptRun.id } : {}),
            ...summarizeIssueReferenceActivityDetails({
              addedReferencedIssues: diff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
              removedReferencedIssues: diff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
              currentReferencedIssues: diff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
            }) } });
        const expired = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(currentIssue, comment,
          { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null }, tx);
        for (const interaction of expired) await audit({ action: "issue.thread_interaction_expired", entityType: "issue", entityId: issue.id,
          details: { identifier: currentIssue.identifier ?? null, interactionId: interaction.id, interactionKind: interaction.kind,
            interactionStatus: interaction.status, source: "issue.comment", result: interaction.result ?? null } });
        readyToCommit = true;
        return { mutationId, publications, plan, actor, currentIssue, comment, reopenFromStatus };
      });
    } catch (error) {
      if (readyToCommit) {
        // The callback finished; a rejected COMMIT acknowledgement cannot prove
        // rollback. Discard publications and never retry or dispatch this plan.
        throw new IssueCommentAcceptanceUncertain({
          mutationId, companyId: context.companyId, issueId: context.issueId, commentId: writtenCommentId,
        });
      }
      throw error;
    }
  }

  async function dispatch(accepted: Awaited<ReturnType<typeof accept>>) {
    const { publications, plan, actor, currentIssue, comment, reopenFromStatus } = accepted;
    const { intent, reopened, isClosed, mentionedIds } = plan;
    const resumeRequested = intent.resume === true;
    const id = currentIssue.id;
    let interruptedRunId: string | null = null;
    const outcomes: Array<{ effect: string; targetId?: string; status: "confirmed" | "withheld" | "unknown" }> = [];
    // Every admitted result is recorded privately. No retries or replacement-run
    // lookups: a thrown dispatch may already have taken effect.
    async function effect(name: string, targetId: string | undefined, run: () => Promise<unknown>) {
      try {
        const result = await run();
        outcomes.push({ effect: name, targetId, status: result === null ? "withheld" : "confirmed" });
        return result;
      } catch {
        outcomes.push({ effect: name, targetId, status: "unknown" });
        return undefined;
      }
    }
    for (const publication of publications) await effect("publication", undefined, async () => publishActivity(publication));
    if (plan.interruptRun) {
      const cancelled = await effect("cancel", plan.interruptRun.id, async () => {
        const result = await heartbeat.cancelRun(plan.interruptRun!.id, "Interrupted by a new comment");
        // Canonical cancellation returns already-terminal runs unchanged. Only
        // a cancelled result supports interruption metadata and its audit.
        return result?.status === "cancelled" ? result : null;
      });
      if (cancelled) {
        interruptedRunId = plan.interruptRun.id;
        await effect("cancel_audit", interruptedRunId, async () => {
          const publication = await insertActivity(db, { companyId: plan.issue.companyId, ...actor,
            action: "heartbeat.cancelled", entityType: "heartbeat_run", entityId: interruptedRunId!,
            details: { agentId: plan.interruptRun!.agentId, source: "issue_comment_interrupt", issueId: id, identifier: currentIssue.identifier, mutationId: accepted.mutationId } });
          publishActivity(publication);
        });
      }
    }
    if (actor.runId) await effect("run_activity", actor.runId, () => heartbeat.reportRunActivity(actor.runId!));
    const wakeups = new Map<string, Parameters<Runtime["wakeup"]>[1]>();
    const assigneeId = currentIssue.assigneeAgentId;
    const actorIsAgent = actor.actorType === "agent";
    const selfComment = actorIsAgent && actor.actorId === assigneeId;
    const skipWake = selfComment || isClosed;
    if (assigneeId && (reopened || !skipWake)) {
      if (reopened) {
        wakeups.set(assigneeId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_reopened_via_comment",
          payload: {
            issueId: currentIssue.id,
            commentId: comment.id,
            reopenedFrom: reopenFromStatus,
            mutation: "comment",
            ...(resumeRequested ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: currentIssue.id,
            taskId: currentIssue.id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            source: "issue.comment.reopen",
            wakeReason: "issue_reopened_via_comment",
            reopenedFrom: reopenFromStatus,
            ...(resumeRequested ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      } else {
        wakeups.set(assigneeId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: {
            issueId: currentIssue.id,
            commentId: comment.id,
            mutation: "comment",
            ...(resumeRequested ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: currentIssue.id,
            taskId: currentIssue.id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            source: "issue.comment",
            wakeReason: "issue_commented",
            ...(resumeRequested ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }
    }

    // AgentDash (c4-stops review): an @-mention on a closed issue is FYI —
    // it must not start a run. Mentions wake only while the issue is open or
    // when this same comment is the explicit reopen that makes it live again.
    if (!isClosed || reopened) {
      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        });
      }
    }

    for (const [agentId, wakeup] of wakeups) {
      await effect("wakeup", agentId, () => heartbeat.wakeup(agentId, wakeup));
    }
    return { unresolved: outcomes.some(outcome => outcome.status === "unknown"), outcomes };
  }
  return { prepare, accept, dispatch };
}
