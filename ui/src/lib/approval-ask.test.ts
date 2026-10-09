import { describe, expect, it } from "vitest";
import { approvalAsk } from "./approval-ask";

// AgentDash (per-steward document access, D8): a document proposal is not
// "sending something outside the company"; it is a new file in the steward's
// own OneDrive, and the decision card should say so.
describe("approvalAsk", () => {
  it("names a document proposal for what it is", () => {
    expect(
      approvalAsk("connector_send", { provider: "microsoft", operation: "upload_new", fileName: "x.docx" }),
    ).toBe("wants to save a proposed copy of a document in your OneDrive");
  });

  it("keeps the generic sentence for every other connector send", () => {
    expect(approvalAsk("connector_send", { provider: "hubspot", operation: "create" })).toBe(
      "wants to send something outside the company",
    );
    expect(approvalAsk("connector_send", { provider: "microsoft", operation: "delete" })).toBe(
      "wants to send something outside the company",
    );
    expect(approvalAsk("connector_send", null)).toBe("wants to send something outside the company");
  });

  it("answers the other approval types as before, and null for an unknown one", () => {
    expect(approvalAsk("hire_agent", {})).toBe("wants to hire another agent");
    expect(approvalAsk("something_new", {})).toBeNull();
  });
});
