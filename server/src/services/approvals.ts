import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvalComments, approvals, assistantConversations, assistantMessages, bridgeTasks } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactRunLogText } from "./run-log-redaction.js";
import { emitMessageUpdated } from "../realtime/conversation-events.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";
import { elapsedMsBetween, workflowEventsService } from "./workflow-events.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const workflow = workflowEventsService(db);

  /**
   * AgentDash-MK measurement: which run this approval is a step of.
   *
   * An approval that gates a bridge task is not its own run — it is the middle
   * step of one, between the agent opening the escalation and the endpoint
   * executing it. Correlating here is what makes "% of steps completed with no
   * human touch" a real fraction today rather than a constant, because the
   * bridge act flow is the only genuinely multi-step, mixed-actor run that
   * exists before the deliverable pipeline lands.
   *
   * Neither key names a person: `bridge:act` and `approval:hire_agent` are
   * kinds of work, and the run ids are work items.
   */
  async function resolveWorkflowRun(approval: { id: string; type: string }) {
    const linked = await db
      .select({ id: bridgeTasks.id, taskClass: bridgeTasks.taskClass })
      .from(bridgeTasks)
      .where(eq(bridgeTasks.approvalId, approval.id))
      .then((rows) => rows[0] ?? null);
    return linked
      ? { pipelineId: `bridge:${linked.taskClass}`, runId: linked.id, taskClass: linked.taskClass }
      : { pipelineId: `approval:${approval.type}`, runId: approval.id, taskClass: undefined };
  }
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  /**
   * AgentDash-MK decision provenance. All optional so default-profile callers
   * keep the pre-existing contract; the approval-authority service is what
   * makes them mandatory inside `agentdash_mk`.
   */
  type DecisionMeta = {
    revision?: number;
    channel?: string | null;
    idempotencyKey?: string | null;
    actorRole?: string | null;
    overrideReason?: string | null;
  };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      // AgentDash (GH #992): agent-authored approval comments are persisted
      // redacted (addComment), but the serve pass also covers human comments
      // and rows written before the persist pass shipped.
      body: redactRunLogText(redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs })),
    };
  }

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
    meta: DecisionMeta = {},
    /**
     * Runs once the approval is known to be decidable and before the decision
     * is written, so a refusal here leaves the approval untouched. Replays and
     * already-decided approvals never reach it.
     */
    beforeApply?: (existing: ApprovalRecord) => Promise<void>,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id);

    // Idempotent replay: the same key on the same approval returns the original
    // terminal result and performs no side effects. This is what makes a
    // redelivered Telegram/Teams callback safe.
    if (meta.idempotencyKey && existing.decisionIdempotencyKey === meta.idempotencyKey) {
      if (existing.status !== targetStatus) {
        // Same key, different intent: that is a client bug or a replayed
        // callback crossed with another. Say so rather than silently returning
        // the opposite decision as if it had been honoured.
        throw conflict("Idempotency key was already used for a different decision on this approval", {
          code: "APPROVAL_IDEMPOTENCY_KEY_CONFLICT",
          recordedStatus: existing.status,
          requestedStatus: targetStatus,
        });
      }
      return { approval: existing, applied: false };
    }

    // The uniqueness constraint is company-wide, so a key already spent on a
    // DIFFERENT approval must be a clean 409 rather than a raw 23505 surfacing
    // as a 500.
    if (meta.idempotencyKey) {
      const keyOwner = await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, existing.companyId),
            eq(approvals.decisionIdempotencyKey, meta.idempotencyKey),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (keyOwner && keyOwner.id !== existing.id) {
        throw conflict("Idempotency key was already used for a different approval", {
          code: "APPROVAL_IDEMPOTENCY_KEY_CONFLICT",
          conflictingApprovalId: keyOwner.id,
        });
      }
    }

    if (meta.revision !== undefined && existing.revision !== meta.revision) {
      throw conflict("Approval changed since this decision was requested", {
        code: "APPROVAL_REVISION_CONFLICT",
        expectedRevision: meta.revision,
        currentRevision: existing.revision,
      });
    }

    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    if (beforeApply) await beforeApply(existing);

    const now = new Date();
    const updated = await db
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
        ...(meta.channel !== undefined ? { decisionChannel: meta.channel } : {}),
        ...(meta.idempotencyKey !== undefined ? { decisionIdempotencyKey: meta.idempotencyKey } : {}),
        ...(meta.actorRole !== undefined ? { decisionActorRole: meta.actorRole } : {}),
        ...(meta.overrideReason !== undefined ? { overrideReason: meta.overrideReason } : {}),
      })
      .where(
        and(
          eq(approvals.id, id),
          inArray(approvals.status, resolvableStatuses),
          // Fold the revision into the conditional update so two concurrent
          // deciders cannot both pass the check above and both write.
          ...(meta.revision !== undefined ? [eq(approvals.revision, meta.revision)] : []),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      // Measurement, and only on the branch where the write actually applied —
      // the idempotent-replay returns above are the same decision arriving
      // twice, and counting them twice would inflate the very number the
      // instrument exists to watch fall.
      const run = await resolveWorkflowRun(updated);
      await workflow.emit({
        companyId: updated.companyId,
        pipelineId: run.pipelineId,
        runId: run.runId,
        stepKey: "approval",
        eventType: "approval_decided",
        // A named human decided. What is recorded is that a human did.
        actorKind: "human",
        durationMs: elapsedMsBetween(updated.createdAt, now),
        payload: {
          approvalType: updated.type,
          decision: targetStatus,
          channel: meta.channel ?? null,
          actorRole: meta.actorRole ?? null,
          override: Boolean(meta.overrideReason),
        },
      });
      return { approval: updated, applied: true };
    }

    if (meta.revision !== undefined) {
      // The pre-check passed but the conditional update matched nothing, so a
      // concurrent decider moved the row between the two. Fail closed.
      const current = await getExistingApproval(id);
      if (current.revision !== meta.revision) {
        throw conflict("Approval changed since this decision was requested", {
          code: "APPROVAL_REVISION_CONFLICT",
          expectedRevision: meta.revision,
          currentRevision: current.revision,
        });
      }
    }

    const latest = await getExistingApproval(id);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  function hirePayloadAgentId(approval: { payload: unknown }) {
    const payload =
      typeof approval.payload === "object" && approval.payload !== null
        ? (approval.payload as Record<string, unknown>)
        : {};
    return typeof payload.agentId === "string" ? payload.agentId : null;
  }

  /**
   * A hire approval decides whether a PENDING agent becomes a working one.
   *
   * Rejecting it used to terminate the named agent unconditionally. When the
   * agent had already been activated some other way (approved from its own
   * page, which left the approval pending), a later reject of that stale
   * approval terminated a working, connected agent and revoked its keys. The
   * question the approval asked has already been answered, so the reject is
   * refused rather than applied: 409, the approval left as it is, and the
   * message says how to end the agent if that is really what is wanted.
   *
   * An agent that is already terminated is not refused — rejecting its hire
   * changes nothing and clears the stale approval.
   */
  async function refuseRejectingActivatedHire(existing: ApprovalRecord) {
    if (existing.type !== "hire_agent") return;
    const payloadAgentId = hirePayloadAgentId(existing);
    if (!payloadAgentId) return;
    const target = await agentsSvc.getById(payloadAgentId);
    if (!target || target.companyId !== existing.companyId) return;
    if (target.status === "pending_approval" || target.status === "terminated") return;
    throw conflict(
      `${target.name} is already active, so rejecting this hire request would terminate a working agent. ` +
        "It was activated outside this approval (for example from its own page). " +
        "To remove the agent, terminate it from its page.",
      {
        code: "HIRE_APPROVAL_AGENT_ALREADY_ACTIVE",
        agentId: target.id,
        agentStatus: target.status,
      },
    );
  }

  /**
   * The still-open `hire_agent` approvals that name this agent.
   *
   * Used by the agent page's approve, which activates the agent directly and
   * must then decide these too. It decides them through `approve` rather than
   * writing the rows, so the side effects the approval path owns (budget
   * policy, hire hook, workflow measurement) are the same whichever surface
   * activated the agent.
   */
  async function listPendingHireApprovalsForAgent(companyId: string, agentId: string) {
    const rows = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.type, "hire_agent"),
          inArray(approvals.status, resolvableStatuses),
          sql`${approvals.payload}->>'agentId' = ${agentId}`,
        ),
      );
    return rows;
  }

  /**
   * AgentDash (cos-followups-2 item 4): a decided hire approval must move the
   * CoS plan card off "Sent for approval" — the card payload is the only
   * state that survives a reload. The card stays pending while any sibling
   * hire still waits, reads "Not approved" once a rejection lands, and only
   * returns to "Team hired" when every hire has been approved. Called after
   * the agent lifecycle write so `pending_approval` siblings are counted with
   * this decision already applied.
   */
  async function updateCosPlanCardOnHireDecision(
    companyId: string,
    agentId: string,
    rejected: boolean,
  ) {
    // select().from().where() is the only chain the lightweight db stubs
    // implement — keep it flat (no join/orderBy/limit) and pick the latest
    // matching card below.
    const rows = await db
      .select({
        id: assistantMessages.id,
        conversationId: assistantMessages.conversationId,
        createdAt: assistantMessages.createdAt,
        cardPayload: assistantMessages.cardPayload,
      })
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.cardKind, "agent_plan_proposal_v1"),
          sql`exists (
            select 1
            from jsonb_array_elements_text(${assistantMessages.cardPayload} -> 'confirmedAgentIds') as confirmed_id
            where confirmed_id = ${agentId}
          )`,
          inArray(
            assistantMessages.conversationId,
            db
              .select({ id: assistantConversations.id })
              .from(assistantConversations)
              .where(eq(assistantConversations.companyId, companyId)),
          ),
        ),
      );
    const message = rows.sort(
      (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
    )[0];
    const payload = message?.cardPayload;
    if (!message || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const cardPayload = payload as Record<string, unknown>;
    const confirmedIds = Array.isArray(cardPayload.confirmedAgentIds)
      ? cardPayload.confirmedAgentIds.filter((id): id is string => typeof id === "string")
      : [];
    const siblings = confirmedIds.length > 0
      ? await db
          .select({ status: agents.status })
          .from(agents)
          .where(inArray(agents.id, confirmedIds))
      : [];
    const stillPending = siblings.some((sibling) => sibling.status === "pending_approval");
    const next = {
      ...cardPayload,
      pendingApproval: stillPending,
      approvalRejected: rejected || cardPayload.approvalRejected === true,
    };
    await db
      .update(assistantMessages)
      .set({ cardPayload: next })
      .where(eq(assistantMessages.id, message.id));
    emitMessageUpdated({ ...message, companyId, cardPayload: next });
  }

  return {
    listPendingHireApprovalsForAgent,

    // AgentDash (GH #902): `visibleWhere` is the caller's restricted-project
    // condition over approvals (budget overrides name their project).
    list: (companyId: string, status?: string, opts: { visibleWhere?: SQL } = {}) => {
      const conditions: SQL[] = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      if (opts.visibleWhere) conditions.push(opts.visibleWhere);
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    create: async (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) => {
      const created = await db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
      if (created) {
        await workflow.emit({
          companyId,
          pipelineId: `approval:${created.type}`,
          runId: created.id,
          stepKey: "approval",
          eventType: "approval_requested",
          // Whether the work stopped on an agent's own initiative or a person's
          // is a fact about the workflow. Which agent, or which person, is not.
          actorKind: created.requestedByAgentId ? "agent" : "human",
          payload: { approvalType: created.type },
        });
      }
      return created;
    },

    approve: async (
      id: string,
      decidedByUserId: string,
      decisionNote?: string | null,
      meta: DecisionMeta = {},
    ) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
        meta,
      );

      let hireApprovedAgentId: string | null = null;
      const now = new Date();
      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          // The payload is caller-supplied, so confirm the named agent belongs
          // to this approval's company before touching its lifecycle.
          const target = await agentsSvc.getById(payloadAgentId);
          if (!target || target.companyId !== updated.companyId) {
            throw unprocessable("Hire approval references an agent outside this company");
          }
          // Budget policy and the adapter hire hook belong to the moment the
          // agent is activated. When this approval is decided after the agent
          // was already activated some other way (its own page), activation is
          // a no-op, and re-running them would overwrite a budget changed
          // since and fire the hook a second time.
          const activation = await agentsSvc.activatePendingApproval(payloadAgentId);
          if (activation?.activated) hireApprovedAgentId = payloadAgentId;
          await updateCosPlanCardOnHireDecision(updated.companyId, payloadAgentId, false);
        } else {
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            role: String(payload.role ?? "general"),
            title: typeof payload.title === "string" ? payload.title : null,
            reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
            capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
            adapterType: String(payload.adapterType ?? "process"),
            adapterConfig:
              typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                ? (payload.adapterConfig as Record<string, unknown>)
                : {},
            budgetMonthlyCents:
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
            metadata:
              typeof payload.metadata === "object" && payload.metadata !== null
                ? (payload.metadata as Record<string, unknown>)
                : null,
            status: "idle",
            spentMonthlyCents: 0,
            permissions: undefined,
            lastHeartbeatAt: null,
          });
          hireApprovedAgentId = created?.id ?? null;
        }
        if (hireApprovedAgentId) {
          const budgetMonthlyCents =
            typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
          if (budgetMonthlyCents > 0) {
            await budgets.upsertPolicy(
              updated.companyId,
              {
                scopeType: "agent",
                scopeId: hireApprovedAgentId,
                amount: budgetMonthlyCents,
                windowKind: "calendar_month_utc",
              },
              decidedByUserId,
            );
          }
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      return { approval: updated, applied };
    },

    reject: async (
      id: string,
      decidedByUserId: string,
      decisionNote?: string | null,
      meta: DecisionMeta = {},
    ) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
        meta,
        refuseRejectingActivatedHire,
      );

      if (applied && updated.type === "hire_agent") {
        const payloadAgentId = hirePayloadAgentId(updated);
        if (payloadAgentId) {
          const target = await agentsSvc.getById(payloadAgentId);
          if (!target || target.companyId !== updated.companyId) {
            throw unprocessable("Hire approval references an agent outside this company");
          }
          // Conditional in the terminating statement itself: the guard above
          // ran before the decision was written, and an agent activated in
          // between must still not be killed by a decision about whether to
          // hire it. An already-terminated agent is left as it is.
          await agentsSvc.terminate(payloadAgentId, {
            endedByUserId: decidedByUserId,
            onlyIfStatus: "pending_approval",
          });
          await updateCosPlanCardOnHireDecision(updated.companyId, payloadAgentId, true);
        }
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          // A resubmit changes what is being asked, so it advances the revision:
          // any card or button issued against the previous revision is now stale
          // and must fail closed rather than decide the new request.
          revision: existing.revision + 1,
          // This is precisely the supersede event, so record when it happened.
          supersededAt: now,
          decisionChannel: null,
          decisionIdempotencyKey: null,
          decisionActorRole: null,
          overrideReason: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      // AgentDash (GH #992): agent-authored comments persist redacted — the
      // body is model output that can echo a credential. Human comments stay
      // raw in the row and are redacted only when served.
      const persistedBody = actor.agentId ? redactRunLogText(redactedBody) : redactedBody;
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: persistedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}
