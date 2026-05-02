import { describe, it, expect, beforeEach, vi } from "vitest";
import { onboardingOrchestrator } from "../services/onboarding-orchestrator.js";

const mockAccess = { ensureMembership: vi.fn(), setPrincipalPermission: vi.fn() };
const mockCompanies = { create: vi.fn(), findByEmailDomain: vi.fn() };
const mockAgents = { create: vi.fn(), createApiKey: vi.fn(), list: vi.fn(), listKeys: vi.fn() };
const mockInstructions = { materializeManagedBundle: vi.fn() };
const mockConversations = { findByCompany: vi.fn(), create: vi.fn(), addParticipant: vi.fn() };
const mockUsers = { getById: vi.fn() };

const deps = { access: mockAccess, companies: mockCompanies, agents: mockAgents, instructions: mockInstructions, conversations: mockConversations, users: mockUsers };

describe("onboardingOrchestrator.bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsers.getById.mockResolvedValue({ id: "user-1", email: "alice@acme.com" });
    mockCompanies.findByEmailDomain.mockResolvedValue(null);
    mockCompanies.create.mockResolvedValue({ id: "company-1", name: "Acme", emailDomain: "acme.com" });
    mockAgents.list.mockResolvedValue([]);
    mockAgents.listKeys.mockResolvedValue([]);
    mockAgents.create.mockResolvedValue({ id: "agent-cos-1", companyId: "company-1", role: "chief_of_staff", adapterType: "claude_api", adapterConfig: {} });
    mockAgents.createApiKey.mockResolvedValue({ id: "key-1", token: "agk_test" });
    mockInstructions.materializeManagedBundle.mockResolvedValue({ adapterConfig: { instructionsFilePath: "/tmp/AGENTS.md" } });
    mockConversations.findByCompany.mockResolvedValue(null);
    mockConversations.create.mockResolvedValue({ id: "conv-1", companyId: "company-1" });
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

  it("is idempotent — second call returns existing artifacts", async () => {
    await onboardingOrchestrator(deps as any).bootstrap("user-1");
    vi.clearAllMocks();
    mockUsers.getById.mockResolvedValue({ id: "user-1", email: "alice@acme.com" });
    mockCompanies.findByEmailDomain.mockResolvedValue({ id: "company-1", emailDomain: "acme.com" });
    mockAgents.list.mockResolvedValue([{ id: "agent-cos-1", role: "chief_of_staff", adapterType: "claude_api", adapterConfig: {} }]);
    mockAgents.listKeys.mockResolvedValue([{ id: "key-1" }]);
    mockConversations.findByCompany.mockResolvedValue({ id: "conv-1", companyId: "company-1" });
    mockAccess.setPrincipalPermission.mockResolvedValue(undefined);
    mockAccess.ensureMembership.mockResolvedValue(undefined);
    mockConversations.addParticipant.mockResolvedValue(undefined);

    const result = await onboardingOrchestrator(deps as any).bootstrap("user-1");
    expect(result).toEqual({ companyId: "company-1", cosAgentId: "agent-cos-1", conversationId: "conv-1" });
    expect(mockCompanies.create).not.toHaveBeenCalled();
    expect(mockAgents.create).not.toHaveBeenCalled();
    expect(mockAgents.createApiKey).not.toHaveBeenCalled();
    expect(mockConversations.create).not.toHaveBeenCalled();
  });
});
