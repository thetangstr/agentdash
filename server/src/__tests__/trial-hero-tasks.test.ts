// AgentDash (Test Drive): unit tests for the sales-outreach hero task —
// prompt builder + robust artifact parser (no DB, no network).

import { describe, expect, it } from "vitest";
import {
  buildSalesOutreachPrompt,
  parseSalesOutreachArtifact,
  salesOutreachTask,
  getHeroTask,
  type SalesOutreachContent,
} from "../services/trial-hero-tasks.ts";

describe("buildSalesOutreachPrompt", () => {
  it("includes the ICP in the user message", () => {
    const prompt = buildSalesOutreachPrompt({ icp: "VPs of Ops at logistics SaaS" });
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    expect(prompt.messages[0].content).toContain("VPs of Ops at logistics SaaS");
    expect(prompt.system).toContain("3-touch");
  });

  it("includes sender context when provided", () => {
    const prompt = buildSalesOutreachPrompt({
      icp: "RevOps leaders",
      senderContext: "we sell a routing optimizer",
    });
    expect(prompt.messages[0].content).toContain("we sell a routing optimizer");
  });

  it("omits the sender-context line when not provided", () => {
    const prompt = buildSalesOutreachPrompt({ icp: "RevOps leaders" });
    expect(prompt.messages[0].content).not.toContain("Sender / product context");
  });
});

describe("parseSalesOutreachArtifact", () => {
  const input = { icp: "VPs of Ops at logistics SaaS" };

  const validPayload = {
    summary: "Lead with the cost of manual dispatch.",
    touches: [
      { day: 1, channel: "email", subject: "quick idea for [Company]", body: "Hi [First Name], ..." },
      { day: 3, channel: "email", subject: "following up", body: "Wanted to share a number ..." },
      { day: 7, channel: "linkedin", body: "Closing the loop — happy to step back." },
    ],
    tips: ["Personalize line one.", "Keep it under 120 words."],
  };

  it("parses a bare JSON object", () => {
    const raw = JSON.stringify(validPayload);
    const { title, content } = parseSalesOutreachArtifact(raw, input);
    const c = content as unknown as SalesOutreachContent;
    expect(title).toContain("3-touch outreach sequence");
    expect(c.touches).toHaveLength(3);
    expect(c.summary).toBe(validPayload.summary);
    expect(c.tips).toHaveLength(2);
    expect(c.touches[2].subject).toBeUndefined();
  });

  it("parses JSON inside a ```json code fence", () => {
    const raw = "```json\n" + JSON.stringify(validPayload) + "\n```";
    const c = parseSalesOutreachArtifact(raw, input).content as unknown as SalesOutreachContent;
    expect(c.touches).toHaveLength(3);
  });

  it("parses JSON embedded in surrounding prose", () => {
    const raw =
      "Sure! Here is your sequence:\n\n" +
      JSON.stringify(validPayload) +
      "\n\nLet me know if you'd like tweaks.";
    const c = parseSalesOutreachArtifact(raw, input).content as unknown as SalesOutreachContent;
    expect(c.touches).toHaveLength(3);
    expect(c.touches[0].body).toContain("Hi [First Name]");
  });

  it("falls back to a usable structure when no JSON is present", () => {
    const raw = "I could not produce JSON but here is some plain text outreach.";
    const { content } = parseSalesOutreachArtifact(raw, input);
    const c = content as unknown as SalesOutreachContent;
    expect(c.touches.length).toBeGreaterThanOrEqual(1);
    expect(c.touches[0].body).toContain("plain text outreach");
    expect(c.tips.length).toBeGreaterThan(0);
  });

  it("falls back when touches array is empty", () => {
    const raw = JSON.stringify({ summary: "x", touches: [], tips: [] });
    const c = parseSalesOutreachArtifact(raw, input).content as unknown as SalesOutreachContent;
    expect(c.touches.length).toBeGreaterThanOrEqual(1);
  });
});

describe("salesOutreachTask.validateInput", () => {
  it("throws a 400 when icp is missing", () => {
    expect(() => salesOutreachTask.validateInput({})).toThrowError(/icp/i);
    try {
      salesOutreachTask.validateInput({});
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
    }
  });

  it("normalizes and bounds the icp", () => {
    const out = salesOutreachTask.validateInput({ icp: "  RevOps  " });
    expect(out.icp).toBe("RevOps");
  });
});

describe("getHeroTask", () => {
  it("resolves sales_outreach", () => {
    expect(getHeroTask("sales_outreach")?.useCase).toBe("sales_outreach");
  });
  it("returns null for unknown use cases", () => {
    expect(getHeroTask("nope")).toBeNull();
  });
});
