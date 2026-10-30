import { Router } from "express";
import type { Request, Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  createAgentProfileDraftSchema,
  createUnboundAgentProfileSchema,
  proposeAgentProfileRevisionSchema,
  updateAgentProfileDraftSchema,
  withdrawAgentProfileRevisionSchema,
} from "@paperclipai/shared";
import { HttpError, badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { isEvaluatorPrincipal, viewerProjectScope } from "../services/agent-performance-authz.js";
import { listProfileApplications, resumeProfileApplication } from "../services/agent-profile-application.js";
import {
  AgentProfileDraftConflictError,
  assertCanReadUnboundProfiles,
  createProfileDraft,
  createUnboundProfile,
  createUnboundProfileDraft,
  diffProfileRevision,
  diffUnboundProfileRevision,
  exportProfileMarkdown,
  findCompanyProfile,
  getAgentProfileView,
  getProfileRevision,
  getUnboundProfileRevision,
  getUnboundProfileView,
  listProfileRevisions,
  listUnboundProfiles,
  proposeProfileRevision,
  saveProfileDraft,
  saveUnboundProfileDraft,
  withdrawProfileRevision,
  withdrawUnboundProfileRevision,
  type AgentProfileActor,
  type AgentProfileViewerContext,
} from "../services/agent-profiles.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess, assistantGrantAttribution } from "./authz.js";
import { agentVisibilityParam, assertAgentIdVisible, assertApprovalProjectVisible } from "./visibility.js";

/**
 * AgentDash: Agent Performance Management gate 2 — operating-profile routes
 * (overview LLD §5). All company-scoped; every mutation writes an activity
 * entry inside its service transaction.
 *
 *   GET   /companies/:companyId/agents/:agentId/profile                               AgentProfileView (board with agent visibility)
 *   GET   /agents/me/profile                                                          AgentProfileView (the calling agent)
 *   GET   /companies/:companyId/agents/:agentId/profile/revisions[/:revisionId]       history · one revision
 *   GET   .../profile/revisions/:revisionId/diff?against=active|<revisionId>          per-field diff
 *   GET   .../profile/revisions/:revisionId/export.md                                 Markdown export
 *   POST  .../profile/revisions                                                       create a draft
 *   PATCH .../profile/revisions/:revisionId           (If-Match: <bodyHash>)          save a draft
 *   POST  .../profile/revisions/:revisionId/propose                                   freeze + file agent_profile_change
 *   POST  .../profile/revisions/:revisionId/withdraw                                  withdraw while pending
 *   GET   .../profile/applications                                                    application receipts
 *   POST  .../profile/applications/:applicationId/resume                              resume (admin or approver)
 *
 * Unbound drafts (APM gate 5, P5.1) — a profile for a role not hired yet:
 *
 *   POST  /companies/:companyId/agent-profiles                                        new unbound profile + draft (admin with agents:create, or the performance manager)
 *   GET   /companies/:companyId/agent-profiles                                        unbound profiles (board; the performance manager)
 *   GET   /companies/:companyId/agent-profiles/:profileId                             UnboundAgentProfileView
 *   GET   .../agent-profiles/:profileId/revisions[/:revisionId]                       history · one revision
 *   GET   .../agent-profiles/:profileId/revisions/:revisionId/diff?against=none|<id>  per-field diff
 *   GET   .../agent-profiles/:profileId/revisions/:revisionId/export.md               Markdown export
 *   POST  .../agent-profiles/:profileId/revisions                                     new draft (after a rejection or withdrawal)
 *   PATCH .../agent-profiles/:profileId/revisions/:revisionId   (If-Match)            save a draft
 *   POST  .../agent-profiles/:profileId/revisions/:revisionId/propose                 file hire_agent (routes/agents.ts)
 *   POST  .../agent-profiles/:profileId/revisions/:revisionId/withdraw                withdraw the hire (proposer or admin)
 *
 * None of these hires an agent or wakes one; only a person approving the hire does.
 *
 * The two profile reads keep gate 1's authorization: a board member who can
 * see the agent reads it on the company route; an agent reads only its own,
 * at /agents/me/profile; the evaluator principal reads neither. Both carry
 * `viewer`: what the caller may do, from the mutation routes' own guards.
 */
/**
 * The actor a profile mutation runs as: the calling agent (never the
 * evaluator principal), or a board user with how they authenticated (for the
 * authority checks) and any assistant-grant attribution.
 */
export function profileActorFromRequest(req: Request): AgentProfileActor {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    if (isEvaluatorPrincipal(req)) throw forbidden("The evaluator principal cannot write operating profiles");
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    return { type: "agent", agentId: req.actor.agentId, runId: req.actor.runId ?? null };
  }
  assertBoard(req);
  const { via } = assistantGrantAttribution(req);
  return {
    type: "user",
    userId: req.actor.userId ?? "board",
    source: req.actor.source ?? null,
    isInstanceAdmin: req.actor.isInstanceAdmin ?? false,
    ...(via ? { via } : {}),
  };
}

