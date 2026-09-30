import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createIssueTreeHoldSchema, previewIssueTreeControlSchema, releaseIssueTreeHoldSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { heartbeatService, issueService, issueTreeControlService } from "../services/index.js";
import { issueTreeCurrentAuthority } from "../services/issue-current-authority.js";
import type { TreeActionContext } from "../services/issue-tree-control.js";
import { notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function issueTreeControlRoutes(db: Db) {
  const router = Router(), issuesSvc = issueService(db), tree = issueTreeControlService(db), heartbeat = heartbeatService(db);
  async function context(req: Request): Promise<TreeActionContext> {
    assertBoard(req);
    const root = await issuesSvc.getById(req.params.id as string);
    if (!root) throw notFound("Root issue not found");
    assertCompanyAccess(req, root.companyId);
    const actor = getActorInfo(req);
    return { companyId: root.companyId, rootIssueId: root.id,
      actor: { ...actor, userId: actor.actorType === "user" ? actor.actorId : null },
      authority: issueTreeCurrentAuthority(req) };
  }
  router.post("/issues/:id/tree-control/preview", validate(previewIssueTreeControlSchema), async (req, res) => {
    const accepted = await tree.acceptAction(await context(req), { kind: "create", input: req.body }, { previewOnly: true });
    res.json("preview" in accepted.result ? accepted.result.preview : null);
  });
  router.post("/issues/:id/tree-holds", validate(createIssueTreeHoldSchema), async (req, res) => {
    const accepted = await tree.acceptAction(await context(req), { kind: "create", input: req.body });
    await tree.dispatchTreeEffects(accepted, heartbeat);
    const result = accepted.result;
    if (!("hold" in result)) throw new Error("Unexpected tree result");
    res.status(result.hold.mode === "restore" || result.hold.mode === "resume" ? 200 : 201).json(result);
  });
  router.get("/issues/:id/tree-control/state", async (req, res) => {
    const ctx = await context(req), activePauseHold = await tree.getActivePauseHoldGate(ctx.companyId, ctx.rootIssueId);
    await tree.authorizeRead(ctx, activePauseHold ? [activePauseHold.holdId] : []);
    res.json({ activePauseHold });
  });
  router.get("/issues/:id/tree-holds", async (req, res) => {
    const ctx = await context(req), status = req.query.status, mode = req.query.mode;
    const holds = await tree.listHolds(ctx.companyId, ctx.rootIssueId, {
      status: status === "active" || status === "released" ? status : undefined,
      mode: mode === "pause" || mode === "resume" || mode === "cancel" || mode === "restore" ? mode : undefined,
      includeMembers: req.query.includeMembers === "true",
    });
    await tree.authorizeRead(ctx, holds.map(hold => hold.id));
    res.json(holds);
  });
  router.get("/issues/:id/tree-holds/:holdId", async (req, res) => {
    const ctx = await context(req), hold = await tree.getHold(ctx.companyId, req.params.holdId as string);
    if (!hold || hold.rootIssueId !== ctx.rootIssueId) throw notFound("Issue tree hold not found");
    await tree.authorizeRead(ctx, [hold.id]);
    res.json(hold);
  });
  router.post("/issues/:id/tree-holds/:holdId/release", validate(releaseIssueTreeHoldSchema), async (req, res) => {
    const accepted = await tree.acceptAction(await context(req), { kind: "release", holdId: req.params.holdId as string, input: req.body });
    res.json(accepted.result);
  });
  return router;
}
