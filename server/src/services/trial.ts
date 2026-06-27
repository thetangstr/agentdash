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
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { trialSessions, trialArtifacts, companies, companyMemberships } from "@paperclipai/db";
import { HttpError, badRequest } from "../errors.js";
import { companyService } from "./companies.js";
import { agentService } from "./agents.js";
import { dispatchLLM, type DispatchMeter, type DispatchOptions } from "./dispatch-llm.js";
import { getHeroTask, TRIAL_DEFAULT_HERO_TASK } from "./trial-hero-tasks.js";
import {
  buildCompanyDesignPrompt,
  parseCompanyDesign,
  buildAgentTaskPrompt,
  parseAgentArtifact,
  type CompanyIntake,
  type DesignedAgent,
} from "./trial-company-designer.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** All trial runs are pinned to MiniMax (cheap, already wired) per the spec. */
const TRIAL_ADAPTER = "minimax";
/**
 * Default starting trial credit (cents) when env is unset. The autonomous-
 * company flow makes ~5-6 MiniMax calls (1 design + 3-4 first-task runs), so the
 * default is sized to fit a full company + first deliverables comfortably.
 */
const DEFAULT_TRIAL_CREDIT_CENTS = 150;
/** Use-case id for per-agent deliverables produced by the multi-agent flow. */
const AGENT_DELIVERABLE_USE_CASE = "agent_deliverable";
/** Default credit bump (cents) granted when a trial is claimed on signup. */
const DEFAULT_TRIAL_SIGNUP_CREDIT_CENTS = 500;
/** Anonymous trial session lifetime. */
const TRIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function trialCreditCents(): number {
  const raw = process.env.AGENTDASH_TRIAL_CREDIT_CENTS;
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TRIAL_CREDIT_CENTS;
}

