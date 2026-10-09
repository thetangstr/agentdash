// AgentDash (per-steward document access, slice 5): the `connector_send`
// contract for a Microsoft proposed copy. One operation exists, `upload_new`;
// anything that could overwrite or delete a document is refused by shape, so an
// approved payload can never do either.
import { describe, expect, it } from "vitest";
import { classifyAction } from "../agent-destructive-classifier.js";
import {
  checkConnectorSendPayload,
  CONNECTOR_SEND_PROVIDERS,
  MICROSOFT_DOCUMENT_WRITE_OPERATIONS,
  proposedCopyFileName,
  proposedCopyFormatFor,
} from "./approval.js";

const ATTACHMENT_ID = "4b8f0c1e-1d2a-4f8e-9a51-2f0f4c3b7a10";

const upload = {
  provider: "microsoft",
  operation: "upload_new",
  target: { path: "Projects/Kickoff" },
  fileName: "Kickoff notes.docx",
  attachmentId: ATTACHMENT_ID,
  summary: "Tightened the agenda and added the two open risks from the call.",
};

function problem(payload: Record<string, unknown>) {
  const check = checkConnectorSendPayload(payload);
  return check.ok ? null : check.problem;
}

describe("connector_send provider microsoft", () => {
  it("is a provider with an executor, and upload_new is its only operation", () => {
    expect(CONNECTOR_SEND_PROVIDERS).toContain("microsoft");
    expect(MICROSOFT_DOCUMENT_WRITE_OPERATIONS).toEqual(["upload_new"]);
  });

  it("accepts the proposed-copy payload, by path or by folder id", () => {
    expect(checkConnectorSendPayload(upload)).toEqual({ ok: true, provider: "microsoft" });
    expect(
      checkConnectorSendPayload({ ...upload, target: { folderId: "01ABCDEF2GHIJ!34", driveId: "b!drive-1" } }),
    ).toEqual({ ok: true, provider: "microsoft" });
    expect(
      checkConnectorSendPayload({ ...upload, sourceItemId: "01SOURCEITEM" }),
    ).toEqual({ ok: true, provider: "microsoft" });
    // The top of the person's own OneDrive is a destination they can name.
    expect(checkConnectorSendPayload({ ...upload, target: { path: "/" } }).ok).toBe(true);
  });

  it("refuses every operation that could overwrite or delete a document", () => {
    for (const operation of ["update", "replace", "delete", "overwrite", "upload", "create", undefined]) {
      const check = checkConnectorSendPayload({ ...upload, operation });
      expect(check.ok, String(operation)).toBe(false);
      if (!check.ok) {
        expect(check.problem).toBe("operation_invalid");
        expect(check.message).toMatch(/upload_new/);
        expect(check.message).toMatch(/never overwrites/i);
      }
    }
  });

  it("requires exactly one destination and never defaults one (D10)", () => {
    expect(problem({ ...upload, target: undefined })).toBe("target_invalid");
    expect(problem({ ...upload, target: {} })).toBe("target_invalid");
    expect(problem({ ...upload, target: { path: "" } })).toBe("target_invalid");
    expect(problem({ ...upload, target: { path: "A", folderId: "01X" } })).toBe("target_invalid");
    expect(problem({ ...upload, target: { driveId: "b!drive-1" } })).toBe("target_invalid");
    expect(problem({ ...upload, target: "Projects/Kickoff" })).toBe("target_invalid");
  });

  it("refuses paths and ids that could walk out of the named folder", () => {
    for (const path of ["../Other", "Projects/../../x", "Projects/./x", "a:b", "Projects\\x", "x".repeat(401)]) {
      expect(problem({ ...upload, target: { path } }), path).toBe("target_invalid");
    }
    for (const folderId of ["01X/children", "01X?$top=1", "01X:", "", "x".repeat(300), ".", "..", "..."]) {
      expect(problem({ ...upload, target: { folderId } }), folderId).toBe("target_invalid");
    }
    expect(problem({ ...upload, target: { folderId: "01X", driveId: "b!x/../y" } })).toBe("target_invalid");
    // Dot-only ids are path segments to a URL parser, not ids: `..` would
    // resolve /me/drive/items/.. to /me/drive/.
    for (const driveId of [".", ".."]) {
      expect(problem({ ...upload, target: { folderId: "01X", driveId } }), driveId).toBe("target_invalid");
    }
    // Dots inside a real id are still fine.
    expect(problem({ ...upload, target: { folderId: "01X.Y" } })).toBeNull();
  });

  it("refuses file names that are not a plain name with a supported extension", () => {
    for (const fileName of [
      "",
      "notes",
      "notes.exe",
      "notes.docm",
      "../notes.docx",
      "Projects/notes.docx",
      "notes:.docx",
      ".docx",
      "~$notes.docx",
      `${"n".repeat(130)}.docx`,
      "notes.docx\u0000",
    ]) {
      expect(problem({ ...upload, fileName }), JSON.stringify(fileName)).toBe("file_name_invalid");
    }
  });

  it("requires an attachment id and a steward-readable summary", () => {
    expect(problem({ ...upload, attachmentId: undefined })).toBe("attachment_id_invalid");
    expect(problem({ ...upload, attachmentId: "not-a-uuid" })).toBe("attachment_id_invalid");
    expect(problem({ ...upload, summary: "" })).toBe("summary_invalid");
    expect(problem({ ...upload, summary: "   " })).toBe("summary_invalid");
    expect(problem({ ...upload, summary: "s".repeat(2001) })).toBe("summary_invalid");
    expect(problem({ ...upload, sourceItemId: "01X/../y" })).toBe("source_item_id_invalid");
  });

  it("still refuses Teams before looking at anything Microsoft-shaped", () => {
    expect(problem({ ...upload, provider: "Microsoft Teams" })).toBe("teams_not_supported");
  });
});

