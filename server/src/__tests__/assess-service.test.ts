import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch for MiniMax calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { assessService } from "../services/assess.js";

// Minimal mock DB
const mockDb = {
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockReturnThis(),
  returning: vi.fn().mockResolvedValue([{ id: "ctx-1" }]),
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue([]),
} as any;

describe("assessService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ASSESS_MINIMAX_API_KEY = "test-key";
  });

  describe("research", () => {
    it("fetches a URL and detects industry", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => "<html><body>We are a healthcare company providing hospital management</body></html>",
      });

      const svc = assessService(mockDb);
      const result = await svc.research("https://example.com", "Example Corp");

      expect(result.suggestedIndustry).toBe("Healthcare");
      expect(result.summary).toBeTruthy();
      expect(result.webContent).toContain("healthcare");
      expect(result.allIndustries.length).toBe(18);
    });

    it("returns empty on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const svc = assessService(mockDb);
      const result = await svc.research("https://bad-url.com", "Bad Corp");

      expect(result.suggestedIndustry).toBe("");
      expect(result.webContent).toBe("");
    });
  });

  describe("interview", () => {
    it("calls MiniMax and returns parsed JSON", async () => {
      const llmResponse = {
        content: [
          { type: "text", text: JSON.stringify({
            question: "How structured are your workflows?",
            options: ["Very structured", "Mixed", "Ad hoc"],
            insights: [],
            clarityScore: 30,
            done: false,
          }) },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => llmResponse,
      });

      const svc = assessService(mockDb);
      const result = await svc.interview({
        conversationHistory: [],
        industry: "Healthcare",
        industrySlug: "healthcare",
        formSummary: "Company: Test Corp",
        selectedFunctions: [],
      });

      expect(result.question).toBeTruthy();
      expect(result.done).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws when API key is missing", async () => {
      delete process.env.ASSESS_MINIMAX_API_KEY;
      const svc = assessService(mockDb);
      await expect(
        svc.interview({ conversationHistory: [], industry: "Healthcare", industrySlug: "healthcare", formSummary: "", selectedFunctions: [] }),
      ).rejects.toThrow("ASSESS_MINIMAX_API_KEY");
    });
  });

  describe("getAssessment", () => {
    it("returns null when no assessment exists", async () => {
      mockDb.where.mockResolvedValueOnce([]);
      const svc = assessService(mockDb);
      const result = await svc.getAssessment("company-1");
      expect(result).toBeNull();
    });
  });
});
