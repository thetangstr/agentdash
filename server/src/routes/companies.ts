import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  deriveCompanyEmailDomain,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  budgetService,
  companyPortabilityService,
  companyService,
  feedbackService,
  logActivity,
} from "../services/index.js";
import { DomainAlreadyClaimedError } from "../services/companies.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { isBillingDisabled } from "../middleware/require-tier.js";

const PRO_LIVE = new Set(["pro_trial", "pro_active"]);

const PRO_LIVE = new Set(["pro_trial", "pro_active"]);

function isBillingDisabled(): boolean {
  if (process.env.AGENTDASH_BILLING_DISABLED === "true") return true;
  if (!process.env.STRIPE_SECRET_KEY) return true;
  return false;
}

// AgentDash (AGE-55): per-route options. Mirrors the env-var-driven flag
// from server/src/config.ts so test/integration harnesses can override.
export interface CompanyRoutesOptions {
  allowMultiTenantPerDomain?: boolean;
  // AgentDash (AGE-60): when true, reject company creation if the creator's
  // email is a free-mail address (gmail, yahoo, etc). Pro deployments turn
  // this on; self-hosted Free leaves it off so a single user with any
  // email can stand up a workspace.
  requireCorpEmail?: boolean;
  // AgentDash (#102): passed through from server startup config so the
  // POST /companies guard can check local_trusted + AGENTDASH_DEV_MODE.
  deploymentMode?: string;
  // AgentDash (#102): when true, bypass the single-company-installation guard.
  // Set by the CLI onboard --allow-multi-company flag.
  allowMultiCompany?: boolean;
}

