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
    // Sets context for what AgentDash is and why this conversation exists.
    expect(call.body).toMatch(/agentdash/i);
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
    mockAccess.listUserCompanyAccess.mockResolvedValue([{ companyId: "company-1", status: "active", principalId: "user-1" }]);
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

  it("attaches a corp-domain user to an existing same-domain company (team pattern)", async () => {
    // alice@acme.com signs up; an "acme.com" workspace already exists from
    // another teammate. We expect the orchestrator to attach alice to it
    // (no fresh workspace created), since deriveCompanyEmailDomain returns
    // bare "acme.com" for non-free-mail domains and findByEmailDomain wins.
    mockUsers.getById.mockResolvedValue({ id: "user-3", email: "alice@acme.com" });
    mockAccess.listUserCompanyAccess.mockResolvedValue([]);
    mockCompanies.findByEmailDomain.mockResolvedValue({ id: "company-acme", name: "Acme", emailDomain: "acme.com" });
    mockAgents.list.mockResolvedValue([{ id: "agent-cos-acme", role: "chief_of_staff" }]);
    mockConversations.findByCompany.mockResolvedValue({ id: "conv-acme", companyId: "company-acme" });

    const result = await onboardingOrchestrator(deps as any).bootstrap("user-3");
    expect(result.companyId).toBe("company-acme");
    expect(mockCompanies.findByEmailDomain).toHaveBeenCalledWith("acme.com");
    expect(mockCompanies.create).not.toHaveBeenCalled();
  });

  it("blocks a second corp-domain human from joining a Free workspace through bootstrap", async () => {
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
    ).rejects.toBeInstanceOf(OnboardingTierCapacityExceededError);

    expect(tierCapacity.withCompanyLock).toHaveBeenCalledWith("company-acme", expect.any(Function));
    expect(mockAccess.ensureMembership).not.toHaveBeenCalled();
    expect(mockAgents.create).not.toHaveBeenCalled();
    expect(mockConversations.addParticipant).not.toHaveBeenCalled();
  });

  it("blocks bootstrap CoS creation when a Free workspace already has an agent", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_free_caps";
    mockAccess.listUserCompanyAccess.mockResolvedValue([
      { companyId: "company-1", status: "active", principalId: "user-1" },
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

  it("dry-runs a new company with CEO + COO sharing one CoS and one onboarding conversation", async () => {
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
    mockAgents.list.mockResolvedValueOnce([
      {
        id: "mkthink-cos",
        companyId: "mkthink-company",
        role: "chief_of_staff",
        adapterType: "claude_api",
        adapterConfig: {},
      },
    ]);
    mockAgents.listKeys.mockResolvedValueOnce([{ id: "cos-key" }]);
    mockConversations.findByCompany.mockResolvedValueOnce({ id: "mkthink-cos-conv", companyId: "mkthink-company" });

    const coo = await orch.bootstrap("coo-user");

    expect(ceo).toEqual({
      companyId: "mkthink-company",
      cosAgentId: "mkthink-cos",
      conversationId: "mkthink-cos-conv",
    });
    expect(coo).toEqual(ceo);
    expect(mockCompanies.create).toHaveBeenCalledTimes(1);
    expect(mockAgents.create).toHaveBeenCalledTimes(1);
    expect(mockAgents.createApiKey).toHaveBeenCalledTimes(1);
    expect(mockConversations.create).toHaveBeenCalledTimes(1);
    expect(mockConversations.postMessage).toHaveBeenCalledTimes(1);
    expect(mockConversations.addParticipant).toHaveBeenCalledWith("mkthink-cos-conv", "ceo-user", "owner");
    expect(mockConversations.addParticipant).toHaveBeenCalledWith("mkthink-cos-conv", "coo-user", "owner");
    expect(mockAccess.ensureMembership).toHaveBeenCalledWith("mkthink-company", "user", "ceo-user", "owner", "active");
    expect(mockAccess.ensureMembership).toHaveBeenCalledWith("mkthink-company", "user", "coo-user", "owner", "active");
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
});
