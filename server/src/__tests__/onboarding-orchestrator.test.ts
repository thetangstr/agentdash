import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  OnboardingTierCapacityExceededError,
  onboardingOrchestrator,
} from "../services/onboarding-orchestrator.js";

const mockAccess = {
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
  listUserCompanyAccess: vi.fn(),
  listActiveUserMemberships: vi.fn(),
  promoteSelfServeBootstrapAdmin: vi.fn(),
};
const mockCompanies = { create: vi.fn(), getById: vi.fn(), findByEmailDomain: vi.fn(), hasActiveCompany: vi.fn(), list: vi.fn() };
const mockAgents = { create: vi.fn(), createApiKey: vi.fn(), list: vi.fn(), listKeys: vi.fn() };
const mockInstructions = { materializeManagedBundle: vi.fn() };
const mockConversations = { findByCompany: vi.fn(), create: vi.fn(), addParticipant: vi.fn(), postMessage: vi.fn() };
const mockUsers = { getById: vi.fn() };

const deps = { access: mockAccess, companies: mockCompanies, agents: mockAgents, instructions: mockInstructions, conversations: mockConversations, users: mockUsers };
const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;

function tierCapacityDeps() {
  return {
    withCompanyLock: vi.fn(async (_companyId: string, work: (services: typeof deps) => Promise<unknown>) =>
      work(deps),
    ),
    capacityDepsFor: (services: typeof deps) => ({
      getCompany: async (id: string) => {
        const company = await services.companies.getById(id);
        return { planTier: company?.planTier ?? "free" };
      },
      counts: {
        humans: async (companyId: string) =>
          (await services.access.listActiveUserMemberships(companyId)).length,
        agents: async (companyId: string) =>
          (await services.agents.list(companyId)).length,
      },
    }),
  };
}

