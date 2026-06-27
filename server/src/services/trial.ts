// AgentDash (Test Drive): the no-signup anonymous trial engine (Slice 1).
//
// Provisions an ephemeral, sandboxed trial workspace + one curated hero agent,
// runs ONE curated hero task (sales outreach) on the cheap MiniMax adapter,
// draft-only, persists the structured artifact, and enforces a credit guard.
//
// Fully anonymous: the only credential is an opaque url-safe token. No email,
// no user, no req.actor. Real-world actions are NEVER taken here.
//
// See docs/superpowers/specs/2026-06-27-test-drive-no-signup-trial.md (§4, §9, §11).

import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { trialSessions, trialArtifacts, companies } from "@paperclipai/db";
import { HttpError, badRequest } from "../errors.js";
import { companyService } from "./companies.js";
import { agentService } from "./agents.js";
import { dispatchLLM, type DispatchMeter, type DispatchOptions } from "./dispatch-llm.js";
import { getHeroTask, TRIAL_DEFAULT_HERO_TASK } from "./trial-hero-tasks.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** All trial runs are pinned to MiniMax (cheap, already wired) per the spec. */
const TRIAL_ADAPTER = "minimax";
/** Default starting trial credit (cents) when env is unset. */
const DEFAULT_TRIAL_CREDIT_CENTS = 50;
/** Anonymous trial session lifetime. */
const TRIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function trialCreditCents(): number {
  const raw = process.env.AGENTDASH_TRIAL_CREDIT_CENTS;
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TRIAL_CREDIT_CENTS;
}

/**
 * Best-effort run-cost estimate (cents). MiniMax is cheap; we deduct a small,
 * deterministic amount per run scaled by output size so the credit meter moves
 * realistically without per-token accounting. Always >= 1 so credit drains.
 */
export function estimateRunCostCents(rawOutput: string): number {
  const len = (rawOutput ?? "").length;
  return Math.max(1, Math.ceil(len / 2000));
}

// ---------------------------------------------------------------------------
// Typed errors (extend HttpError so the route maps status automatically)
// ---------------------------------------------------------------------------

export class TrialNotFoundError extends HttpError {
  constructor() {
    super(404, "Trial session not found", { code: "trial_not_found" }, "trial_not_found");
  }
}

export class TrialExpiredError extends HttpError {
  constructor() {
    super(410, "Trial session has expired", { code: "trial_expired" }, "trial_expired");
  }
}