describe("proposed copy naming (D15)", () => {
  it("names the copy '<name> (proposed by <agent>).<ext>'", () => {
    expect(proposedCopyFileName("Kickoff notes.docx", "Agent A")).toBe("Kickoff notes (proposed by Agent A).docx");
    expect(proposedCopyFileName("deck.PPTX", "Agent A")).toBe("deck (proposed by Agent A).pptx");
  });

  it("keeps an agent name from smuggling path or Graph syntax into the name", () => {
    const name = proposedCopyFileName("plan.md", 'Agent/A: "x"?*<>|\\');
    expect(name).toMatch(/^plan \(proposed by Agent A x\)\.md$/);
    expect(proposedCopyFileName("plan.md", "   ")).toBe("plan (proposed by an agent).md");
  });

  it("maps each output format to the attachment types it accepts", () => {
    // D9: python-docx is not on the host, so a Markdown attachment becomes a
    // Word document server-side.
    expect(proposedCopyFormatFor("x.docx")?.accepts).toEqual(
      expect.arrayContaining([
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/markdown",
      ]),
    );
    expect(proposedCopyFormatFor("x.docx")?.convertFrom).toEqual(["text/markdown"]);
    expect(proposedCopyFormatFor("x.pdf")?.accepts).toEqual(["application/pdf"]);
    expect(proposedCopyFormatFor("x.exe")).toBeNull();
  });
});

describe("classifier: a proposed copy", () => {
  it("is not destructive: it creates a new file and touches nothing that exists", () => {
    expect(classifyAction({ kind: "connector", provider: "microsoft", operation: "upload_new" })).toEqual({
      class: "new_private_copy",
      destructive: false,
    });
  });

  it("is only that for Microsoft; anywhere else upload_new fails closed", () => {
    expect(classifyAction({ kind: "connector", provider: "hubspot", operation: "upload_new" }).destructive).toBe(true);
    expect(classifyAction({ kind: "connector", provider: "microsoft", operation: "update" }).destructive).toBe(true);
  });
});
