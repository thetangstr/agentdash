// AgentDash (AGE-58): Contract tests for WorkOSProvider.
// Mocks the @workos-inc/node SDK so no live WorkOS API calls are made.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";

// ---------------------------------------------------------------------------
// Mock @workos-inc/node before any imports that depend on it
// ---------------------------------------------------------------------------

const mockWorkOS = {
  userManagement: {
    authenticateWithSessionCookie: vi.fn(),
    createUser: vi.fn(),
    authenticateWithPassword: vi.fn(),
    authenticateWithMagicAuth: vi.fn(),
    updateUser: vi.fn(),
    sendInvitation: vi.fn(),
    listOrganizationMemberships: vi.fn(),
    createOrganizationMembership: vi.fn(),
    deleteOrganizationMembership: vi.fn(),
    getUser: vi.fn(),
  },
  organizations: {
    createOrganization: vi.fn(),
    listOrganizations: vi.fn(),
  },
};

vi.mock("@workos-inc/node", () => ({
  WorkOS: vi.fn(() => mockWorkOS),
  // Export the enum so workos-provider.ts can use DomainDataState.Pending
  DomainDataState: {
    Pending: "pending",
    Verified: "verified",
  },
}));

import { createWorkOSProvider } from "../services/auth/workos-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProvider() {
  return createWorkOSProvider({ apiKey: "sk_test_key", clientId: "client_test" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkOSProvider (AGE-58)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // getSession
  // -------------------------------------------------------------------------

  describe("getSession", () => {
    it("returns null when no Authorization header is present", async () => {
      const provider = buildProvider();
      const req = { headers: {} } as Request;
      const result = await provider.getSession(req);
      expect(result).toBeNull();
    });

    it("returns null when Authorization header is not Bearer", async () => {
      const provider = buildProvider();
      const req = { headers: { authorization: "Basic abc123" } } as Request;
      const result = await provider.getSession(req);
      expect(result).toBeNull();
    });

    it("returns null when WorkOS token validation fails", async () => {
      mockWorkOS.userManagement.authenticateWithSessionCookie.mockRejectedValueOnce(
        new Error("Invalid token"),
      );
      const provider = buildProvider();
      const req = { headers: { authorization: "Bearer bad-token" } } as Request;
      const result = await provider.getSession(req);
      expect(result).toBeNull();
    });

    it("returns a valid AuthSession when token is valid", async () => {
      mockWorkOS.userManagement.authenticateWithSessionCookie.mockResolvedValueOnce({
        authenticated: true,
        user: { id: "user_wos_1", email: "alice@acme.com", firstName: "Alice", lastName: "Smith" },
        accessToken: "access_token_abc",
        sessionId: "sess_abc",
      });
      const provider = buildProvider();
      const req = { headers: { authorization: "Bearer valid-token" } } as Request;
      const result = await provider.getSession(req);
      expect(result).not.toBeNull();
      expect(result?.user?.id).toBe("user_wos_1");
      expect(result?.user?.email).toBe("alice@acme.com");
      expect(result?.user?.name).toBe("Alice Smith");
      expect(result?.session?.userId).toBe("user_wos_1");
    });
  });

  // -------------------------------------------------------------------------
  // signUp — free-mail block
  // -------------------------------------------------------------------------

  describe("signUp — free-mail block", () => {
    it("rejects gmail.com with code pro_requires_corp_email", async () => {
      const provider = buildProvider();
      await expect(provider.signUp("user@gmail.com", "pass")).rejects.toThrow(
        "pro_requires_corp_email",
      );
    });

    it("rejects outlook.com with code pro_requires_corp_email", async () => {
      const provider = buildProvider();
      await expect(provider.signUp("user@outlook.com", "pass")).rejects.toThrow(
        "pro_requires_corp_email",
      );
    });

    it("rejects protonmail.com with code pro_requires_corp_email", async () => {
      const provider = buildProvider();
      await expect(provider.signUp("user@protonmail.com", "pass")).rejects.toThrow(
        "pro_requires_corp_email",
      );
    });

    it("does NOT reject a corporate email domain", async () => {
      mockWorkOS.organizations.createOrganization.mockResolvedValueOnce({
        id: "org_1",
        domains: [{ domain: "acme.com", state: "pending", verificationUrl: "https://verify.workos.com/acme" }],
      });
      mockWorkOS.userManagement.createUser.mockResolvedValueOnce({
        id: "user_wos_2",
        email: "bob@acme.com",
      });
      mockWorkOS.userManagement.createOrganizationMembership.mockResolvedValueOnce({});

      const provider = buildProvider();
      const result = await provider.signUp("bob@acme.com", "password123", "Bob Jones");
      expect(result.userId).toBe("user_wos_2");
    });
  });

  // -------------------------------------------------------------------------
  // signUp — org creation
  // -------------------------------------------------------------------------

  describe("signUp — org creation", () => {
    it("creates a WorkOS org, creates the user, and returns userId", async () => {
      mockWorkOS.organizations.createOrganization.mockResolvedValueOnce({
        id: "org_acme",
        domains: [],
      });
      mockWorkOS.userManagement.createUser.mockResolvedValueOnce({
        id: "user_wos_3",
        email: "carol@corp.com",
      });
      mockWorkOS.userManagement.createOrganizationMembership.mockResolvedValueOnce({});

      const provider = buildProvider();
      const result = await provider.signUp("carol@corp.com", "pass", "Carol");
      expect(result.userId).toBe("user_wos_3");
      expect(mockWorkOS.organizations.createOrganization).toHaveBeenCalledWith(
        expect.objectContaining({ domainData: expect.arrayContaining([expect.objectContaining({ domain: "corp.com" })]) }),
      );
    });

    it("falls back to existing org when createOrganization throws", async () => {
      mockWorkOS.organizations.createOrganization.mockRejectedValueOnce(new Error("already exists"));
      mockWorkOS.organizations.listOrganizations.mockResolvedValueOnce({
        data: [{ id: "org_existing", name: "existing.com" }],
      });
      mockWorkOS.userManagement.createUser.mockResolvedValueOnce({
        id: "user_wos_4",
        email: "dave@existing.com",
      });
      mockWorkOS.userManagement.createOrganizationMembership.mockResolvedValueOnce({});

      const provider = buildProvider();
      const result = await provider.signUp("dave@existing.com", "pass");
      expect(result.userId).toBe("user_wos_4");
    });
  });

  // -------------------------------------------------------------------------
  // signIn
  // -------------------------------------------------------------------------

  describe("signIn", () => {
    it("returns a sealed session token on success", async () => {
      mockWorkOS.userManagement.authenticateWithPassword.mockResolvedValueOnce({
        sealedSession: "sealed_token_abc",
        accessToken: "access_token_fallback",
      });
      const provider = buildProvider();
      const result = await provider.signIn("alice@acme.com", "password");
      expect(result.token).toBe("sealed_token_abc");
    });

    it("falls back to accessToken when sealedSession is absent", async () => {
      mockWorkOS.userManagement.authenticateWithPassword.mockResolvedValueOnce({
        accessToken: "access_token_only",
      });
      const provider = buildProvider();
      const result = await provider.signIn("alice@acme.com", "password");
      expect(result.token).toBe("access_token_only");
    });

    it("throws when WorkOS returns an auth error", async () => {
      mockWorkOS.userManagement.authenticateWithPassword.mockRejectedValueOnce(
        new Error("Invalid credentials"),
      );
      const provider = buildProvider();
      await expect(provider.signIn("alice@acme.com", "wrong")).rejects.toThrow("Invalid credentials");
    });
  });

  // -------------------------------------------------------------------------
  // signOut
  // -------------------------------------------------------------------------

  describe("signOut", () => {
    it("resolves without error (WorkOS free tier is client-side only)", async () => {
      const provider = buildProvider();
      await expect(provider.signOut({} as Request)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // inviteUser
  // -------------------------------------------------------------------------

  describe("inviteUser", () => {
    it("delegates to WorkOS Invitations API and returns inviteId", async () => {
      mockWorkOS.userManagement.sendInvitation.mockResolvedValueOnce({ id: "inv_abc123" });
      const provider = buildProvider();
      const result = await provider.inviteUser("org_1", "newuser@acme.com", "member");
      expect(result.inviteId).toBe("inv_abc123");
      expect(mockWorkOS.userManagement.sendInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ email: "newuser@acme.com", organizationId: "org_1" }),
      );
    });

    it("maps admin role to WorkOS admin slug", async () => {
      mockWorkOS.userManagement.sendInvitation.mockResolvedValueOnce({ id: "inv_admin" });
      const provider = buildProvider();
      await provider.inviteUser("org_1", "admin@acme.com", "admin");
      expect(mockWorkOS.userManagement.sendInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ roleSlug: "admin" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // listOrgMembers
  // -------------------------------------------------------------------------

  describe("listOrgMembers", () => {
    it("returns members with normalised roles", async () => {
      mockWorkOS.userManagement.listOrganizationMemberships.mockResolvedValueOnce({
        data: [
          { id: "mem_1", userId: "user_1", role: { slug: "admin" } },
          { id: "mem_2", userId: "user_2", role: { slug: "member" } },
        ],
      });
      mockWorkOS.userManagement.getUser
        .mockResolvedValueOnce({ id: "user_1", email: "alice@acme.com", firstName: "Alice", lastName: "A" })
        .mockResolvedValueOnce({ id: "user_2", email: "bob@acme.com", firstName: "Bob", lastName: "B" });

      const provider = buildProvider();
      const members = await provider.listOrgMembers("org_1");
      expect(members).toHaveLength(2);
      expect(members[0].role).toBe("admin");
      expect(members[1].role).toBe("member");
      expect(members[0].email).toBe("alice@acme.com");
    });
  });

  // -------------------------------------------------------------------------
  // addMember
  // -------------------------------------------------------------------------

  describe("addMember", () => {
    it("calls createOrganizationMembership with correct args", async () => {
      mockWorkOS.userManagement.createOrganizationMembership.mockResolvedValueOnce({});
      const provider = buildProvider();
      await provider.addMember("org_1", "user_1", "member");
      expect(mockWorkOS.userManagement.createOrganizationMembership).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: "org_1", userId: "user_1", roleSlug: "member" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // removeMember
  // -------------------------------------------------------------------------

  describe("removeMember", () => {
    it("is idempotent when member does not exist", async () => {
      mockWorkOS.userManagement.listOrganizationMemberships.mockResolvedValueOnce({ data: [] });
      const provider = buildProvider();
      await expect(provider.removeMember("org_1", "nonexistent")).resolves.toBeUndefined();
    });

    it("throws when removing the last admin", async () => {
      // First call: find membership for the user
      mockWorkOS.userManagement.listOrganizationMemberships
        .mockResolvedValueOnce({
          data: [{ id: "mem_1", userId: "user_1", role: { slug: "admin" } }],
        })
        // Second call: list all members to count admins
        .mockResolvedValueOnce({
          data: [{ id: "mem_1", userId: "user_1", role: { slug: "admin" } }],
        });

      const provider = buildProvider();
      await expect(provider.removeMember("org_1", "user_1")).rejects.toThrow(
        /Cannot remove the last admin/,
      );
    });

    it("deletes the membership when not the last admin", async () => {
      mockWorkOS.userManagement.listOrganizationMemberships
        .mockResolvedValueOnce({
          data: [{ id: "mem_2", userId: "user_2", role: { slug: "member" } }],
        })
        .mockResolvedValueOnce({
          data: [
            { id: "mem_1", userId: "user_1", role: { slug: "admin" } },
            { id: "mem_2", userId: "user_2", role: { slug: "member" } },
          ],
        });
      mockWorkOS.userManagement.deleteOrganizationMembership.mockResolvedValueOnce(undefined);

      const provider = buildProvider();
      await provider.removeMember("org_1", "user_2");
      expect(mockWorkOS.userManagement.deleteOrganizationMembership).toHaveBeenCalledWith("mem_2");
    });
  });
});
