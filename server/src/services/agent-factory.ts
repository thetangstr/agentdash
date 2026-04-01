import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  agentTemplates,
  spawnRequests,
  agentOkrs,
  agentKeyResults,
  approvals,
  agents,
} from "@agentdash/db";
import { notFound, unprocessable } from "../errors.js";

type TemplateInsert = typeof agentTemplates.$inferInsert;

interface CreateTemplateData {
  slug: string;
  name: string;
  description?: string | null;
  role?: string;
  icon?: string | null;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  skillKeys?: string[];
  skills?: string[]; // alias for skillKeys
  instructionsTemplate?: string | null;
  okrs?: Array<{ objective: string; keyResults: Array<{ metric: string; target: number; unit: string }> }>;
  kpis?: Array<{ name: string; metric: string; target: number; unit: string; frequency: string }>;
  authorityLevel?: string;
  taskClassification?: string;
  estimatedCostPerTaskCents?: number | null;
  estimatedMinutesPerTask?: number | null;
  budgetMonthlyCents?: number;
  defaultBudgetCents?: number; // alias for budgetMonthlyCents
  departmentId?: string | null;
  permissions?: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
}

type UpdateTemplateData = Partial<CreateTemplateData>;

interface ListTemplateOpts {
  role?: string;
  archived?: boolean;
}

