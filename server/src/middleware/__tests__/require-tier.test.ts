// AgentDash: requireTier middleware tests
// Mocks Db so no Postgres needed; verifies 402 for below-floor, passthrough
// for at/above-floor, and 400 when companyId is missing.

import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { Db } from "@agentdash/db";
import { requireTier } from "../require-tier.js";

function makeDbWithPlan(planId: string | null): Db {
  return {
    select: vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.limit = vi
        .fn()
        .mockImplementation(() => Promise.resolve(planId ? [{ planId }] : []));
      return chain;
    }),
  } as unknown as Db;
}

function makeReqRes(companyId?: string) {
  const req = { params: companyId ? { companyId } : {} } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, status, json };
}

describe("requireTier", () => {
  it("returns 402 when company is below the required tier", async () => {
    const mw = requireTier(makeDbWithPlan(null), "pro");
    const { req, res, next, status, json } = makeReqRes("c1");
    await mw(req, res, next);
    expect(status).toHaveBeenCalledWith(402);
    expect(json).toHaveBeenCalledWith({
      error: "tier_insufficient",
      currentTier: "free",
      requiredTier: "pro",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when company tier matches the required tier", async () => {
    const mw = requireTier(makeDbWithPlan("pro"), "pro");
    const { req, res, next, status } = makeReqRes("c1");
    await mw(req, res, next);
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when company tier exceeds the required tier", async () => {
    const mw = requireTier(makeDbWithPlan("enterprise"), "pro");
    const { req, res, next } = makeReqRes("c1");
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 400 when companyId is missing from params", async () => {
    const mw = requireTier(makeDbWithPlan(null), "pro");
    const { req, res, next, status, json } = makeReqRes();
    await mw(req, res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "companyId required" });
    expect(next).not.toHaveBeenCalled();
  });

  it("propagates errors via next(err) when the db throws", async () => {
    const err = new Error("db boom");
    const db = {
      select: vi.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn().mockReturnValue(chain);
        chain.where = vi.fn().mockReturnValue(chain);
        chain.limit = vi.fn().mockImplementation(() => Promise.reject(err));
        return chain;
      }),
    } as unknown as Db;
    const mw = requireTier(db, "pro");
    const { req, res, next } = makeReqRes("c1");
    await mw(req, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
