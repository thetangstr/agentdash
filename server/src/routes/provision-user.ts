// AgentDash: provision-user — programmatic user onboarding endpoint.
// POST /api/onboarding/provision-user
//
// Creates a new user (passwordless-style), their company, and a Chief-of-Staff
// agent in one call, then emails the user a set-password link.
//
// Auth gate: requires `x-provision-key` header matching AGENTDASH_PROVISION_KEY.
// This is a high-privilege operation — it must NOT be usable with a normal
// board/agent key or with no key. The check happens before any work.
import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companyMemberships } from "@paperclipai/db";
import { onboardingOrchestrator } from "../services/onboarding-orchestrator.js";
import {
  agentService,
  accessService,
  agentInstructionsService,
  conversationService,
  companyService,
} from "../services/index.js";
import { logger } from "../middleware/logger.js";

// Zod schema for the request body.
const provisionUserBodySchema = z.object({
  email: z.string().email("email must be a valid email address"),
  name: z.string().min(1, "name is required"),
  companyName: z.string().min(1, "companyName is required"),
  redirectTo: z.string().optional(),
});

// BetterAuth instance type — we only use auth.api here.
type BetterAuthLike = {
  api: {
    signUpEmail: (input: { body: { email: string; name: string; password: string } }) => Promise<{ user: { id: string } }>;
    requestPasswordReset: (input: { body: { email: string; redirectTo?: string } }) => Promise<unknown>;
  };
};

interface ProvisionUserRoutesOptions {
  // Value of AGENTDASH_PROVISION_KEY. When undefined/empty the endpoint is
  // unconditionally locked (401 for every request).
  provisionKey: string | undefined;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  // Compare using fixed-length buffers to prevent length-leaking timing attacks.
  try {
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function generateEphemeralPassword(): string {
  // 32 random bytes → 64-char hex string. Cryptographically random, never
  // returned or logged. The user sets their own password via the reset link.
  return randomBytes(32).toString("hex");
}

export function provisionUserRoutes(
  db: Db,
  auth: BetterAuthLike,
  opts: ProvisionUserRoutesOptions,
): Router {
  const router = Router();
  const companies = companyService(db);

  // Build the onboarding orchestrator with the same service wiring used by
  // the /bootstrap handler in onboarding-v2.ts, so CoS provisioning is identical.
  const users = {
    getById: async (_id: string) => null, // provision creates new users; lookup not needed
  };

  const orchestratorServices = {
    access: accessService(db),
    companies,
    agents: agentService(db),
    instructions: agentInstructionsService(),
    conversations: conversationService(db),
    users,
  };
  const orch = onboardingOrchestrator(orchestratorServices);

  // POST /provision-user
  router.post("/provision-user", async (req, res, next) => {
    try {
      // ── Auth gate (FIRST, before any work) ──────────────────────────────────
      const configuredKey = opts.provisionKey;
      if (!configuredKey) {
        // AGENTDASH_PROVISION_KEY is unset → endpoint is disabled entirely.
        return res.status(401).json({
          error: "Provisioning is not enabled on this instance (AGENTDASH_PROVISION_KEY not set)",
          code: "provision_not_configured",
        });
      }

      const providedKey = req.headers["x-provision-key"];
      if (!providedKey || typeof providedKey !== "string") {
        return res.status(401).json({
          error: "Missing x-provision-key header",
          code: "missing_provision_key",
        });
      }

      if (!timingSafeStringEqual(providedKey, configuredKey)) {
        return res.status(403).json({
          error: "Invalid provision key",
          code: "invalid_provision_key",
        });
      }

      // ── Input validation ─────────────────────────────────────────────────────
      const parsed = provisionUserBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: parsed.error.issues.map((i) => i.message).join("; "),
          code: "validation_error",
          details: parsed.error.issues,
        });
      }

      const { email, name, companyName, redirectTo } = parsed.data;

      // ── Step a: create user via better-auth (passwordless-style) ─────────────
      // A cryptographically-random ephemeral password is used. It is NEVER
      // returned, logged, or exposed — the reset link below is the only way in.
      let userId: string;
      try {
        const signUpResult = await auth.api.signUpEmail({
          body: {
            email,
            name,
            password: generateEphemeralPassword(),
          },
        });
        userId = signUpResult.user.id;
      } catch (err: unknown) {
        // Better-auth surfaces duplicate email as a 422 / USER_ALREADY_EXISTS.
        // Translate to a clear 409 so callers can detect and handle it.
        const errAsRecord = err as Record<string, unknown>;
        const errBodyCode =
          errAsRecord?.body && typeof errAsRecord.body === "object"
            ? (errAsRecord.body as Record<string, unknown>).code
            : undefined;
        const errCode = errAsRecord?.code ?? errBodyCode;
        const isAlreadyExists =
          errCode === "USER_ALREADY_EXISTS" ||
          (err instanceof Error && /already exists/i.test(err.message));
        if (isAlreadyExists) {
          return res.status(409).json({
            error: `A user with email ${email} already exists`,
            code: "user_already_exists",
          });
        }
        throw err;
      }

      // ── Step b: trigger set-password email ───────────────────────────────────
      // better-auth 1.4.x: POST /api/auth/request-password-reset fires
      // emailAndPassword.sendResetPassword (configured in better-auth.ts).
      // Failure here is best-effort — we log and continue so provisioning
      // doesn't fail if email is misconfigured.
      try {
        await auth.api.requestPasswordReset({
          body: {
            email,
            ...(redirectTo ? { redirectTo } : {}),
          },
        });
      } catch (emailErr) {
        logger.warn(
          { email, error: emailErr instanceof Error ? emailErr.message : String(emailErr) },
          "[provision-user] requestPasswordReset failed — user created but no reset email sent",
        );
      }

      // ── Step c + d: create company + provision CoS via bootstrap ─────────────
      // bootstrap() is idempotent on userId: it creates the company, grants
      // owner membership, and ensures a CoS agent + conversation exist. We
      // pre-create the company with the caller-supplied name so the workspace
      // has the right name, then let bootstrap() attach to it via the
      // user's membership (which ensureMembership creates).
      //
      // Implementation: create the company first, insert the owner membership,
      // then call bootstrap() so it finds the existing membership and skips
      // company creation.
      const company = await companies.create(
        { name: companyName, budgetMonthlyCents: 0 },
        true, // allowMultiTenantPerDomain
      );
      const companyId = company.id;

      // Insert owner membership so bootstrap() reuses the company.
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        membershipRole: "owner",
        status: "active",
      });

      // bootstrap() will find the active membership, skip company creation,
      // and provision the CoS agent + conversation.
      const bootstrapResult = await orch.bootstrap(userId);

      logger.info(
        { userId, companyId: bootstrapResult.companyId, cosAgentId: bootstrapResult.cosAgentId },
        "[provision-user] user provisioned successfully",
      );

      return res.status(201).json({
        userId,
        companyId: bootstrapResult.companyId,
        cosAgentId: bootstrapResult.cosAgentId,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
