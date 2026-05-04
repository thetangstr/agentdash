import { describe, it, expect, beforeEach, vi } from "vitest";
import { onboardingOrchestrator } from "../services/onboarding-orchestrator.js";
import { FIXED_QUESTIONS } from "@paperclipai/shared";

const mockAccess = { ensureMembership: vi.fn(), setPrincipalPermission: vi.fn(), listUserCompanyAccess: vi.fn() };
const mockCompanies = { create: vi.fn(), getById: vi.fn() };
const mockAgents = { create: vi.fn(), createApiKey: vi.fn(), list: vi.fn(), listKeys: vi.fn() };
const mockInstructions = { materializeManagedBundle: vi.fn() };
const mockConversations = { findByCompany: vi.fn(), create: vi.fn(), addParticipant: vi.fn(), postMessage: vi.fn() };
const mockUsers = { getById: vi.fn() };

const deps = { access: mockAccess, companies: mockCompanies, agents: mockAgents, instructions: mockInstructions, conversations: mockConversations, users: mockUsers };

describe("onboardingOrchestrator.bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsers.getById.mockResolvedValue({ id: "user-1", email: "alice@acme.com" });
    mockAccess.listUserCompanyAccess.mockResolvedValue([]);
    mockCompanies.create.mockResolvedValue({ id: "company-1", name: "Acme", emailDomain: "acme.com" });
    mockCompanies.getById.mockResolvedValue({ id: "company-1", name: "Acme", emailDomain: "acme.com" });
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

  it("posts a 4-message welcome sequence (3 plain + 1 interview card) when the conversation is fresh", async () => {
    await onboardingOrchestrator(deps as any).bootstrap("user-1");
    expect(mockConversations.postMessage).toHaveBeenCalledTimes(4);
    const calls = mockConversations.postMessage.mock.calls.map((c) => c[0]);
    // First three: plain agent bubbles authored by the CoS, no card.
    for (let i = 0; i < 3; i++) {
      expect(calls[i]).toMatchObject({
        conversationId: "conv-1",
        authorKind: "agent",
        authorId: "agent-cos-1",
      });
      expect(calls[i].cardKind).toBeUndefined();
      expect(typeof calls[i].body).toBe("string");
      expect(calls[i].body.length).toBeGreaterThan(0);
    }
    // Fourth: the first fixed interview question, rendered as an interview card.
    expect(calls[3]).toMatchObject({
      conversationId: "conv-1",
      authorKind: "agent",
      authorId: "agent-cos-1",
      body: FIXED_QUESTIONS[0],
      cardKind: "interview_question_v1",
      cardPayload: { question: FIXED_QUESTIONS[0], fixedIndex: 0 },
    });
  });

  it("is idempotent — second call returns existing artifacts (user-membership check, NOT domain lookup) and posts NO welcome messages", async () => {
    await onboardingOrchestrator(deps as any).bootstrap("user-1");
    vi.clearAllMocks();
    mockUsers.getById.mockResolvedValue({ id: "user-1", email: "alice@acme.com" });
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

  it("creates a fresh isolated workspace even when another user with the same domain exists", async () => {
    // gmail.com user-2 signs up; user-1 (also gmail.com) already has a company.
    // The orchestrator must NOT attach user-2 to user-1's company.
    mockUsers.getById.mockResolvedValue({ id: "user-2", email: "bob@gmail.com" });
    mockAccess.listUserCompanyAccess.mockResolvedValue([]); // user-2 has NO memberships yet
    mockCompanies.create.mockResolvedValue({ id: "company-2", name: "Gmail", emailDomain: "gmail.com" });
    mockAgents.create.mockResolvedValue({ id: "agent-cos-2", companyId: "company-2", role: "chief_of_staff", adapterType: "claude_api", adapterConfig: {} });
    mockConversations.create.mockResolvedValue({ id: "conv-2", companyId: "company-2" });

    const result = await onboardingOrchestrator(deps as any).bootstrap("user-2");
    expect(result.companyId).toBe("company-2");
    // A brand-new company was created — not looked up by domain.
    expect(mockCompanies.create).toHaveBeenCalledWith(expect.objectContaining({ emailDomain: "gmail.com" }));
  });
});
