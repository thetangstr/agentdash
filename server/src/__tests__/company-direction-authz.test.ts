import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { assertCanSetCompanyDirection } from "../routes/authz.js";

/**
 * Who may move the goalposts.
 *
 * Verified against a live instance before this guard existed: an ordinary agent
 * key PATCHed the company goal it had been given and got HTTP 200. That is the
 * worst shape this bug can take, because everything downstream — on-track or
 * not, mandate honoured or not, what the board pack says — is measured against
 * the goal. An agent that can move the goal can report success by moving it,
 * and the audit log will faithfully record that the goal simply changed.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";

function req(actor: Record<string, unknown>, method = "PATCH"): Request {
  return { method, actor } as unknown as Request;
}

function human(role: string | null, opts: { instanceAdmin?: boolean } = {}) {
  return {
    type: "board",
    source: "session",
    userId: "user-1",
    isInstanceAdmin: opts.instanceAdmin ?? false,
    companyIds: [COMPANY],
    memberships: role
      ? [{ companyId: COMPANY, membershipRole: role, status: "active" }]
      : [],
  };
}

describe("assertCanSetCompanyDirection", () => {
  it("refuses an agent, even one that belongs to the company", () => {
    expect(() =>
      assertCanSetCompanyDirection(
        req({ type: "agent", agentId: "agent-1", companyId: COMPANY }),
        COMPANY,
      ),
    ).toThrow(/Agents cannot change company direction/);
  });

  it("lets an owner set direction", () => {
    expect(() => assertCanSetCompanyDirection(req(human("owner")), COMPANY)).not.toThrow();
  });

  it("lets an admin set direction", () => {
    expect(() => assertCanSetCompanyDirection(req(human("admin")), COMPANY)).not.toThrow();
  });

  it("refuses an ordinary member — the colleague you invited to help", () => {
    // The case that prompted this: someone invited to work toward the goals
    // should not be able to redefine them.
    expect(() => assertCanSetCompanyDirection(req(human("member")), COMPANY)).toThrow(
      /Only an owner or admin/,
    );
  });

  it("refuses an operator", () => {
    expect(() => assertCanSetCompanyDirection(req(human("operator")), COMPANY)).toThrow(
      /Only an owner or admin/,
    );
  });

  it("refuses a viewer, as read-only already did", () => {
    expect(() => assertCanSetCompanyDirection(req(human("viewer")), COMPANY)).toThrow();
  });

  it("lets an instance admin through, as everywhere else", () => {
    expect(() =>
      assertCanSetCompanyDirection(req(human(null, { instanceAdmin: true })), COMPANY),
    ).not.toThrow();
  });

  it("lets the local operator through on a local_trusted box", () => {
    // No other user exists there to defer to.
    expect(() =>
      assertCanSetCompanyDirection(req({ type: "board", source: "local_implicit" }), COMPANY),
    ).not.toThrow();
  });

  it("still refuses an agent from another company", () => {
    expect(() =>
      assertCanSetCompanyDirection(
        req({ type: "agent", agentId: "agent-9", companyId: "22222222-2222-4222-8222-222222222222" }),
        COMPANY,
      ),
    ).toThrow(/another company/);
  });
});
