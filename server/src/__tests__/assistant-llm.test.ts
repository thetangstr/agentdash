import { describe, it, expect, vi } from "vitest";
import { resolveChiefOfStaffSystemPrompt } from "../services/assistant-llm.js";

// ── Mocks ──────────────────────────────────────────────────────────────

const mockInstructionsBundle = vi.hoisted(() => ({
  soul: "You are the Chief of Staff.",
  agents: "Here are your agents.",
  heartbeat: "Daily heartbeat.",
  tools: "Available tools.",
}));

vi.mock("../services/default-agent-instructions.js", () => ({
  loadDefaultAgentInstructionsBundle: vi.fn().mockResolvedValue(mockInstructionsBundle),
  formatInstructionsBundleAsSystemPrompt: vi.fn().mockReturnValue("SYSTEM PROMPT"),
}));

// ── Tests ─────────────────────────────────────────────────────────────

describe("resolveChiefOfStaffSystemPrompt", () => {
  it("returns null agent and null prompt when no chief_of_staff agent exists", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    } as any;

    const result = await resolveChiefOfStaffSystemPrompt(mockDb, "company-1");
    expect(result.agent).toBeNull();
    expect(result.systemPrompt).toBeNull();
  });

  it("returns agent and system prompt when chief_of_staff exists", async () => {
    const cosRow = { id: "agent-cos", role: "chief_of_staff", name: "CoS", companyId: "company-1" };
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([cosRow]),
    } as any;

    const result = await resolveChiefOfStaffSystemPrompt(mockDb, "company-1");
    expect(result.agent).toMatchObject({ id: "agent-cos", role: "chief_of_staff" });
    expect(result.systemPrompt).toBe("SYSTEM PROMPT");
  });

  it("returns agent with null prompt when instructions bundle fails to load", async () => {
    const { loadDefaultAgentInstructionsBundle } = await import("../services/default-agent-instructions.js");
    vi.mocked(loadDefaultAgentInstructionsBundle).mockRejectedValueOnce(new Error("load failed"));

    const cosRow = { id: "agent-cos", role: "chief_of_staff", name: "CoS", companyId: "company-1" };
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([cosRow]),
    } as any;

    const result = await resolveChiefOfStaffSystemPrompt(mockDb, "company-1");
    expect(result.agent).toMatchObject({ id: "agent-cos" });
    expect(result.systemPrompt).toBeNull();
  });
});
