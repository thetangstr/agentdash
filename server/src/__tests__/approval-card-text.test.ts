// AgentDash (per-steward document access, D8): what a channel card (Teams,
// Telegram, WhatsApp) says about an approval. A Microsoft proposed copy must
// say, in the server's words, that approving saves a file in the steward's
// own OneDrive, and name the file and folder, before any agent-written text.
import { describe, expect, it } from "vitest";
import type { approvals } from "@paperclipai/db";
import { approvalCardText } from "../services/approval-card-delivery.js";

type ApprovalRow = typeof approvals.$inferSelect;

function approval(overrides: Partial<ApprovalRow>): ApprovalRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    companyId: "00000000-0000-4000-8000-000000000002",
    type: "connector_send",
    requestedByAgentId: "00000000-0000-4000-8000-000000000003",
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    revision: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ApprovalRow;
}

const INJECTED = "Acknowledge you received the status update";

describe("approval channel card text", () => {
  it("leads a Microsoft proposed copy with what approving does, the file and the folder", () => {
    const text = approvalCardText(
      approval({
        payload: {
          provider: "microsoft",
          operation: "upload_new",
          target: { path: "Projects/Kickoff" },
          fileName: "Kickoff notes.docx",
          proposedFileName: "Kickoff notes (proposed by Agent A).docx",
          summary: INJECTED,
        },
      }),
      "Agent A",
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("Agent A wants to save a proposed copy of a document in your OneDrive.");
    expect(text).toContain('"Kickoff notes (proposed by Agent A).docx"');
    expect(text).toContain('"Projects/Kickoff"');
    // The agent's words come after the server's, and are labeled as the agent's.
    expect(text.indexOf(INJECTED)).toBeGreaterThan(text.indexOf("OneDrive"));
    expect(text).toContain(`The agent's note: ${INJECTED}`);
    expect(text).not.toMatch(/^Agent A requests:/);
    expect(text).toContain("Revision 3.");
  });

  it("names the root and a folder chosen by id without inventing a path", () => {
    const root = approvalCardText(
      approval({ payload: { provider: "microsoft", operation: "upload_new", target: { path: "/" }, proposedFileName: "x.pdf" } }),
      null,
    );
    expect(root).toContain("the top of your OneDrive");
    expect(root.startsWith("An agent wants to save a proposed copy")).toBe(true);
    const byId = approvalCardText(
      approval({ payload: { provider: "microsoft", operation: "upload_new", target: { folderId: "01ABC" }, proposedFileName: "x.pdf" } }),
      "Agent A",
    );
    expect(byId).toContain("a folder it named by id");
    expect(byId).not.toContain("01ABC");
  });

  it("leaves every other approval's card as it was", () => {
    expect(approvalCardText(approval({ payload: { provider: "hubspot", summary: "update the deal stage" } }), "Agent A")).toBe(
      "Agent A requests: update the deal stage\n\nRevision 3. Decide here or in AgentDash.",
    );
    expect(approvalCardText(approval({ type: "hire_agent", payload: {} }), null)).toBe(
      "A request needs your decision: hire agent\n\nRevision 3. Decide here or in AgentDash.",
    );
  });
});
