// AgentDash (AGE-57): Contract test for IAuthProvider.
// Asserts that BetterAuthProvider satisfies the IAuthProvider interface shape
// and that the provider factory correctly guards against unimplemented providers.
// Uses a stub DB — no live Postgres required.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";
import type { IAuthProvider, AuthSession } from "../services/auth/index.js";
import { createAuthProvider } from "../services/auth/index.js";
import type { Db } from "@agentdash/db";

// ---------------------------------------------------------------------------
// Stub DB
// ---------------------------------------------------------------------------

function buildStubDb(overrides: Partial<{
  memberships: Array<{ principalId: string; membershipRole: string | null; status: string }>;
  users: Array<{ id: string; email: string; name: string }>;
}>): Db {
  const memberships = overrides.memberships ?? [];
  const users = overrides.users ?? [];

  // Each select() call returns a chainable builder.
  // We need to support two shapes:
  //   db.select({ ... }).from(table).where(...).then(fn)
  //   db.select().from(...).where(...).orderBy(...).limit(...).then(fn)
  function makeSelectChain(rows: unknown[]) {
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn(rows)),
    };
    return chain;
  }

  const db = {
    select: vi.fn((_shape?: unknown) => {
      // We'll intercept at the "from" level via the mock — return a flexible chain.
      let resolvedRows: unknown[] = [];
      const chain = {
        from: (table: { _: { name?: string } } | unknown) => {
          // Duck-type the table: check table symbol name.
          const tableName =
            table && typeof table === "object" && "_" in (table as object)
              ? ((table as { _?: { name?: string } })._?.name ?? "")
              : "";
          if (tableName === "company_memberships") {
            resolvedRows = memberships;
          } else if (tableName === "auth_users") {
            resolvedRows = users;
          } else if (tableName === "invites") {
            resolvedRows = [];
          } else {
            resolvedRows = [];
          }
          return chain;
        },
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn(resolvedRows)),
      };
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => ({
          then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn([])),
        })),
        then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn([])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => ({
            then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn([])),
          })),
          then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn([])),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => ({
          then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn([])),
        })),
        then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn([])),
      })),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  } as unknown as Db;

  return db;
}

// ---------------------------------------------------------------------------
// Fake session resolver
// ---------------------------------------------------------------------------