describe("onboardingOrchestrator.bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (originalStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    mockUsers.getById.mockResolvedValue({ id: "user-1", email: "alice@acme.com", name: "Alice Anderson" });
    mockAccess.listUserCompanyAccess.mockResolvedValue([]);
    mockAccess.listActiveUserMemberships.mockResolvedValue([]);
    mockCompanies.hasActiveCompany.mockResolvedValue(false);
    mockCompanies.list.mockResolvedValue([]);
    mockCompanies.create.mockResolvedValue({ id: "company-1", name: "Acme", emailDomain: "acme.com" });
    mockCompanies.getById.mockResolvedValue({ id: "company-1", name: "Acme", emailDomain: "acme.com" });
    mockCompanies.findByEmailDomain.mockResolvedValue(null);
    mockAgents.list.mockResolvedValue([]);
    mockAgents.listKeys.mockResolvedValue([]);
    mockAgents.create.mockResolvedValue({ id: "agent-cos-1", companyId: "company-1", role: "chief_of_staff", adapterType: "claude_api", adapterConfig: {} });
    mockAgents.createApiKey.mockResolvedValue({ id: "key-1", token: "agk_test" });
    mockInstructions.materializeManagedBundle.mockResolvedValue({ adapterConfig: { instructionsFilePath: "/tmp/AGENTS.md" } });
    mockConversations.findByCompany.mockResolvedValue(null);
    mockConversations.create.mockResolvedValue({ id: "conv-1", companyId: "company-1" });
    mockConversations.postMessage.mockResolvedValue({ id: "msg-1" });
    mockAccess.setPrincipalPermission.mockResolvedValue(undefined);
    mockAccess.ensureMembership.mockResolvedValue(undefined);
    mockConversations.addParticipant.mockResolvedValue(undefined);
  });

  it("creates company, CoS agent, API key, and conversation for a fresh user", async () => {
    const result = await onboardingOrchestrator(deps as any).bootstrap("user-1");
    expect(result).toEqual({ companyId: "company-1", cosAgentId: "agent-cos-1", conversationId: "conv-1" });
    expect(mockAccess.setPrincipalPermission).toHaveBeenCalledWith("company-1", "user", "user-1", "agents:create", true, "user-1");
    expect(mockAccess.ensureMembership).toHaveBeenCalledWith("company-1", "user", "user-1", "owner", "active");
    expect(mockAgents.create).toHaveBeenCalled();
    expect(mockConversations.addParticipant).toHaveBeenCalledWith("conv-1", "user-1", "owner");
  });

  // AgentDash (scan 2, E3): the founder stewards the CoS made for them.
  it("pairs the founder with the Chief of Staff after the bootstrap, when stewardships are wired", async () => {
    const stewardships = {
      isCompanyOwner: vi.fn(async () => true),
      activeByAgent: vi.fn(async () => null),
      activeByUser: vi.fn(async () => null),
      assign: vi.fn(async () => ({})),
    };
    const result = await onboardingOrchestrator({
      ...(deps as any),
      tierCapacity: tierCapacityDeps(),
      stewardships,
    }).bootstrap("user-1");
    expect(result.cosAgentId).toBe("agent-cos-1");
    expect(stewardships.assign).toHaveBeenCalledWith("company-1", {
      agentId: "agent-cos-1",
      userId: "user-1",
      assignedByUserId: "user-1",
    });
  });

  // PR #955 review: with #956 an admin may bootstrap /cos too; only the
  // company's owner is paired with the CoS.
  it("does not pair a bootstrapping user who is not the company's owner", async () => {
    const stewardships = {
      isCompanyOwner: vi.fn(async () => false),
      activeByAgent: vi.fn(async () => null),
      activeByUser: vi.fn(async () => null),
      assign: vi.fn(async () => ({})),
    };
    const result = await onboardingOrchestrator({ ...(deps as any), stewardships }).bootstrap("user-1");
    expect(result.cosAgentId).toBe("agent-cos-1");
    expect(stewardships.isCompanyOwner).toHaveBeenCalledWith("company-1", "user-1");
    expect(stewardships.assign).not.toHaveBeenCalled();
  });

  it("does not pair a user who bootstraps into a workspace whose CoS already exists", async () => {
    mockAgents.list.mockResolvedValue([{ id: "agent-cos-1", role: "chief_of_staff" }]);
    const stewardships = {
      isCompanyOwner: vi.fn(async () => true),
      activeByAgent: vi.fn(async () => null),
      activeByUser: vi.fn(async () => null),
      assign: vi.fn(async () => ({})),
    };
    await onboardingOrchestrator({ ...(deps as any), stewardships }).bootstrap("user-1");
    expect(stewardships.assign).not.toHaveBeenCalled();
  });

  it("still completes the bootstrap when the founder pairing fails", async () => {
    const stewardships = {
      isCompanyOwner: vi.fn(async () => true),
      activeByAgent: vi.fn(async () => null),
      activeByUser: vi.fn(async () => null),
      assign: vi.fn(async () => {
        throw new Error("membership not active");
      }),
    };
    const result = await onboardingOrchestrator({ ...(deps as any), stewardships }).bootstrap("user-1");
    expect(result).toEqual({ companyId: "company-1", cosAgentId: "agent-cos-1", conversationId: "conv-1" });
  });

  it("posts ONE Phase 0 greeting (greeting + role + first goal question) when the conversation is fresh", async () => {
    // Phase 0 of the spec at
    // docs/superpowers/specs/2026-05-04-cos-onboarding-conversation-design.md.
    // The opening turn collapses greeting + context + first question into one
    // message — anything more reads like a robot survey, per the user's
    // feedback after the previous 4-bubble version.
    await onboardingOrchestrator(deps as any).bootstrap("user-1");
    expect(mockConversations.postMessage).toHaveBeenCalledTimes(1);
    const call = mockConversations.postMessage.mock.calls[0][0];
    expect(call).toMatchObject({
      conversationId: "conv-1",
      authorKind: "agent",
      authorId: "agent-cos-1",
    });
    expect(call.cardKind).toBeUndefined();
    // Personalized salutation uses the user's first name.
    expect(call.body).toContain("Alice");
    // Identifies the agent role.
    expect(call.body).toMatch(/chief of staff/i);
    // Names the company the agent works FOR, not the product it runs on: a
    // founder opening their own workspace was being greeted by a Chief of Staff
    // who said it worked somewhere else (#449).
    expect(call.body).toMatch(/chief of staff at Acme/i);
    expect(call.body).not.toMatch(/chief of staff at agentdash/i);
    // Asks the first goal question (short-term + long-term framing).
    expect(call.body).toMatch(/short-term/i);
    expect(call.body).toMatch(/6.?12 months|long-?term/i);
  });

  it("falls back to a generic salutation when the user has no name", async () => {
    mockUsers.getById.mockResolvedValue({ id: "user-1", email: "alice@acme.com", name: null });
    await onboardingOrchestrator(deps as any).bootstrap("user-1");
    const call = mockConversations.postMessage.mock.calls[0][0];
    // No name → "Hi there!" rather than "Hi {firstName}!".
    expect(call.body).toMatch(/^Hi there!/);
    expect(call.body).not.toMatch(/^Hi null/);
  });

  it("is idempotent — second call returns existing artifacts (user-membership check, NOT domain lookup) and posts NO welcome messages", async () => {
    await onboardingOrchestrator(deps as any).bootstrap("user-1");
    vi.clearAllMocks();
    mockUsers.getById.mockResolvedValue({ id: "user-1", email: "alice@acme.com", name: "Alice Anderson" });
    // Second call: user already has an active membership — reuse that company.
    mockAccess.listUserCompanyAccess.mockResolvedValue([{ companyId: "company-1", status: "active", principalId: "user-1", membershipRole: "owner" }]);
    mockCompanies.getById.mockResolvedValue({ id: "company-1", name: "Acme", emailDomain: "acme.com" });
    mockAgents.list.mockResolvedValue([{ id: "agent-cos-1", role: "chief_of_staff", adapterType: "claude_api", adapterConfig: {} }]);
    mockAgents.listKeys.mockResolvedValue([{ id: "key-1" }]);
    mockConversations.findByCompany.mockResolvedValue({ id: "conv-1", companyId: "company-1" });
    mockAccess.setPrincipalPermission.mockResolvedValue(undefined);
    mockAccess.ensureMembership.mockResolvedValue(undefined);
    mockConversations.addParticipant.mockResolvedValue(undefined);

    const result = await onboardingOrchestrator(deps as any).bootstrap("user-1");
    expect(result).toEqual({ companyId: "company-1", cosAgentId: "agent-cos-1", conversationId: "conv-1" });
    // Must NOT create a new company on the second bootstrap call.
    expect(mockCompanies.create).not.toHaveBeenCalled();
    expect(mockAgents.create).not.toHaveBeenCalled();
    expect(mockAgents.createApiKey).not.toHaveBeenCalled();
    expect(mockConversations.create).not.toHaveBeenCalled();
    // And — critically — it must NOT post the welcome sequence again.
    expect(mockConversations.postMessage).not.toHaveBeenCalled();
  });

  it("uses the requested workspace when the user is an active member of it, and ignores one they are not", async () => {
    mockAccess.listUserCompanyAccess.mockResolvedValue([
      { companyId: "company-1", status: "active", principalId: "user-1", membershipRole: "owner" },
      { companyId: "company-2", status: "active", principalId: "user-1", membershipRole: "owner" },
    ]);
    mockCompanies.getById.mockImplementation(async (id: string) => ({ id, name: id === "company-2" ? "Beta" : "Acme", emailDomain: null }));
    mockConversations.create.mockImplementation(async ({ companyId }: { companyId: string }) => ({ id: `conv-${companyId}`, companyId }));

    const second = await onboardingOrchestrator(deps as any).bootstrap("user-1", { companyId: "company-2" });
    expect(second.companyId).toBe("company-2");

    const stranger = await onboardingOrchestrator(deps as any).bootstrap("user-1", { companyId: "company-9" });
    expect(stranger.companyId).toBe("company-1");
    expect(mockCompanies.create).not.toHaveBeenCalled();
  });

  // PR #956 review (HIGH): bootstrap used to grant agents:create and rewrite
  // the caller's membership to owner, so any member could promote themselves.
  describe("authorization on an existing workspace", () => {
    function memberOf(role: string, userId = "user-1", status = "active") {
      mockAccess.listUserCompanyAccess.mockResolvedValue([
        { companyId: "company-1", status, principalId: userId, membershipRole: role },
      ]);
    }

    it.each(["viewer", "member", "operator"])("refuses a %s with 403 and leaves their role alone", async (role) => {
      memberOf(role);
      await expect(
        onboardingOrchestrator(deps as any).bootstrap("user-1", { companyId: "company-1" }),
      ).rejects.toMatchObject({ status: 403 });
      // Also without a companyId (the first active membership).
      await expect(onboardingOrchestrator(deps as any).bootstrap("user-1")).rejects.toMatchObject({ status: 403 });
      expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
      expect(mockAccess.setPrincipalPermission).not.toHaveBeenCalled();
      expect(mockAgents.create).not.toHaveBeenCalled();
      expect(mockConversations.create).not.toHaveBeenCalled();
    });

    it.each(["owner", "admin"])("lets an %s set up the CoS without rewriting their membership", async (role) => {
      memberOf(role);
      const result = await onboardingOrchestrator(deps as any).bootstrap("user-1", { companyId: "company-1" });
      expect(result.companyId).toBe("company-1");
      expect(mockAgents.create).toHaveBeenCalled();
      expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
    });

    it("lets an instance admin set up a workspace where they are only a viewer, without promoting them", async () => {
      memberOf("viewer");
      const result = await onboardingOrchestrator(deps as any).bootstrap("user-1", {
        companyId: "company-1",
        actorIsInstanceAdmin: true,
      });
      expect(result.companyId).toBe("company-1");
      expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
    });

    it("lets the local_trusted local-board actor through", async () => {
      mockUsers.getById.mockResolvedValue(null);
      memberOf("member", "local-board");
      const result = await onboardingOrchestrator(deps as any).bootstrap("local-board", { companyId: "company-1" });
      expect(result.companyId).toBe("company-1");
      expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
    });

    it("refuses an archived workspace", async () => {
      memberOf("owner");
      mockCompanies.getById.mockResolvedValue({ id: "company-1", name: "Acme", status: "archived" });
      await expect(
        onboardingOrchestrator(deps as any).bootstrap("user-1", { companyId: "company-1" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(mockAgents.create).not.toHaveBeenCalled();
    });

    it("does not reactivate a suspended membership through the same-domain path", async () => {
      mockAccess.listUserCompanyAccess.mockResolvedValue([
        { companyId: "company-1", status: "suspended", principalId: "user-1", membershipRole: "viewer" },
      ]);
      mockCompanies.findByEmailDomain.mockResolvedValue({ id: "company-1", name: "Acme", emailDomain: "acme.com" });
      await expect(onboardingOrchestrator(deps as any).bootstrap("user-1")).rejects.toMatchObject({ status: 409 });
      expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
    });

    it("refuses a strict companyId the caller is not a member of with 400, before any write (assessment route)", async () => {
      memberOf("owner");
      await expect(
        onboardingOrchestrator(deps as any).bootstrap("user-1", { companyId: "company-9", strictCompanyId: true }),
      ).rejects.toMatchObject({ status: 400 });
      expect(mockCompanies.getById).not.toHaveBeenCalled();
      expect(mockAccess.setPrincipalPermission).not.toHaveBeenCalled();
      expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
      expect(mockAgents.create).not.toHaveBeenCalled();
      expect(mockConversations.create).not.toHaveBeenCalled();
    });

    it("leaves the legitimate founder alone: owner from POST /companies, same email domain, CoS set up", async () => {
      // POST /companies created company-1 for alice@acme.com and made her owner;
      // /cos then bootstraps it. The same-domain refusal must not catch her.
      memberOf("owner");
      mockCompanies.findByEmailDomain.mockResolvedValue({ id: "company-1", name: "Acme", emailDomain: "acme.com" });
      const result = await onboardingOrchestrator(deps as any).bootstrap("user-1", { companyId: "company-1" });
      expect(result.companyId).toBe("company-1");
      expect(mockAgents.create).toHaveBeenCalled();
      expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
    });
  });

  it("creates a fresh isolated workspace for a free-mail user even when another same-domain user exists", async () => {
    // gmail.com user-2 signs up; user-1 (also gmail.com) already has a company.
    // For free-mail providers, deriveCompanyEmailDomain returns "<local>@<domain>"
    // so each personal account has its own workspace key — the unique constraint
    // doesn't collide with another gmail user, and findByEmailDomain isn't even
    // consulted for free-mail keys (they contain "@", which the orchestrator
    // uses as the discriminator).
    mockUsers.getById.mockResolvedValue({ id: "user-2", email: "bob@gmail.com" });
    mockAccess.listUserCompanyAccess.mockResolvedValue([]); // user-2 has NO memberships yet
    mockCompanies.create.mockResolvedValue({ id: "company-2", name: "Gmail", emailDomain: "bob@gmail.com" });
    mockAgents.create.mockResolvedValue({ id: "agent-cos-2", companyId: "company-2", role: "chief_of_staff", adapterType: "claude_api", adapterConfig: {} });
    mockConversations.create.mockResolvedValue({ id: "conv-2", companyId: "company-2" });

    const result = await onboardingOrchestrator(deps as any).bootstrap("user-2");
    expect(result.companyId).toBe("company-2");
    // Free-mail keys are per-user; corp-domain lookup is skipped for them.
    expect(mockCompanies.findByEmailDomain).not.toHaveBeenCalled();
    expect(mockCompanies.create).toHaveBeenCalledWith(expect.objectContaining({ emailDomain: "bob@gmail.com" }));
  });

  // PR #956 re-review: a same-domain stranger used to be attached to the
  // existing workspace as OWNER, with agents:create and a CoS. Joining is by
  // invite — the answer POST /companies already gives ("Contact your
  // administrator to join it") — so bootstrap refuses and writes nothing.
  it("does not auto-join a corp-domain user to an existing same-domain workspace", async () => {
    mockUsers.getById.mockResolvedValue({ id: "user-3", email: "alice@acme.com" });
    mockAccess.listUserCompanyAccess.mockResolvedValue([]);
    mockCompanies.findByEmailDomain.mockResolvedValue({ id: "company-acme", name: "Acme", emailDomain: "acme.com" });
    mockAgents.list.mockResolvedValue([]);

    await expect(onboardingOrchestrator(deps as any).bootstrap("user-3")).rejects.toMatchObject({
      status: 409,
      code: "domain_already_claimed",
      message: expect.stringContaining("Contact your administrator"),
    });
    expect(mockCompanies.findByEmailDomain).toHaveBeenCalledWith("acme.com");
    expect(mockCompanies.create).not.toHaveBeenCalled();
    expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
    expect(mockAccess.setPrincipalPermission).not.toHaveBeenCalled();
    expect(mockAgents.create).not.toHaveBeenCalled();
    expect(mockAgents.createApiKey).not.toHaveBeenCalled();
    expect(mockConversations.create).not.toHaveBeenCalled();
    expect(mockConversations.addParticipant).not.toHaveBeenCalled();
  });

  it("refuses a second corp-domain human on a Free workspace before taking the capacity lock", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_free_caps";
    mockUsers.getById.mockResolvedValue({ id: "user-3", email: "alice@acme.com" });
    mockAccess.listUserCompanyAccess.mockResolvedValue([]);
    mockAccess.listActiveUserMemberships.mockResolvedValue([
      { companyId: "company-acme", principalId: "existing-user" },
    ]);
    mockCompanies.findByEmailDomain.mockResolvedValue({
      id: "company-acme",
      name: "Acme",
      emailDomain: "acme.com",
    });
    mockCompanies.getById.mockResolvedValue({
      id: "company-acme",
      name: "Acme",
      emailDomain: "acme.com",
      planTier: "free",
    });
    mockAgents.list.mockResolvedValue([
      { id: "agent-cos-acme", role: "chief_of_staff" },
    ]);

    const tierCapacity = tierCapacityDeps();
    await expect(
      onboardingOrchestrator({ ...(deps as any), tierCapacity }).bootstrap("user-3"),
    ).rejects.toMatchObject({ status: 409, code: "domain_already_claimed" });

    expect(tierCapacity.withCompanyLock).not.toHaveBeenCalled();
    expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
    expect(mockAgents.create).not.toHaveBeenCalled();
    expect(mockConversations.addParticipant).not.toHaveBeenCalled();
  });

  it("blocks bootstrap CoS creation when a Free workspace already has an agent", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_free_caps";
    mockAccess.listUserCompanyAccess.mockResolvedValue([
      { companyId: "company-1", status: "active", principalId: "user-1", membershipRole: "owner" },
    ]);
    mockAccess.listActiveUserMemberships.mockResolvedValue([
      { companyId: "company-1", principalId: "user-1" },
    ]);
    mockCompanies.getById.mockResolvedValue({
      id: "company-1",
      name: "Acme",
      emailDomain: "acme.com",
      planTier: "free",
    });
    mockAgents.list.mockResolvedValue([
      { id: "agent-1", role: "researcher", status: "idle" },
    ]);

    await expect(
      onboardingOrchestrator({ ...(deps as any), tierCapacity: tierCapacityDeps() }).bootstrap("user-1"),
    ).rejects.toBeInstanceOf(OnboardingTierCapacityExceededError);

    expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
    expect(mockAgents.create).not.toHaveBeenCalled();
    expect(mockConversations.addParticipant).not.toHaveBeenCalled();
  });

  it("dry-runs a new company: the CEO founds it with a CoS; a same-domain COO is refused (joins by invite)", async () => {
    const orch = onboardingOrchestrator(deps as any);

    mockUsers.getById.mockResolvedValueOnce({
      id: "ceo-user",
      email: "ceo@mkthink.com",
      name: "Maya CEO",
    });
    mockAccess.listUserCompanyAccess.mockResolvedValueOnce([]);
    mockCompanies.findByEmailDomain.mockResolvedValueOnce(null);
    mockCompanies.create.mockResolvedValueOnce({
      id: "mkthink-company",
      name: "Mkthink",
      emailDomain: "mkthink.com",
    });
    mockCompanies.getById.mockResolvedValue({ id: "mkthink-company", name: "Mkthink", emailDomain: "mkthink.com" });
    mockAgents.list.mockResolvedValueOnce([]);
    mockAgents.create.mockResolvedValueOnce({
      id: "mkthink-cos",
      companyId: "mkthink-company",
      role: "chief_of_staff",
      adapterType: "claude_api",
      adapterConfig: {},
    });
    mockAgents.listKeys.mockResolvedValueOnce([]);
    mockConversations.findByCompany.mockResolvedValueOnce(null);
    mockConversations.create.mockResolvedValueOnce({ id: "mkthink-cos-conv", companyId: "mkthink-company" });

    const ceo = await orch.bootstrap("ceo-user");

    mockUsers.getById.mockResolvedValueOnce({
      id: "coo-user",
      email: "coo@mkthink.com",
      name: "Owen COO",
    });
    mockAccess.listUserCompanyAccess.mockResolvedValueOnce([]);
    mockCompanies.findByEmailDomain.mockResolvedValueOnce({
      id: "mkthink-company",
      name: "Mkthink",
      emailDomain: "mkthink.com",
    });
    // PR #956 re-review: the COO joins by invite, not by email domain.
    await expect(orch.bootstrap("coo-user")).rejects.toMatchObject({ status: 409, code: "domain_already_claimed" });

    expect(ceo).toEqual({
      companyId: "mkthink-company",
      cosAgentId: "mkthink-cos",
      conversationId: "mkthink-cos-conv",
    });
    expect(mockCompanies.create).toHaveBeenCalledTimes(1);
    expect(mockAgents.create).toHaveBeenCalledTimes(1);
    expect(mockAgents.createApiKey).toHaveBeenCalledTimes(1);
    expect(mockConversations.create).toHaveBeenCalledTimes(1);
    expect(mockConversations.postMessage).toHaveBeenCalledTimes(1);
    expect(mockConversations.addParticipant).toHaveBeenCalledWith("mkthink-cos-conv", "ceo-user", "owner");
    expect(mockConversations.addParticipant).not.toHaveBeenCalledWith("mkthink-cos-conv", "coo-user", expect.anything());
    expect(mockAccess.ensureMembership).toHaveBeenCalledWith("mkthink-company", "user", "ceo-user", "owner", "active");
    expect(mockAccess.ensureMembership).not.toHaveBeenCalledWith("mkthink-company", "user", "coo-user", expect.anything(), expect.anything());
    expect(mockAccess.setPrincipalPermission).not.toHaveBeenCalledWith("mkthink-company", "user", "coo-user", expect.anything(), expect.anything(), expect.anything());
  });

  it("throws SingleCompanyInstallationError when an active company exists and the override is not active", async () => {
    // Simulate: an active company already exists, and the env-var override is NOT active.
    // The orchestrator should reject the bootstrap attempt.
    mockUsers.getById.mockResolvedValue({ id: "user-new", email: "new@other.com" });
    mockAccess.listUserCompanyAccess.mockResolvedValue([]);
    mockCompanies.hasActiveCompany.mockResolvedValue(true);
    mockCompanies.list.mockResolvedValue([{ id: "existing-company", name: "Existing Workspace" }]);

    await expect(onboardingOrchestrator(deps as any).bootstrap("user-new")).rejects.toThrow(
      "Installation already has a workspace",
    );
    expect(mockCompanies.create).not.toHaveBeenCalled();
  });

  // AgentDash (#725): a hosted box holds exactly one company; the multi-company
  // override does not apply there.
  it("refuses a second company on a hosted box even with AGENTDASH_ALLOW_MULTI_COMPANY", async () => {
    const saved = { kind: process.env.AGENTDASH_DEPLOYMENT_KIND, multi: process.env.AGENTDASH_ALLOW_MULTI_COMPANY };
    process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
    process.env.AGENTDASH_ALLOW_MULTI_COMPANY = "true";
    try {
      mockUsers.getById.mockResolvedValue({ id: "user-new", email: "new@other.com" });
      mockAccess.listUserCompanyAccess.mockResolvedValue([]);
      mockCompanies.hasActiveCompany.mockResolvedValue(true);
      mockCompanies.list.mockResolvedValue([{ id: "existing-company", name: "Existing Workspace" }]);
      await expect(onboardingOrchestrator(deps as any).bootstrap("user-new")).rejects.toThrow(
        "Installation already has a workspace",
      );
      expect(mockCompanies.create).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of [["AGENTDASH_DEPLOYMENT_KIND", saved.kind], ["AGENTDASH_ALLOW_MULTI_COMPANY", saved.multi]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