export function companyRoutes(db: Db, storage?: StorageService, options: CompanyRoutesOptions = {}) {
  const allowMultiTenantPerDomain = options.allowMultiTenantPerDomain ?? false;
  const requireCorpEmail = options.requireCorpEmail ?? false;
  const allowMultiCompany = options.allowMultiCompany ?? false;
  const router = Router();
  const svc = companyService(db);
  const agents = agentService(db);
  const portability = companyPortabilityService(db, storage);
  const access = accessService(db);
  const budgets = budgetService(db);
  const feedback = feedbackService(db);

  // AgentDash (#102): true when the single-company-installation constraint should
  // be bypassed. Covers: AGENTDASH_ALLOW_MULTI_COMPANY env var, and the dev-mode
  // combination (local_trusted + AGENTDASH_DEV_MODE).
  function isSingleCompanyOverrideActive() {
    if (allowMultiCompany) return true;
    if (process.env.AGENTDASH_ALLOW_MULTI_COMPANY === "true") return true;
    if (
      options.deploymentMode === "local_trusted" &&
      process.env.AGENTDASH_DEV_MODE === "true"
    ) return true;
    return false;
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw badRequest(`Invalid ${field} query value`);
    }
    return parsed;
  }

  function assertImportTargetAccess(
    req: Request,
    target: { mode: "new_company" } | { mode: "existing_company"; companyId: string },
  ) {
    if (target.mode === "new_company") {
      assertInstanceAdmin(req);
      return;
    }
    assertCompanyAccess(req, target.companyId);
  }

  async function assertCanUpdateBranding(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can update company branding");
    }
  }

  async function assertCanManagePortability(req: Request, companyId: string, capability: "imports" | "exports") {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden(`Only CEO agents can manage company ${capability}`);
    }
  }

  router.get("/", async (req, res) => {
    assertBoard(req);
    const result = await svc.list();
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const allowed = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin
      ? null
      : new Set(req.actor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(filtered);
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Allow agents (CEO) to read their own company; board always allowed
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.get("/:companyId/feedback-traces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const issueId = typeof req.query.issueId === "string" && req.query.issueId.trim().length > 0 ? req.query.issueId : undefined;
    const projectId = typeof req.query.projectId === "string" && req.query.projectId.trim().length > 0
      ? req.query.projectId
      : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId,
      issueId,
      projectId,
      targetType: targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined,
      vote: voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined,
      status: statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.post("/:companyId/export", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    assertBoard(req);
    assertImportTargetAccess(req, req.body.target);
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    assertBoard(req);
    assertImportTargetAccess(req, req.body.target);
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null);
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "company.imported",
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    res.json(result);
  });

  router.post("/:companyId/exports/preview", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const preview = await portability.previewExport(companyId, req.body);
    res.json(preview);
  });

  router.post("/:companyId/exports", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/:companyId/imports/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const preview = await portability.previewImport(req.body, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    res.json(preview);
  });

  router.post("/:companyId/imports/apply", validate(companyPortabilityImportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.imported",
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
        importMode: "agent_safe",
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    // AgentDash (AGE-104): no instance-admin gate here. The FRE Plan B
    // contract (AGE-55) is that any authenticated board user can create
    // their first company and is promoted to `owner` membership below.
    // Free-mail rejection (AGE-60), domain uniqueness (AGE-55), and the
    // free single-seat cap (AGE-100) are the real safeguards.

    // AgentDash (Phase E): post-signup /company-create flow guard. When the
    // SPA's /company-create page submits, it sets ?fromSignup=1 to opt into
    // a 409 if the user already has any company membership (invite-path
    // mitigation: an invitee who navigates back must NOT double-create a
    // workspace — the UI catches the 409 and routes them to /cos). Scoped
    // to the query param so non-Better-Auth callers (CLI bootstrap, scripts,
    // e2e helpers) that legitimately create multiple companies are not
    // affected.
    if (req.query.fromSignup === "1" || req.query.fromSignup === "true") {
      const existingCompanyIds = req.actor.companyIds ?? [];
      if (existingCompanyIds.length > 0) {
        res.status(409).json({
          code: "already_member",
          existingCompanyId: existingCompanyIds[0] ?? null,
          message:
            "You're already a member of a workspace. Switch to it instead of creating a new one.",
        });
        return;
      }
    }

    // AgentDash (#102): single-workspace-per-self-hosted-installation guard.
    // Bypassed when: AGENTDASH_ALLOW_MULTI_COMPANY env var, local_trusted +
    // AGENTDASH_DEV_MODE, --allow-multi-company CLI flag, OR the existing
    // company is on a Pro plan (unlimited workspaces).
    if (!isSingleCompanyOverrideActive()) {
      const hasExisting = await svc.hasActiveCompany();
      if (hasExisting) {
        const firstCompany = await svc.list().then((cs) => cs[0] ?? null);
        const existingPlanTier = firstCompany?.planTier ?? "free";
        const isPro = isBillingDisabled() || PRO_LIVE.has(existingPlanTier);

        if (isPro) {
          // Pro installation — allow through (DB unique index handles races)
        } else {
          res.status(409).json({
            code: "single_company_installation",
            existingCompanyId: firstCompany?.id ?? null,
            message:
              "Free workspaces are limited to 1 workspace. Upgrade to Pro to create additional workspaces.",
            upgradeUrl: "/settings/billing",
          });
          return;
        }
      }
    }

    // AgentDash (AGE-55): FRE Plan B — derive email_domain from the creator's
    // authenticated email. local_implicit actors (single-machine dev) have no
    // email, so we leave the domain NULL and grandfather them in.
    let emailDomain: string | null = null;
    let creatorEmail: string | null = null;
    if (req.actor.source !== "local_implicit" && req.actor.userId) {
      const userRow = await db
        .select({ email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, req.actor.userId))
        .then((rows) => rows[0] ?? null);
      creatorEmail = userRow?.email ?? null;
      if (creatorEmail) {
        // AgentDash (AGE-60 + AGE-104): on Pro deployments, reject free-mail
        // addresses ONLY when the user is creating an additional company.
        // For a user's first company we let them through and store the full
        // email as `email_domain` (the AGE-55 fallback) so they get a
        // single personal workspace — this is what unblocks legacy WorkOS
        // webhook accounts that bypassed the AGE-104 signup-time guard.
        // The signup-time guard (corp-email-signup-guard.ts) is the real
        // safeguard for new signups.
        //
        // Derive the canonical domain first so the free-mail rejection path
        // and the storage path use identical extraction logic (no divergence).
        try {
          emailDomain = deriveCompanyEmailDomain(creatorEmail);
        } catch (err) {
          throw badRequest(`Could not derive company email domain from "${creatorEmail}"`);
        }
        // deriveCompanyEmailDomain returns the full email (e.g. alice@gmail.com)
        // for free-mail addresses, and the bare domain (e.g. acme.com) for corp
        // addresses. The presence of "@" in the result is the canonical signal.
        const isFreeMail = emailDomain.includes("@");
        const userHasExistingCompanies = (req.actor.companyIds ?? []).length > 0;
        if (requireCorpEmail && userHasExistingCompanies && isFreeMail) {
          res.status(400).json({
            code: "pro_requires_corp_email",
            error:
              "Pro accounts require a company email to create additional workspaces.",
          });
          return;
        }
        if (!allowMultiTenantPerDomain) {
          // Pre-flight check so we can surface a friendly contactEmail in the
          // 409 body. The DB unique index is the actual safety net for races.
          const existingCompany = await svc.findByEmailDomain(emailDomain);
          if (existingCompany) {
            res.status(409).json({
              code: "domain_already_claimed",
              existingCompanyId: existingCompany.id,
              message: "A workspace for this email domain already exists. Contact your administrator to join it.",
              contactEmail: null,
            });
            return;
          }
        }
      }
    }

    let company: Awaited<ReturnType<typeof svc.create>>;
    try {
      company = await svc.create({
        ...req.body,
        // When the flag is ON we still persist the domain (so the historical
        // record reflects who created it) but we skip the uniqueness check.
        // When the partial unique index would fire, the catch below converts
        // it to a 409.
        emailDomain,
      }, allowMultiTenantPerDomain);
    } catch (err) {
      if (err instanceof DomainAlreadyClaimedError) {
        res.status(409).json({
          code: "domain_already_claimed",
          // null when the winning row couldn't be re-fetched (rare race).
          existingCompanyId: err.existingCompanyId,
          contactEmail: null,
        });
        return;
      }
      throw err;
    }

    // AgentDash (AGE-55): existing behavior already promotes the creator to a
    // board ("owner") membership. We rely on that here so the at-least-one-
    // admin invariant holds from the moment the company exists.
    //
    // GH #72: owners need `agents:create` to hit the agent-hires endpoint and
    // configuration reads. setPrincipalPermission internally upserts membership
    // as "member", so it must run BEFORE the "owner" promotion below — otherwise
    // the second ensureMembership demotes the creator back to "member".
    const ownerPrincipalId = req.actor.userId ?? "local-board";
    await access.setPrincipalPermission(
      company.id,
      "user",
      ownerPrincipalId,
      "agents:create",
      true,
      ownerPrincipalId,
    );
    await access.ensureMembership(company.id, "user", ownerPrincipalId, "owner", "active");
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name, emailDomain },
    });
    if (company.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: company.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.userId ?? "board",
      );
    }
    res.status(201).json(company);
  });

  router.patch("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const existingCompany = await svc.getById(companyId);
    if (!existingCompany) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    let body: Record<string, unknown>;

    if (req.actor.type === "agent") {
      // Only CEO agents may update company branding fields
      const agentSvc = agentService(db);
      const actorAgent = req.actor.agentId ? await agentSvc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.role !== "ceo") {
        throw forbidden("Only CEO agents or board users may update company settings");
      }
      if (actorAgent.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
      body = updateCompanyBrandingSchema.parse(req.body);
    } else {
      assertBoard(req);
      body = updateCompanySchema.parse(req.body);

      if (body.feedbackDataSharingEnabled === true && !existingCompany.feedbackDataSharingEnabled) {
        body = {
          ...body,
          feedbackDataSharingConsentAt: new Date(),
          feedbackDataSharingConsentByUserId: req.actor.userId ?? "local-board",
          feedbackDataSharingTermsVersion:
            typeof body.feedbackDataSharingTermsVersion === "string" && body.feedbackDataSharingTermsVersion.length > 0
              ? body.feedbackDataSharingTermsVersion
              : DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
        };
      }
    }

    const company = await svc.update(companyId, body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    res.json(company);
  });

  router.patch("/:companyId/branding", validate(updateCompanyBrandingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanUpdateBranding(req, companyId);
    const company = await svc.update(companyId, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.branding_updated",
      entityType: "company",
      entityId: companyId,
      details: req.body,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.archive(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
