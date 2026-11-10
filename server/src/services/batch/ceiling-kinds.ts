import { and, eq, inArray } from "drizzle-orm";
import { agents, companies } from "@paperclipai/db";
import {
  agentApplyCeilingBatchChangeSchema,
  BATCH_MAX_RECORDS_UI,
  BATCH_REASON_CODES,
  diffGovernancePolicies,
  normalizeAgentGovernancePolicy,
  toV1GovernancePolicy,
  type AgentApplyCeilingBatchChange,
  type AgentGovernancePolicy,
} from "@paperclipai/shared";
import { forbidden, HttpError } from "../../errors.js";
import { visibleAgentIdsFor } from "../../routes/visibility.js";
import { accessService } from "../access.js";
import { agentGovernanceService, governanceWriteOutcome } from "../agent-governance.js";
import { ceilingTemplateService } from "../ceiling-templates.js";
import type { BatchKind, BatchKindContext, BatchKindRecord } from "./kinds.js";

/**
 * AgentDash admin powers, part 3c: apply one ceiling template to many agents.
 *
 * Each agent goes through `PUT /companies/:companyId/agents/:agentId/governance/ceiling`
 * with the template's ceiling and the agent's PREVIEWED policy revision, so the
 * route's own 409 catches a policy that moved. The preview shows each agent's
 * effective policy before and after, computed with `governanceWriteOutcome`,
 * the very function the route's write uses (the ceiling clamping the
 * steward's request), so the preview cannot promise another result.
 *
 * Only policies are stored in a batch row; nothing of an agent's
 * configuration. People with `agents:create` (the route's own rule); the guard
 * runs at preview and again at confirm. Agent ceilings exist only in the
 * `agentdash_mk` profile: elsewhere the kind is "not available" (404).
 */

type CeilingRecord = BatchKindRecord & {
  companyId: string;
  status: string;
  /** The agent's current effective policy (V1 fields) and the policy row revision. */
  effective: AgentGovernancePolicy;
  revision: number;
  /** What the route's write would make the effective policy. Null when the template is gone. */
  outcome: AgentGovernancePolicy | null;
  /** The template's ceiling as the request sends it. */
  ceiling: AgentGovernancePolicy | null;
};

const POLICY_FIELDS = ["permissions", "monthlyBudgetCents", "destructiveActions", "dataScopes", "providers", "minimumApproval"] as const;

function policyFields(policy: AgentGovernancePolicy) {
  const normalized = normalizeAgentGovernancePolicy(policy);
  return Object.fromEntries(POLICY_FIELDS.map((field) => [field, normalized[field]])) as Record<(typeof POLICY_FIELDS)[number], unknown>;
}

async function requireCeilingManagement(ctx: BatchKindContext) {
  const { req, companyId, db } = ctx;
  if (req.actor.type !== "board") throw forbidden("Board access required");
  const [company] = await db.select({ productProfile: companies.productProfile }).from(companies).where(eq(companies.id, companyId));
  if (company?.productProfile !== "agentdash_mk") throw new HttpError(404, "Agent ceilings are not available in this workspace.");
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  const allowed = await accessService(db).canUser(companyId, req.actor.userId, "agents:create");
  if (!allowed) throw forbidden("Only a company owner or administrator can change agent policy ceilings.");
}

export const agentApplyCeilingBatchKind: BatchKind<AgentApplyCeilingBatchChange, CeilingRecord> = {
  key: "agent.apply_ceiling",
  entityType: "agent",
  noun: "agent",
  maxPerBatch: BATCH_MAX_RECORDS_UI,
  parseChange: (input) => agentApplyCeilingBatchChangeSchema.parse(input),
  previewGuard: requireCeilingManagement,
  async load(ctx, ids, change) {
    const { db, req, companyId } = ctx;
    const wanted = [...new Set(ids)].filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    if (wanted.length === 0) return new Map();
    // Scoped to this company: another company's template id is simply absent.
    const template = change?.templateId ? await ceilingTemplateService(db).get(companyId, change.templateId) : null;
    const ceiling = template ? normalizeAgentGovernancePolicy(template.ceiling as AgentGovernancePolicy) : null;
    const visible = await visibleAgentIdsFor(db, req, companyId);
    const rows = await db
      .select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, wanted)));
    const governance = agentGovernanceService(db);
    const out = new Map<string, CeilingRecord>();
    for (const row of rows) {
      if (visible !== null && !visible.has(row.id)) continue;
      const view = await governance.getForAgent(companyId, row.id);
      const effective = normalizeAgentGovernancePolicy(toV1GovernancePolicy(view.effectivePolicy as AgentGovernancePolicy));
      const outcome = ceiling ? normalizeAgentGovernancePolicy(governanceWriteOutcome(view, "owner_ceiling", ceiling).effectivePolicy) : null;
      out.set(row.id, { entityType: "agent", entityId: row.id, label: row.name, companyId, status: row.status, effective, revision: view.revision, outcome, ceiling });
    }
    return out;
  },
  describe(record) {
    const before = { ...policyFields(record.effective), revision: record.revision };
    if (!record.outcome) {
      return {
        before, after: before, noop: false,
        notDecidable: { reasonCode: BATCH_REASON_CODES.templateGone, reason: "That ceiling template no longer exists, so nothing was done." },
      };
    }
    const after = { ...policyFields(record.outcome), revision: record.revision };
    const { gains, losses } = diffGovernancePolicies(record.effective, record.outcome);
    if (gains.length === 0 && losses.length === 0) return { before, after, noop: true };
    if (record.status === "terminated") {
      return {
        before, after, noop: false,
        notDecidable: { reasonCode: BATCH_REASON_CODES.agentNotManageable, reason: `${record.label} has been removed, so it was left out.` },
      };
    }
    const notes = [
      ...gains.map((change) => `Gains: ${change.text}`),
      ...losses.map((change) => `Loses: ${change.text}`),
      ...(losses.length > 0
        ? ["Anything it holds above the new ceiling is brought down at once: a larger budget, permissions, channel connections and waiting sends through providers it no longer allows."]
        : []),
    ];
    return { before, after, noop: false, notes };
  },
  // The effective policy is the outcome; the route raises the revision.
  observe: (record) => policyFields(record.effective),
  request(record, _change, item) {
    const previewedRevision = typeof item.before.revision === "number" ? item.before.revision : record.revision;
    return {
      method: "PUT",
      path: `/api/companies/${record.companyId}/agents/${record.entityId}/governance/ceiling`,
      body: { policy: record.ceiling ?? record.effective, revision: previewedRevision, channel: "web" },
    };
  },
};