function trialSignupCreditCents(): number {
  const raw = process.env.AGENTDASH_TRIAL_SIGNUP_CREDIT_CENTS;
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_TRIAL_SIGNUP_CREDIT_CENTS;
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

export class TrialAlreadyClaimedError extends HttpError {
  constructor() {
    super(
      409,
      "This trial has already been claimed by another account.",
      { code: "trial_already_claimed" },
      "trial_already_claimed",
    );
  }
}

export class TrialAgentNotFoundError extends HttpError {
  constructor() {
    super(
      404,
      "Agent not found in this trial",
      { code: "trial_agent_not_found" },
      "trial_agent_not_found",
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
// Autonomous-company plan storage (persisted on trial_sessions.company_plan)
// ---------------------------------------------------------------------------

/** A designed agent after it has been provisioned in the DB (has an id). */
export interface ProvisionedAgent extends DesignedAgent {
  id: string;
}

/** The plan persisted on the session: company identity + the provisioned roster. */
export interface StoredCompanyPlan {
  company: { name: string; mission: string };
  agents: ProvisionedAgent[];
}

/** Read + lightly validate the stored company plan, or null if absent/malformed. */
function readPlan(row: Pick<TrialSessionRow, "companyPlan">): StoredCompanyPlan | null {
  const raw = row.companyPlan;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const company = obj.company as { name?: unknown; mission?: unknown } | undefined;
  const agents = Array.isArray(obj.agents) ? (obj.agents as ProvisionedAgent[]) : [];
  if (!company || typeof company.name !== "string" || agents.length === 0) return null;
  return {
    company: {
      name: company.name,
      mission: typeof company.mission === "string" ? company.mission : "",
    },
    agents,
  };
}

/** Validate + normalize the design intake; throws a 400 on bad input. */
function validateIntake(raw: unknown): CompanyIntake {
  if (!raw || typeof raw !== "object") {
    throw badRequest("intake is required", { code: "invalid_intake" });
  }
  const obj = raw as Record<string, unknown>;
  const whatYouDo = typeof obj.whatYouDo === "string" ? obj.whatYouDo.trim() : "";
  const goal = typeof obj.goal === "string" ? obj.goal.trim() : "";
  if (!whatYouDo) throw badRequest("intake.whatYouDo is required", { code: "missing_what_you_do" });
  if (!goal) throw badRequest("intake.goal is required", { code: "missing_goal" });
  const blockerRaw = typeof obj.blocker === "string" ? obj.blocker.trim() : "";
  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
  const intake: CompanyIntake = { whatYouDo: cap(whatYouDo, 1000), goal: cap(goal, 1000) };
  if (blockerRaw) intake.blocker = cap(blockerRaw, 1000);
  return intake;
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

    // -----------------------------------------------------------------------
    // Autonomous company — multi-agent flow
    // -----------------------------------------------------------------------

    /**
     * DESIGN a tailored autonomous company from a 2-3 field intake. A "Chief of
     * Staff" LLM call (forced MiniMax) designs a team of 3-4 agents; each is
     * provisioned in the DB under the trial company (idle, MiniMax, with the
     * category/charter/first-task carried in runtimeConfig). The full plan
     * (company name/mission + provisioned agent roster) is persisted on the
     * session's company_plan column. A small design cost is deducted.
     *
     * Throws (typed): TrialNotFound (404), TrialExpired (410),
     * TrialCreditExhausted (402), badRequest (400) on invalid intake.
     */
    designCompany: async (token: string, intakeRaw: unknown) => {
      const row = await findByToken(token);
      if (!row) throw new TrialNotFoundError();
      if (isExpired(row)) throw new TrialExpiredError();
      if (row.creditCents - row.spentCents <= 0) throw new TrialCreditExhaustedError();

      const intake = validateIntake(intakeRaw);

      const prompt = buildCompanyDesignPrompt(intake);
      const meter: DispatchMeter = { db, companyId: row.companyId, agentId: row.agentId };
      const raw = await dispatch(prompt, meter, { adapter: TRIAL_ADAPTER });
      const design = parseCompanyDesign(raw, intake);

      // Rename the ephemeral company to the designed name (best-effort).
      await db
        .update(companies)
        .set({ name: design.companyName, updatedAt: new Date() })
        .where(eq(companies.id, row.companyId));

      // Provision each designed agent under the trial company.
      const provisioned: ProvisionedAgent[] = [];
      for (const agent of design.agents) {
        const created = await agents_.create(row.companyId, {
          name: agent.name,
          role: agent.role,
          status: "idle",
          adapterType: TRIAL_ADAPTER,
          runtimeConfig: {
            trial: true,
            category: agent.category,
            charter: agent.charter,
            ref: agent.ref,
            firstTaskTitle: agent.firstTaskTitle,
            firstTaskBrief: agent.firstTaskBrief,
          },
        });
        provisioned.push({
          id: created.id,
          ref: agent.ref,
          name: created.name,
          role: agent.role,
          category: agent.category,
          charter: agent.charter,
          firstTaskTitle: agent.firstTaskTitle,
          firstTaskBrief: agent.firstTaskBrief,
        });
      }

      const plan: StoredCompanyPlan = {
        company: { name: design.companyName, mission: design.mission },
        agents: provisioned,
      };

      // Deduct a small design cost + persist the plan.
      const estCents = estimateRunCostCents(raw);
      const nextSpent = row.spentCents + estCents;
      await db
        .update(trialSessions)
        .set({
          companyPlan: plan as unknown as Record<string, unknown>,
          spentCents: nextSpent,
          updatedAt: new Date(),
        })
        .where(eq(trialSessions.id, row.id));
      await db
        .update(companies)
        .set({ spentMonthlyCents: nextSpent, updatedAt: new Date() })
        .where(eq(companies.id, row.companyId));

      return {
        company: { name: design.companyName, mission: design.mission },
        agents: provisioned.map((a) => ({ ...a, status: "idle" as const })),
        creditRemainingCents: Math.max(0, row.creditCents - nextSpent),
        spentCents: nextSpent,
        creditCents: row.creditCents,
      };
    },

    /**
     * RUN one designed agent's first task draft-only on MiniMax, persist the
     * deliverable as a trial_artifact (agentId set, useCase "agent_deliverable"),
     * and deduct credit.
     *
     * Throws (typed): TrialNotFound (404), TrialExpired (410),
     * TrialCreditExhausted (402), TrialAgentNotFound (404) when the agent does
     * not belong to this trial's designed company.
     */
    runAgentFirstTask: async (token: string, agentId: string) => {
      const row = await findByToken(token);
      if (!row) throw new TrialNotFoundError();
      if (isExpired(row)) throw new TrialExpiredError();
      if (row.creditCents - row.spentCents <= 0) throw new TrialCreditExhaustedError();

      const plan = readPlan(row);
      const planned = plan?.agents.find((a) => a.id === agentId) ?? null;
      // Confirm the agent really belongs to this trial's company.
      const agentRow = await agents_.getById(agentId);
      if (!planned || !agentRow || agentRow.companyId !== row.companyId) {
        throw new TrialAgentNotFoundError();
      }

      const prompt = buildAgentTaskPrompt(plan!.company, planned);
      const meter: DispatchMeter = { db, companyId: row.companyId, agentId };
      const raw = await dispatch(prompt, meter, { adapter: TRIAL_ADAPTER });
      const { title, content } = parseAgentArtifact(raw, planned);

      const artifact = await db
        .insert(trialArtifacts)
        .values({
          trialSessionId: row.id,
          companyId: row.companyId,
          agentId,
          useCase: AGENT_DELIVERABLE_USE_CASE,
          title,
          content: content as unknown as Record<string, unknown>,
          inputSummary: planned.firstTaskTitle,
        })
        .returning()
        .then((rows) => rows[0]);

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

      return {
        artifact: { title: artifact.title, content: artifact.content, id: artifact.id },
        creditRemainingCents: Math.max(0, row.creditCents - nextSpent),
        spentCents: nextSpent,
        creditCents: row.creditCents,
      };
    },

    /**
     * Fleet view: the designed company + its agents (with live status + whether
     * each has produced a deliverable yet) + all artifacts. Returns null when the
     * token is unknown or the session has expired; returns a company of null when
     * no company has been designed yet.
     */
    getCompany: async (token: string) => {
      const row = await findByToken(token);
      if (!row) return null;
      if (isExpired(row)) return null;

      const plan = readPlan(row);
      const artifacts = await listArtifacts(row.id);

      if (!plan) {
        return {
          company: null,
          agents: [],
          artifacts,
          session: publicSession(row),
        };
      }

      // Live agent statuses keyed by id.
      const liveAgents = await agents_.list(row.companyId, { includeTerminated: true });
      const statusById = new Map(liveAgents.map((a) => [a.id, a.status]));
      // Latest deliverable per agent.
      const artifactByAgent = new Map<string, (typeof artifacts)[number]>();
      for (const art of artifacts) {
        if (art.agentId && !artifactByAgent.has(art.agentId)) {
          artifactByAgent.set(art.agentId, art);
        }
      }

      const agentsView = plan.agents.map((a) => {
        const art = artifactByAgent.get(a.id);
        return {
          id: a.id,
          ref: a.ref,
          name: a.name,
          role: a.role,
          category: a.category,
          charter: a.charter,
          firstTaskTitle: a.firstTaskTitle,
          firstTaskBrief: a.firstTaskBrief,
          status: statusById.get(a.id) ?? "idle",
          hasArtifact: Boolean(art),
          artifactId: art?.id,
        };
      });

      return {
        company: plan.company,
        agents: agentsView,
        artifacts,
        session: publicSession(row),
      };
    },

    // -----------------------------------------------------------------------
    // Slice 3 — Share loop
    // -----------------------------------------------------------------------

    /**
     * Mint (or return the existing) public share token for one of the trial's
     * artifacts. Idempotent: a second call returns the same token. Scoped to the
     * trial — the artifact must belong to the session behind `trialToken`.
     *
     * Throws TrialNotFoundError (404) for an unknown trial token, or when the
     * artifact is missing / not owned by this trial.
     */
    shareArtifact: async (trialToken: string, artifactId: string) => {
      const row = await findByToken(trialToken);
      if (!row) throw new TrialNotFoundError();

      const artifact = await db
        .select()
        .from(trialArtifacts)
        .where(
          and(eq(trialArtifacts.id, artifactId), eq(trialArtifacts.trialSessionId, row.id)),
        )
        .then((rows) => rows[0] ?? null);
      if (!artifact) throw new TrialNotFoundError();

      let shareToken = artifact.shareToken;
      if (!shareToken) {
        shareToken = generateToken();
        await db
          .update(trialArtifacts)
          .set({ shareToken })
          .where(eq(trialArtifacts.id, artifact.id));
      }

      return { shareToken, shareUrl: `/share/${shareToken}` };
    },

    /**
     * PUBLIC, read-only resolve of a shared artifact by its share token. No
     * trial token required. Returns null when the token is unknown.
     */
    getSharedArtifact: async (shareToken: string) => {
      const t = shareToken?.trim();
      if (!t) return null;
      const artifact = await db
        .select()
        .from(trialArtifacts)
        .where(eq(trialArtifacts.shareToken, t))
        .then((rows) => rows[0] ?? null);
      if (!artifact) return null;
      return {
        title: artifact.title,
        content: artifact.content,
        useCase: artifact.useCase,
        createdAt: artifact.createdAt,
        agentName: TRIAL_DEFAULT_HERO_TASK.agentName,
      };
    },

    // -----------------------------------------------------------------------
    // Slice 4 — Claim on signup
    // -----------------------------------------------------------------------

    /**
     * Bind an anonymous trial workspace to a freshly-signed-up user: create an
     * owner company_membership, flip the company from the `trial` tier to
     * `free`, stamp claimedByUserId, and grant a signup credit bump.
     *
     * Idempotent for the SAME user (re-binds nothing, no double credit). Throws
     * TrialAlreadyClaimedError (409) if a DIFFERENT user already claimed it, and
     * TrialNotFoundError (404) for an unknown token.
     */
    claimSession: async (trialToken: string, userId: string) => {
      const uid = userId?.trim();
      if (!uid) throw badRequest("userId is required", { code: "missing_user_id" });

      const row = await findByToken(trialToken);
      if (!row) throw new TrialNotFoundError();

      const company = await db
        .select({ id: companies.id, issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, row.companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw new TrialNotFoundError();

      // Already claimed?
      if (row.claimedByUserId) {
        if (row.claimedByUserId !== uid) throw new TrialAlreadyClaimedError();
        // Idempotent for the same user: ensure membership exists, no re-credit.
        await db
          .insert(companyMemberships)
          .values({
            companyId: company.id,
            principalType: "user",
            principalId: uid,
            status: "active",
            membershipRole: "owner",
          })
          .onConflictDoNothing({
            target: [
              companyMemberships.companyId,
              companyMemberships.principalType,
              companyMemberships.principalId,
            ],
          });
        return { companyId: company.id, companyPrefix: company.issuePrefix };
      }

      // First claim by this user: bind membership, flip tier, credit, stamp.
      await db
        .insert(companyMemberships)
        .values({
          companyId: company.id,
          principalType: "user",
          principalId: uid,
          status: "active",
          membershipRole: "owner",
        })
        .onConflictDoNothing({
          target: [
            companyMemberships.companyId,
            companyMemberships.principalType,
            companyMemberships.principalId,
          ],
        });

      await db
        .update(companies)
        .set({ planTier: "free", updatedAt: new Date() })
        .where(eq(companies.id, company.id));

      await db
        .update(trialSessions)
        .set({
          claimedByUserId: uid,
          creditCents: row.creditCents + trialSignupCreditCents(),
          updatedAt: new Date(),
        })
        .where(eq(trialSessions.id, row.id));

      return { companyId: company.id, companyPrefix: company.issuePrefix };
    },
  };
}

export type TrialService = ReturnType<typeof trialService>;
