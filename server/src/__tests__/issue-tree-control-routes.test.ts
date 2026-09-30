import { conflict } from "../errors.js";
import { type Db, instanceUserRoles } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({ acceptAction: vi.fn(), readAction: vi.fn(), dispatchTreeEffects: vi.fn(), authorizeRead: vi.fn(), getHold: vi.fn(), listHolds: vi.fn(), getActivePauseHoldGate: vi.fn() }));
const getById = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({ cancelRun: vi.fn(), wakeup: vi.fn() }));
vi.mock("../services/index.js", () => ({ heartbeatService: () => runtime, issueService: () => ({ getById }), issueTreeControlService: () => service }));
async function app(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueTreeControlRoutes }] = await Promise.all([import("../middleware/error-handler.js"), import("../routes/issue-tree-control.js")]);
  const result = express(); result.use(express.json());
  if (actor.type === "board") {
    // This suite mocks route composition, not authority. Let real middleware
    // capture its session primitives from the fixture's native auth dependencies.
    const userId = String(actor.userId);
    const memberships = (actor.companyIds as string[]).map(companyId => ({ companyId, membershipRole: "member", status: "active" }));
    const authDb = { select: () => ({ from: (table: unknown) => ({ where: async () => table === instanceUserRoles
      ? (actor.isInstanceAdmin ? [{ id: "fixture-admin" }] : []) : memberships }) }) } as unknown as Db;
    result.use(actorMiddleware(authDb, { deploymentMode: "authenticated", resolveSession: async () => ({
      session: { id: "fixture-session", userId }, user: { id: userId, name: "Fixture", email: "fixture@test.invalid" },
    }) }));
  } else result.use((req, _res, next) => { req.actor = actor as any; next(); });
  result.use("/api", issueTreeControlRoutes({} as any)); result.use(errorHandler); return result;
}
const rootId = "11111111-1111-4111-8111-111111111111", holdId = "33333333-3333-4333-8333-333333333333";
const board = { type: "board", userId: "user-1", companyIds: ["company-2"], source: "session", isInstanceAdmin: false };
describe("tree routes delegate one accepted composition and postcommit effects", () => {
  beforeEach(() => { vi.resetAllMocks(); getById.mockResolvedValue({ id: rootId, companyId: "company-2" }); });
  it("rejects cross-company preview before acceptance", async () => {
    const response = await request(await app({ ...board, companyIds: ["company-1"] })).post(`/api/issues/${rootId}/tree-control/preview`).send({ mode: "pause" });
    expect(response.status).toBe(403); expect(service.acceptAction).not.toHaveBeenCalled();
  });
  it("requires board access before resolving a root", async () => {
    const response = await request(await app({ type: "agent", agentId: "worker", companyId: "company-2" })).post(`/api/issues/${rootId}/tree-holds`).send({ mode: "pause" });
    expect(response.status).toBe(403); expect(getById).not.toHaveBeenCalled();
  });
  it.each(["pause", "cancel", "restore", "resume"])("preserves %s response and dispatches only the exact accepted result", async mode => {
    const result = { hold: { id: holdId, mode, status: mode === "resume" || mode === "restore" ? "released" : "active" }, preview: { mode, activeRuns: [], warnings: [] }, ...(mode === "resume" ? { resumedPauseHoldIds: ["old-hold"] } : {}) };
    const accepted = { kind: "create", result, effects: [{ kind: "fixture" }] }; service.acceptAction.mockResolvedValue(accepted);
    const response = await request(await app(board)).post(`/api/issues/${rootId}/tree-holds`).send({ mode, metadata: { wakeAgents: true } });
    expect(response.status).toBe(mode === "restore" || mode === "resume" ? 200 : 201); expect(response.body).toEqual(result);
    expect(service.acceptAction).toHaveBeenCalledOnce(); expect(service.acceptAction.mock.calls[0][0]).toMatchObject({ companyId: "company-2", rootIssueId: rootId, actor: { actorId: "user-1" }, authority: { read: expect.any(Function), stage: expect.any(Function) } });
    expect(service.acceptAction.mock.calls[0][1]).toEqual({ kind: "create", input: { mode, metadata: { wakeAgents: true } } });
    expect(service.dispatchTreeEffects).toHaveBeenCalledWith(accepted, runtime);
    expect(runtime.cancelRun).not.toHaveBeenCalled(); expect(runtime.wakeup).not.toHaveBeenCalled();
  });
  it.each([
    { endpoint: "tree-control/state", selection: { kind: "state" }, result: { activePauseHold: null } },
    { endpoint: "tree-holds", selection: { kind: "list", includeMembers: false }, result: [] },
    { endpoint: "tree-holds?includeMembers=true&status=active&mode=pause", selection: { kind: "list", includeMembers: true, status: "active", mode: "pause" }, result: [{ id: holdId, members: [] }] },
    { endpoint: `tree-holds/${holdId}`, selection: { kind: "detail", holdId }, result: { id: holdId, members: [] } },
  ])("returns only the coordinated read result for $endpoint", async ({ endpoint, selection, result }) => {
    service.readAction.mockResolvedValue(result);
    const response = await request(await app(board)).get(`/api/issues/${rootId}/${endpoint}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(service.readAction).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-2", rootIssueId: rootId }), expect.objectContaining(selection));
    expect(service.getHold).not.toHaveBeenCalled();
    expect(service.listHolds).not.toHaveBeenCalled();
    expect(service.authorizeRead).not.toHaveBeenCalled();
  });
  it("does not compensate or dispatch after failed atomic restoration", async () => {
    service.acceptAction.mockRejectedValue(conflict("Restore refused"));
    const response = await request(await app(board)).post(`/api/issues/${rootId}/tree-holds`).send({ mode: "restore" });
    expect(response.status).toBe(409); expect(service.acceptAction).toHaveBeenCalledOnce(); expect(service.dispatchTreeEffects).not.toHaveBeenCalled();
  });
  it("returns the existing preview shape from audited acceptance without runtime", async () => {
    const preview = { mode: "pause", totals: { affectedIssues: 1 } }; service.acceptAction.mockResolvedValue({ result: { preview }, effects: [] });
    const response = await request(await app(board)).post(`/api/issues/${rootId}/tree-control/preview`).send({ mode: "pause" });
    expect(response.status).toBe(200); expect(response.body).toEqual(preview); expect(service.acceptAction.mock.calls[0][2]).toEqual({ previewOnly: true }); expect(service.dispatchTreeEffects).not.toHaveBeenCalled();
  });
});