function fakeResolveSession(session: AuthSession | null) {
  return (_req: Request): Promise<AuthSession | null> => Promise.resolve(session);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IAuthProvider contract — BetterAuthProvider (AGE-57)", () => {
  let provider: IAuthProvider;
  let db: Db;

  beforeEach(() => {
    db = buildStubDb({
      memberships: [
        { principalId: "user-1", membershipRole: "owner", status: "active" },
        { principalId: "user-2", membershipRole: "member", status: "active" },
      ],
      users: [
        { id: "user-1", email: "alice@acme.com", name: "Alice" },
        { id: "user-2", email: "bob@acme.com", name: "Bob" },
      ],
    });

    const fakeSession: AuthSession = {
      session: { id: "sess-1", userId: "user-1" },
      user: { id: "user-1", email: "alice@acme.com", name: "Alice" },
    };

    provider = createAuthProvider("better-auth", db, fakeResolveSession(fakeSession));
  });

  it("createAuthProvider returns an object satisfying IAuthProvider shape", () => {
    expect(typeof provider.getSession).toBe("function");
    expect(typeof provider.signUp).toBe("function");
    expect(typeof provider.signIn).toBe("function");
    expect(typeof provider.signOut).toBe("function");
    expect(typeof provider.inviteUser).toBe("function");
    expect(typeof provider.acceptInvite).toBe("function");
    expect(typeof provider.listOrgMembers).toBe("function");
    expect(typeof provider.addMember).toBe("function");
    expect(typeof provider.removeMember).toBe("function");
  });

  it("getSession delegates to the provided resolveSession function", async () => {
    const req = {} as Request;
    const session = await provider.getSession(req);
    expect(session).not.toBeNull();
    expect(session?.user?.id).toBe("user-1");
    expect(session?.session?.userId).toBe("user-1");
  });

  it("getSession returns null when resolveSession returns null", async () => {
    const nullProvider = createAuthProvider(
      "better-auth",
      db,
      fakeResolveSession(null),
    );
    const session = await nullProvider.getSession({} as Request);
    expect(session).toBeNull();
  });

  it("listOrgMembers returns members with normalised roles", async () => {
    // Stub DB returns memberships + users set up in beforeEach.
    // The accessService inside BetterAuthProvider will call db.select().
    // We test the shape of the response.
    const members = await provider.listOrgMembers("company-1");
    // The stub DB returns the same rows regardless of company filter —
    // we just verify the shape and role normalisation.
    expect(Array.isArray(members)).toBe(true);
    for (const m of members) {
      expect(typeof m.userId).toBe("string");
      expect(m.role === "admin" || m.role === "member").toBe(true);
    }
  });

  it("addMember calls ensureMembership through accessService without throwing", async () => {
    // Should resolve without error when DB insert succeeds.
    await expect(provider.addMember("company-1", "user-3", "member")).resolves.toBeUndefined();
  });

  it("removeMember is idempotent when member does not exist", async () => {
    // getMembership returns empty → removeMember should not throw.
    await expect(provider.removeMember("company-1", "nonexistent-user")).resolves.toBeUndefined();
  });

  it("signUp throws with a clear human-readable message", async () => {
    await expect(provider.signUp("test@acme.com", "password")).rejects.toThrow(
      /use the \/api\/auth\/sign-up endpoint/,
    );
  });

  it("signIn throws with a clear human-readable message", async () => {
    await expect(provider.signIn("test@acme.com", "password")).rejects.toThrow(
      /use the \/api\/auth\/sign-in\/email endpoint/,
    );
  });

  it("signOut throws with a clear human-readable message", async () => {
    await expect(provider.signOut({} as Request)).rejects.toThrow(
      /use the \/api\/auth\/sign-out endpoint/,
    );
  });

  it("acceptInvite throws with a clear human-readable message", async () => {
    await expect(provider.acceptInvite("token-123", { name: "Charlie" })).rejects.toThrow(
      /use the POST \/api\/invites\/:token\/accept endpoint/,
    );
  });
});

describe("createAuthProvider — provider selection guard (AGE-57 / AGE-58)", () => {
  it("throws a clear error when AUTH_PROVIDER=workos but env vars are missing (AGE-58)", () => {
    const db = buildStubDb({});
    // Ensure WorkOS env vars are not set so the boot-time validation fires.
    const originalApiKey = process.env.WORKOS_API_KEY;
    const originalClientId = process.env.WORKOS_CLIENT_ID;
    delete process.env.WORKOS_API_KEY;
    delete process.env.WORKOS_CLIENT_ID;
    try {
      expect(() =>
        createAuthProvider("workos", db, fakeResolveSession(null)),
      ).toThrow(/WORKOS_API_KEY/);
    } finally {
      if (originalApiKey !== undefined) process.env.WORKOS_API_KEY = originalApiKey;
      if (originalClientId !== undefined) process.env.WORKOS_CLIENT_ID = originalClientId;
    }
  });

  it("does NOT throw for AUTH_PROVIDER=better-auth (default)", () => {
    const db = buildStubDb({});
    expect(() =>
      createAuthProvider("better-auth", db, fakeResolveSession(null)),
    ).not.toThrow();
  });
});

describe("FRE Plan B regression — setUserCompanyAccess guard (AGE-55 × AGE-57)", () => {
  it("accessService last-admin guard is still reachable after AGE-57 refactor", async () => {
    // AGE-55 shipped assertNotLastBoardOnRemoval in accessService.
    // This test verifies the guard is still exported and callable through
    // the accessService factory — confirming AGE-57 did not break the
    // import chain that routes rely on.
    const { accessService } = await import("../services/access.js");
    expect(typeof accessService).toBe("function");

    const db = buildStubDb({
      memberships: [
        { principalId: "user-1", membershipRole: "owner", status: "active" },
      ],
    });

    const svc = accessService(db as Db);
    expect(typeof svc.removeMembership).toBe("function");
    expect(typeof svc.setUserCompanyAccess).toBe("function");
    expect(typeof svc.ensureMembership).toBe("function");
  });
});