export class TrialCreditExhaustedError extends HttpError {
  constructor() {
    super(
      402,
      "Trial credit exhausted. Sign up to keep going.",
      { code: "trial_credit_exhausted" },
      "trial_credit_exhausted",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** url-safe (base64url) token; ~43 chars of entropy. */
function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function shortSuffix(): string {
  return randomBytes(3).toString("hex");
}

type TrialSessionRow = typeof trialSessions.$inferSelect;

function isExpired(row: Pick<TrialSessionRow, "expiresAt">, now = new Date()): boolean {
  return row.expiresAt.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Dependency seam — injectable dispatch so tests never hit the network.
// ---------------------------------------------------------------------------

export type DispatchFn = (
  input: { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> },
  meter?: DispatchMeter,
  options?: DispatchOptions,
) => Promise<string>;

export interface TrialServiceDeps {
  dispatch?: DispatchFn;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function trialService(db: Db, deps: TrialServiceDeps = {}) {
  const companies_ = companyService(db);
  const agents_ = agentService(db);
  const dispatch: DispatchFn = deps.dispatch ?? dispatchLLM;

  async function findByToken(token: string): Promise<TrialSessionRow | null> {
    const t = token?.trim();
    if (!t) return null;
    return db
      .select()
      .from(trialSessions)
      .where(eq(trialSessions.token, t))
      .then((rows) => rows[0] ?? null);
  }

  async function listArtifacts(trialSessionId: string) {
    return db
      .select()
      .from(trialArtifacts)
      .where(eq(trialArtifacts.trialSessionId, trialSessionId))
      .orderBy(desc(trialArtifacts.createdAt));
  }

  function publicSession(row: TrialSessionRow) {
    const creditRemainingCents = Math.max(0, row.creditCents - row.spentCents);
    return {
      token: row.token,
      companyId: row.companyId,
      agentId: row.agentId,
      creditCents: row.creditCents,
      spentCents: row.spentCents,
      creditRemainingCents,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }

  return {
    estimateRunCostCents,

    /**
     * Provision a fresh anonymous trial: ephemeral company + one hero agent +
     * the trial_sessions row. Returns the public session view (incl. token).
     */
    createSession: async (opts: { ipHash?: string } = {}) => {
      const hero = TRIAL_DEFAULT_HERO_TASK;
      const company = await companies_.create({
        name: `Test Drive ${shortSuffix()}`,
        // Anonymous trial: no domain claim, trial tier.
        emailDomain: null,
        planTier: "trial",
      });

      const agent = await agents_.create(company.id, {
        name: hero.agentName,
        role: hero.agentRole,
        status: "idle",
        adapterType: TRIAL_ADAPTER,
      });

      const token = generateToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + TRIAL_TTL_MS);
      const inserted = await db
        .insert(trialSessions)
        .values({
          token,
          companyId: company.id,
          agentId: agent.id,
          creditCents: trialCreditCents(),
          spentCents: 0,
          ipHash: opts.ipHash ?? null,
          expiresAt,
        })
        .returning()
        .then((rows) => rows[0]);

      return publicSession(inserted);
    },

    /**
     * Fetch a session + its artifacts + derived credit. Returns null when the
     * token is unknown OR the session has expired.
     */
    getSession: async (token: string) => {
      const row = await findByToken(token);
      if (!row) return null;
      if (isExpired(row)) return null;
      const artifacts = await listArtifacts(row.id);
      return { session: publicSession(row), artifacts };
    },

    /**
     * Run a curated hero task draft-only on MiniMax, persist the artifact, and
     * deduct an estimated cost from the trial credit.
     *
     * Throws (typed):
     *  - TrialNotFoundError (404) — unknown token
     *  - TrialExpiredError (410) — past expiry
     *  - TrialCreditExhaustedError (402) — no credit remaining
     *  - badRequest (400) — unknown useCase / invalid input
     */
    runTask: async (
      token: string,
      args: { useCase: string; input: unknown },
    ) => {
      const row = await findByToken(token);
      if (!row) throw new TrialNotFoundError();
      if (isExpired(row)) throw new TrialExpiredError();
      if (row.creditCents - row.spentCents <= 0) throw new TrialCreditExhaustedError();

      const useCase = typeof args.useCase === "string" ? args.useCase.trim() : "";
      if (!useCase) throw badRequest("useCase is required", { code: "missing_use_case" });
      const hero = getHeroTask(useCase);
      if (!hero) {
        throw badRequest(`Unknown useCase "${useCase}"`, { code: "unknown_use_case" });
      }

      // Validate + normalize input (throws 400 on bad input, e.g. missing icp).
      const heroInput = hero.validateInput(args.input);
      const prompt = hero.buildPrompt(heroInput);

      // Force MiniMax for the trial regardless of env; meter against the trial
      // workspace so any usage-recording adapter still attributes spend.
      const meter: DispatchMeter = { db, companyId: row.companyId, agentId: row.agentId };
      const raw = await dispatch(prompt, meter, { adapter: TRIAL_ADAPTER });

      const { title, content } = hero.parseArtifact(raw, heroInput);
      const inputSummary = hero.summarizeInput(heroInput);

      const artifact = await db
        .insert(trialArtifacts)
        .values({
          trialSessionId: row.id,
          companyId: row.companyId,
          agentId: row.agentId,
          useCase: hero.useCase,
          title,
          content,
          inputSummary,
        })
        .returning()
        .then((rows) => rows[0]);

      // Deduct estimated cost from the credit guard (authoritative for the trial)
      // and bump the company's monthly-spend column for visibility.
      const estCents = estimateRunCostCents(raw);
      const nextSpent = row.spentCents + estCents;
      await db
        .update(trialSessions)
        .set({ spentCents: nextSpent, updatedAt: new Date() })
        .where(eq(trialSessions.id, row.id));
      await db
        .update(companies)
        .set({ spentMonthlyCents: nextSpent, updatedAt: new Date() })
        .where(eq(companies.id, row.companyId));

      const creditRemainingCents = Math.max(0, row.creditCents - nextSpent);
      return {
        artifact,
        creditRemainingCents,
        spentCents: nextSpent,
        creditCents: row.creditCents,
      };
    },
  };
}

export type TrialService = ReturnType<typeof trialService>;