export function agentFactoryService(db: Db) {
  async function assertSlugUnique(companyId: string, slug: string, excludeId?: string) {
    const existing = await db
      .select({ id: agentTemplates.id })
      .from(agentTemplates)
      .where(
        and(
          eq(agentTemplates.companyId, companyId),
          eq(agentTemplates.slug, slug),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing && existing.id !== excludeId) {
      throw unprocessable(`Template slug "${slug}" already exists in this company`);
    }
  }

  return {
    listTemplates: async (companyId: string, opts?: ListTemplateOpts) => {
      const conditions = [eq(agentTemplates.companyId, companyId)];

      if (opts?.role) {
        conditions.push(eq(agentTemplates.role, opts.role));
      }

      const showArchived = opts?.archived ?? false;
      if (!showArchived) {
        conditions.push(isNull(agentTemplates.archivedAt));
      }

      return db
        .select()
        .from(agentTemplates)
        .where(and(...conditions));
    },

    getTemplateById: async (id: string) => {
      const template = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.id, id))
        .then((rows) => rows[0] ?? null);

      if (!template) {
        throw notFound("Agent template not found");
      }

      return template;
    },

    getTemplateBySlug: async (companyId: string, slug: string) => {
      return db
        .select()
        .from(agentTemplates)
        .where(
          and(
            eq(agentTemplates.companyId, companyId),
            eq(agentTemplates.slug, slug),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },

    createTemplate: async (companyId: string, data: CreateTemplateData) => {
      await assertSlugUnique(companyId, data.slug);

      // Resolve aliases
      const { skills, defaultBudgetCents, ...rest } = data;
      const values: TemplateInsert = {
        companyId,
        ...rest,
        skillKeys: rest.skillKeys ?? skills ?? [],
        budgetMonthlyCents: rest.budgetMonthlyCents ?? defaultBudgetCents ?? 0,
      };

      return db
        .insert(agentTemplates)
        .values(values)
        .returning()
        .then((rows) => rows[0]);
    },

    updateTemplate: async (id: string, data: UpdateTemplateData) => {
      if (data.slug) {
        const existing = await db
          .select({ companyId: agentTemplates.companyId })
          .from(agentTemplates)
          .where(eq(agentTemplates.id, id))
          .then((rows) => rows[0] ?? null);

        if (!existing) {
          throw notFound("Agent template not found");
        }

        await assertSlugUnique(existing.companyId, data.slug, id);
      }

      const updated = await db
        .update(agentTemplates)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(agentTemplates.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) {
        throw notFound("Agent template not found");
      }

      return updated;
    },

    archiveTemplate: async (id: string) => {
      const updated = await db
        .update(agentTemplates)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentTemplates.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) {
        throw notFound("Agent template not found");
      }

      return updated;
    },

    // ── Spawn Request Methods ──────────────────────────────────────────

    requestSpawn: async (
      companyId: string,
      input: {
        templateSlug?: string;
        templateId?: string;
        quantity?: number;
        reason?: string;
        projectId?: string;
        agentConfig?: Record<string, unknown>;
        requestedByAgentId?: string;
        requestedByUserId?: string;
      },
    ) => {
      // Resolve template
      let template;
      if (input.templateId) {
        template = await db
          .select()
          .from(agentTemplates)
          .where(eq(agentTemplates.id, input.templateId))
          .then((rows) => rows[0] ?? null);
      } else if (input.templateSlug) {
        template = await db
          .select()
          .from(agentTemplates)
          .where(
            and(
              eq(agentTemplates.companyId, companyId),
              eq(agentTemplates.slug, input.templateSlug),
            ),
          )
          .then((rows) => rows[0] ?? null);
      } else {
        throw unprocessable("Either templateId or templateSlug is required");
      }

      if (!template) {
        throw notFound("Agent template not found");
      }

      // Merge template defaults with input overrides
      const mergedConfig: Record<string, unknown> = {
        ...template.adapterConfig,
        ...(input.agentConfig ?? {}),
      };

      const quantity = input.quantity ?? 1;

      // Create spawn request
      const [spawnRequest] = await db
        .insert(spawnRequests)
        .values({
          companyId,
          templateId: template.id,
          requestedByAgentId: input.requestedByAgentId,
          requestedByUserId: input.requestedByUserId,
          quantity,
          reason: input.reason,
          projectId: input.projectId,
          agentConfig: mergedConfig,
          status: "pending",
        })
        .returning();

      // Create approval
      const [approval] = await db
        .insert(approvals)
        .values({
          companyId,
          type: "spawn_agents",
          requestedByAgentId: input.requestedByAgentId,
          requestedByUserId: input.requestedByUserId,
          status: "pending",
          payload: {
            spawnRequestId: spawnRequest.id,
            templateSlug: template.slug,
            quantity,
            projectId: input.projectId,
          },
        })
        .returning();

      // Link approvalId back to spawn request
      const [updatedSpawnRequest] = await db
        .update(spawnRequests)
        .set({ approvalId: approval.id, updatedAt: new Date() })
        .where(eq(spawnRequests.id, spawnRequest.id))
        .returning();

      return { spawnRequest: updatedSpawnRequest, approval };
    },

    fulfillSpawnRequest: async (spawnRequestId: string, decidedByUserId: string) => {
      const spawnRequest = await db
        .select()
        .from(spawnRequests)
        .where(eq(spawnRequests.id, spawnRequestId))
        .then((rows) => rows[0] ?? null);

      if (!spawnRequest) {
        throw notFound("Spawn request not found");
      }

      const template = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.id, spawnRequest.templateId!))
        .then((rows) => rows[0] ?? null);

      if (!template) {
        throw notFound("Agent template not found");
      }

      const quantity = spawnRequest.quantity;
      const createdAgents = [];

      for (let i = 0; i < quantity; i++) {
        const agentName = quantity > 1 ? `${template.name} ${i + 1}` : template.name;

        const [agent] = await db
          .insert(agents)
          .values({
            companyId: spawnRequest.companyId,
            name: agentName,
            role: template.role,
            adapterType: template.adapterType,
            adapterConfig: { ...template.adapterConfig, ...spawnRequest.agentConfig },
            budgetMonthlyCents: template.budgetMonthlyCents,
            departmentId: template.departmentId ?? null,
            status: "idle",
          })
          .returning();

        createdAgents.push(agent);
      }

      const spawnedAgentIds = createdAgents.map((a) => a.id);

      const [updatedSpawnRequest] = await db
        .update(spawnRequests)
        .set({
          status: "fulfilled",
          spawnedAgentIds,
          fulfilledCount: quantity,
          updatedAt: new Date(),
        })
        .where(eq(spawnRequests.id, spawnRequestId))
        .returning();

      return { agents: createdAgents, spawnRequest: updatedSpawnRequest };
    },

    listSpawnRequests: async (companyId: string, status?: string) => {
      const conditions = [eq(spawnRequests.companyId, companyId)];

      if (status) {
        conditions.push(eq(spawnRequests.status, status));
      }

      return db
        .select()
        .from(spawnRequests)
        .where(and(...conditions));
    },

    getSpawnRequestById: async (id: string) => {
      const spawnRequest = await db
        .select()
        .from(spawnRequests)
        .where(eq(spawnRequests.id, id))
        .then((rows) => rows[0] ?? null);

      if (!spawnRequest) {
        throw notFound("Spawn request not found");
      }

      return spawnRequest;
    },

    // ── OKR Methods ────────────────────────────────────────────────────

    setAgentOkrs: async (
      companyId: string,
      agentId: string,
      okrs: Array<{
        objective: string;
        goalId?: string;
        period?: string;
        periodStart?: string;
        periodEnd?: string;
        keyResults: Array<{
          metric: string;
          targetValue: string;
          unit?: string;
          weight?: string;
        }>;
      }>,
    ) => {
      // Delete existing active OKRs for this agent (cascades to key results)
      await db
        .delete(agentOkrs)
        .where(
          and(
            eq(agentOkrs.companyId, companyId),
            eq(agentOkrs.agentId, agentId),
            eq(agentOkrs.status, "active"),
          ),
        );

      const createdOkrs = [];

      for (const okr of okrs) {
        const [createdOkr] = await db
          .insert(agentOkrs)
          .values({
            companyId,
            agentId,
            goalId: okr.goalId,
            objective: okr.objective,
            status: "active",
            period: okr.period ?? "quarterly",
            periodStart: okr.periodStart ? new Date(okr.periodStart) : undefined,
            periodEnd: okr.periodEnd ? new Date(okr.periodEnd) : undefined,
          })
          .returning();

        const keyResults = [];
        for (const kr of okr.keyResults) {
          const [createdKr] = await db
            .insert(agentKeyResults)
            .values({
              companyId,
              okrId: createdOkr.id,
              metric: kr.metric,
              targetValue: kr.targetValue,
              unit: kr.unit ?? "count",
              weight: kr.weight ?? "1.0",
            })
            .returning();

          keyResults.push(createdKr);
        }

        createdOkrs.push({ ...createdOkr, keyResults });
      }

      return createdOkrs;
    },

    updateKeyResult: async (keyResultId: string, currentValue: string) => {
      const [updated] = await db
        .update(agentKeyResults)
        .set({ currentValue, updatedAt: new Date() })
        .where(eq(agentKeyResults.id, keyResultId))
        .returning();

      if (!updated) {
        throw notFound("Key result not found");
      }

      return updated;
    },

    getAgentOkrSummary: async (companyId: string, agentId: string) => {
      const okrRows = await db
        .select()
        .from(agentOkrs)
        .where(
          and(
            eq(agentOkrs.companyId, companyId),
            eq(agentOkrs.agentId, agentId),
          ),
        );

      const result = [];

      for (const okr of okrRows) {
        const keyResults = await db
          .select()
          .from(agentKeyResults)
          .where(eq(agentKeyResults.okrId, okr.id));

        result.push({ ...okr, keyResults });
      }

      return result;
    },
  };
}