export function agentProfileRoutes(db: Db) {
  const router = Router();
  // Agent visibility (2026-09-30): an agent the actor cannot see is 404 here too.
  router.param("agentId", agentVisibilityParam(db));

  function params(req: Request) {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    return { companyId, agentId };
  }

  /** Board readers, and the agent itself; never the evaluator principal. */
  function assertProfileReader(req: Request, agentId: string) {
    if (req.actor.type === "board") return;
    if (isEvaluatorPrincipal(req)) throw forbidden("The evaluator principal has no operating profile");
    if (req.actor.type === "agent" && req.actor.agentId === agentId) return;
    throw forbidden("Agents read only their own operating profile");
  }

  const profileActor = profileActorFromRequest;

  /**
   * Who is reading, as each mutation's route sees them, so the view's
   * `viewer` flags run those routes' guards: `profileActor` for the draft
   * routes (and, for a person, the resume route), `req.actor` for the
   * approve/reject decider rule (board only, as `assertBoard` there), and the
   * approval routes' read check on the requesting agent's visibility.
   */
  function viewerContext(req: Request): AgentProfileViewerContext {
    return {
      actor: profileActor(req),
      decisionActor: req.actor.type === "board" ? req.actor : null,
      canOpenApproval: async (approval) => {
        try {
          if (approval.requestedByAgentId) await assertAgentIdVisible(db, req, approval.requestedByAgentId, "Approval");
          await assertApprovalProjectVisible(db, req, approval);
          return true;
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) return false;
          throw error;
        }
      },
    };
  }

  async function view(req: Request, companyId: string, agentId: string) {
    const result = await getAgentProfileView(db, {
      companyId,
      agentId,
      viewer: viewerProjectScope(req, companyId),
      viewerContext: viewerContext(req),
    });
    if (!result) throw notFound("Agent not found");
    return result;
  }

  router.get("/companies/:companyId/agents/:agentId/profile", async (req, res) => {
    const { companyId, agentId } = params(req);
    if (req.actor.type !== "board") {
      throw forbidden("Agents read their own operating profile at GET /api/agents/me/profile");
    }
    res.json(await view(req, companyId, agentId));
  });

  router.get("/agents/me/profile", async (req, res) => {
    assertAuthenticated(req);
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      throw forbidden("Agent authentication required");
    }
    if (isEvaluatorPrincipal(req)) throw forbidden("The evaluator principal has no operating profile");
    res.json(await view(req, req.actor.companyId, req.actor.agentId));
  });

  router.get("/companies/:companyId/agents/:agentId/profile/revisions", async (req, res) => {
    const { companyId, agentId } = params(req);
    assertProfileReader(req, agentId);
    res.json(await listProfileRevisions(db, { companyId, agentId }));
  });

  router.get("/companies/:companyId/agents/:agentId/profile/revisions/:revisionId", async (req, res) => {
    const { companyId, agentId } = params(req);
    assertProfileReader(req, agentId);
    const revision = await getProfileRevision(db, { companyId, agentId, revisionId: req.params.revisionId as string });
    if (!revision) throw notFound("Profile revision not found");
    res.json(revision);
  });

  router.get("/companies/:companyId/agents/:agentId/profile/revisions/:revisionId/diff", async (req, res) => {
    const { companyId, agentId } = params(req);
    assertProfileReader(req, agentId);
    const raw = req.query.against;
    const against = raw === undefined ? "active" : typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
    if (!against) throw badRequest('against must be "active" or a revision id');
    res.json({ against, diff: await diffProfileRevision(db, { companyId, agentId, revisionId: req.params.revisionId as string, against }) });
  });

  router.get("/companies/:companyId/agents/:agentId/profile/revisions/:revisionId/export.md", async (req, res) => {
    const { companyId, agentId } = params(req);
    assertProfileReader(req, agentId);
    const revision = await getProfileRevision(db, { companyId, agentId, revisionId: req.params.revisionId as string });
    if (!revision) throw notFound("Profile revision not found");
    res.type("text/markdown; charset=utf-8").send(exportProfileMarkdown(revision));
  });

  router.post("/companies/:companyId/agents/:agentId/profile/revisions", validate(createAgentProfileDraftSchema), async (req, res) => {
    const { companyId, agentId } = params(req);
    const revision = await createProfileDraft(db, { companyId, agentId, input: req.body }, profileActor(req));
    res.status(201).json(revision);
  });

  router.patch(
    "/companies/:companyId/agents/:agentId/profile/revisions/:revisionId",
    validate(updateAgentProfileDraftSchema),
    async (req, res: Response) => {
      const { companyId, agentId } = params(req);
      const ifMatch = (req.header("if-match") ?? "").trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
      if (!ifMatch) throw badRequest("If-Match: <bodyHash> is required to save a draft");
      try {
        res.json(
          await saveProfileDraft(
            db,
            { companyId, agentId, revisionId: req.params.revisionId as string, ifMatch, input: req.body },
            profileActor(req),
          ),
        );
      } catch (error) {
        if (error instanceof AgentProfileDraftConflictError) {
          res.status(409).json({ error: error.message, code: error.code, current: error.current });
          return;
        }
        throw error;
      }
    },
  );

  router.post(
    "/companies/:companyId/agents/:agentId/profile/revisions/:revisionId/propose",
    validate(proposeAgentProfileRevisionSchema),
    async (req, res) => {
      const { companyId, agentId } = params(req);
      const result = await proposeProfileRevision(
        db,
        { companyId, agentId, revisionId: req.params.revisionId as string, input: req.body },
        profileActor(req),
      );
      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/agents/:agentId/profile/revisions/:revisionId/withdraw",
    validate(withdrawAgentProfileRevisionSchema),
    async (req, res) => {
      const { companyId, agentId } = params(req);
      res.json(
        await withdrawProfileRevision(
          db,
          { companyId, agentId, revisionId: req.params.revisionId as string, input: req.body },
          profileActor(req),
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Unbound drafts (APM gate 5)
  // -------------------------------------------------------------------------

  /** Company access, a reader (board or the performance manager), and — once bound — the hired agent's visibility. */
  async function readableProfile(req: Request) {
    const companyId = req.params.companyId as string;
    const profileId = req.params.profileId as string;
    assertCompanyAccess(req, companyId);
    await assertCanReadUnboundProfiles(db, companyId, profileActor(req));
    const profile = await findCompanyProfile(db, { companyId, profileId });
    if (!profile) throw notFound("Draft profile not found");
    if (profile.agentId) await assertAgentIdVisible(db, req, profile.agentId, "Draft profile");
    return { companyId, profileId, profile };
  }

  router.post("/companies/:companyId/agent-profiles", validate(createUnboundAgentProfileSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.status(201).json(await createUnboundProfile(db, { companyId, input: req.body }, profileActor(req)));
  });

  router.get("/companies/:companyId/agent-profiles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertCanReadUnboundProfiles(db, companyId, profileActor(req));
    res.json(await listUnboundProfiles(db, companyId));
  });

  router.get("/companies/:companyId/agent-profiles/:profileId", async (req, res) => {
    const { companyId, profileId } = await readableProfile(req);
    const view = await getUnboundProfileView(db, { companyId, profileId, actor: profileActor(req) });
    if (!view) throw notFound("Draft profile not found");
    res.json(view);
  });

  router.get("/companies/:companyId/agent-profiles/:profileId/revisions", async (req, res) => {
    const { companyId, profileId } = await readableProfile(req);
    const view = await getUnboundProfileView(db, { companyId, profileId, actor: null });
    if (!view) throw notFound("Draft profile not found");
    res.json(view.revisions);
  });

  router.get("/companies/:companyId/agent-profiles/:profileId/revisions/:revisionId", async (req, res) => {
    const { companyId, profileId } = await readableProfile(req);
    const revision = await getUnboundProfileRevision(db, { companyId, profileId, revisionId: req.params.revisionId as string });
    if (!revision) throw notFound("Profile revision not found");
    res.json(revision);
  });

  router.get("/companies/:companyId/agent-profiles/:profileId/revisions/:revisionId/diff", async (req, res) => {
    const { companyId, profileId } = await readableProfile(req);
    const raw = req.query.against;
    const against = raw === undefined ? "none" : typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
    if (!against) throw badRequest('against must be "none" or a revision id');
    res.json({ against, diff: await diffUnboundProfileRevision(db, { companyId, profileId, revisionId: req.params.revisionId as string, against }) });
  });

  router.get("/companies/:companyId/agent-profiles/:profileId/revisions/:revisionId/export.md", async (req, res) => {
    const { companyId, profileId } = await readableProfile(req);
    const revision = await getUnboundProfileRevision(db, { companyId, profileId, revisionId: req.params.revisionId as string });
    if (!revision) throw notFound("Profile revision not found");
    res.type("text/markdown; charset=utf-8").send(exportProfileMarkdown(revision));
  });

  router.post("/companies/:companyId/agent-profiles/:profileId/revisions", validate(createAgentProfileDraftSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res
      .status(201)
      .json(await createUnboundProfileDraft(db, { companyId, profileId: req.params.profileId as string, input: req.body }, profileActor(req)));
  });

  router.patch(
    "/companies/:companyId/agent-profiles/:profileId/revisions/:revisionId",
    validate(updateAgentProfileDraftSchema),
    async (req, res: Response) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const ifMatch = (req.header("if-match") ?? "").trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
      if (!ifMatch) throw badRequest("If-Match: <bodyHash> is required to save a draft");
      try {
        res.json(
          await saveUnboundProfileDraft(
            db,
            { companyId, profileId: req.params.profileId as string, revisionId: req.params.revisionId as string, ifMatch, input: req.body },
            profileActor(req),
          ),
        );
      } catch (error) {
        if (error instanceof AgentProfileDraftConflictError) {
          res.status(409).json({ error: error.message, code: error.code, current: error.current });
          return;
        }
        throw error;
      }
    },
  );

  router.post(
    "/companies/:companyId/agent-profiles/:profileId/revisions/:revisionId/withdraw",
    validate(withdrawAgentProfileRevisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(
        await withdrawUnboundProfileRevision(
          db,
          { companyId, profileId: req.params.profileId as string, revisionId: req.params.revisionId as string, input: req.body },
          profileActor(req),
        ),
      );
    },
  );

  router.get("/companies/:companyId/agents/:agentId/profile/applications", async (req, res) => {
    const { companyId, agentId } = params(req);
    assertProfileReader(req, agentId);
    res.json(await listProfileApplications(db, { companyId, agentId }));
  });

  router.post("/companies/:companyId/agents/:agentId/profile/applications/:applicationId/resume", async (req, res) => {
    const { companyId, agentId } = params(req);
    assertBoard(req);
    const { via } = assistantGrantAttribution(req);
    const result = await resumeProfileApplication(
      db,
      req.params.applicationId as string,
      {
        userId: req.actor.userId ?? "board",
        path: "resume",
        source: req.actor.source ?? null,
        isInstanceAdmin: req.actor.isInstanceAdmin ?? false,
        ...(via ? { via } : {}),
      },
      { companyId, agentId },
    );
    res.json(result);
  });

  return router;
}
