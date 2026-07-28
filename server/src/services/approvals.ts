import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
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
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
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

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

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
          await agentsSvc.activatePendingApproval(payloadAgentId);
          hireApprovedAgentId = payloadAgentId;
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
      );

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
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
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}
