import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import {
  pushHarnessAgentPolicySchema,
  updateAgentGovernancePolicySchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { agentAccountabilityService } from "../services/agent-accountability.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { requireProductProfile } from "../services/companies.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { requireActiveStewardHarness } from "./agentdash-mk-harness-auth.js";

export function agentGovernanceRoutes(db: Db) {
  const router = Router();
  const governance = agentGovernanceService(db);
  const access = accessService(db);

  /**
   * Profile gate. Non-`agentdash_mk` companies must be indistinguishable from a
   * company that does not exist, so this 404s rather than 403s.
   */
  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  async function isAdministrator(req: Request, companyId: string) {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return access.canUser(companyId, req.actor.userId, "agents:create");
  }

  /** Owner/admin only — ceilings are never steward-editable. */
  async function requireCeilingAuthority(req: Request, companyId: string) {
    assertBoard(req);
    if (await isAdministrator(req, companyId)) return;
    throw forbidden("Only a company owner or administrator can change agent policy ceilings");
  }

  /** The agent's current steward, or an administrator acting on their behalf. */
  async function requireRequestAuthority(req: Request, companyId: string, agentId: string) {
    assertBoard(req);
    const authority = await governance.resolveConfigurationAuthority(companyId, agentId, req.actor);
    if (authority) return authority;
    throw forbidden("Only the assigned steward or an authorized administrator can configure this agent");
  }

  /**
   * Read authority over the enforced policy: the agent's ACCOUNTABLE party
   * (AGE-3).
   *
   * Stewardship makes exactly one human answerable for an agent, and an
   * accountable human who cannot read the policy being enforced against their
   * agent is accountable in name only. The configuration guard above is the
   * wrong rule for a read: it authorizes the ACTIVE STEWARDSHIP holder and the
   * creator, so for an autonomous agent — which by design has no stewardship
   * row — the accountable human named on `agents.accountable_user_id` falls
   * through to 403.
   *
   * `agentAccountabilityService` is the one shared definition of "who answers
   * for this agent" (active steward for a stewarded agent, the assigned
   * accountable human for an autonomous one) and is already the rule for
   * approval decisions and escalations. This is deliberately a READ-ONLY
   * branch: every write route keeps `requireCeilingAuthority` /
   * `requireRequestAuthority`, and `harness-request` remains the only channel
   * that narrows the steward request.
   */
  async function requirePolicyReadAuthority(req: Request, companyId: string, agentId: string) {
    assertBoard(req);
    const authority = await governance.resolveConfigurationAuthority(companyId, agentId, req.actor);
    if (authority) return;
    const accountable = await agentAccountabilityService(db).resolveForAgent(companyId, agentId);
    if (accountable?.userId && accountable.userId === req.actor.userId) return;
    throw forbidden("Only the agent's accountable party or an authorized administrator can read this policy");
  }

  router.get("/companies/:companyId/agents/:agentId/governance", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await requireProfileCompany(req, companyId);
    await requirePolicyReadAuthority(req, companyId, agentId);
    res.json({ policy: await governance.getForAgent(companyId, agentId) });
  });

  router.put(
    "/companies/:companyId/agents/:agentId/governance/ceiling",
    validate(updateAgentGovernancePolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      await requireProfileCompany(req, companyId);
      await requireCeilingAuthority(req, companyId);

      const policy = await governance.updateOwnerCeiling(companyId, agentId, {
        policy: req.body.policy,
        revision: req.body.revision,
        actorUserId: req.actor.userId ?? null,
        channel: req.body.channel ?? "web",
      });
      res.json({ policy });
    },
  );

  router.put(
    "/companies/:companyId/agents/:agentId/governance/request",
    validate(updateAgentGovernancePolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      await requireProfileCompany(req, companyId);
      await requireRequestAuthority(req, companyId, agentId);

      const policy = await governance.updateStewardRequest(companyId, agentId, {
        policy: req.body.policy,
        revision: req.body.revision,
        actorUserId: req.actor.userId ?? null,
        channel: req.body.channel ?? "web",
      });
      res.json({ policy });
    },
  );

  /**
   * AgentDash-MK: the harness's ceiling write.
   *
   * Same target as `/governance/request` — the steward request — because the
   * harness is the steward's instrument, not a third authority. What differs is
   * the failure mode: over-ceiling values are CLAMPED here rather than 422'd,
   * so a harness that asks for too much ends up more constrained instead of
   * leaving the previous, broader request in force. See
   * `pushHarnessStewardRequest` for why that direction is the safe one.
   *
   * Steward-only, like directives. An administrator has `/governance/ceiling`
   * and `/governance/request`; routing them through the clamping path would
   * silently discard an admin's over-ceiling intent instead of telling them.
   */
  router.put(
    "/companies/:companyId/agents/:agentId/governance/harness-request",
    validate(pushHarnessAgentPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      await requireProfileCompany(req, companyId);
      const active = await requireActiveStewardHarness(
        db,
        req,
        companyId,
        agentId,
        "Only the agent's active steward can push a harness ceiling",
      );

      const { policy, clamped } = await governance.pushHarnessStewardRequest(companyId, agentId, {
        policy: req.body.policy,
        revision: req.body.revision,
        actorUserId: active.userId,
      });
      res.json({ policy, clamped });
    },
  );

  return router;
}
