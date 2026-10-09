// AgentDash (per-steward document access, slice 3): provider-neutral text
// extraction. Fixtures are built here, part by part, with JSZip, so they do
// not depend on the extractor's own reading of the format.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_TEXT_CHARS,
  classifyDocument,
  extractDocumentText,
  pageDocumentText,
} from "../services/document-extraction.js";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const SLIDE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const NOTES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

const run = (text: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (...runs: string[]) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs.join("")}</w:p>`;
const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="2000"/></w:tcPr>${para(run(text))}</w:tc>`;

export async function buildDocx(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const shape = (...paragraphs: string[]) =>
  `<p:sp><p:txBody>${paragraphs.map((t) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
const slideXml = (body: string, attrs = "") =>
  `<?xml version="1.0"?><p:sld ${P} ${A} ${R}${attrs}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;

/**
 * Three slides whose FILE numbers differ from their presentation order:
 * slide2.xml is shown first, slide1.xml second, slide3.xml third.
 */
export async function buildPptx(slides: Array<{ file: number; body: string; notes?: string; hidden?: boolean }>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const ids = slides.map((s, i) => `<p:sldId id="${256 + i}" r:id="rIdS${s.file}"/>`).join("");
  zip.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation ${P} ${R}><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`);
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?><Relationships ${REL_NS}>${slides
      .map((s) => `<Relationship Id="rIdS${s.file}" Type="${SLIDE_REL}" Target="slides/slide${s.file}.xml"/>`)
      .join("")}</Relationships>`,
  );
  for (const s of slides) {
    zip.file(`ppt/slides/slide${s.file}.xml`, slideXml(s.body, s.hidden ? ' show="0"' : ""));
    if (s.notes) {
      zip.file(
        `ppt/slides/_rels/slide${s.file}.xml.rels`,
        `<?xml version="1.0"?><Relationships ${REL_NS}><Relationship Id="rId9" Type="${NOTES_REL}" Target="../notesSlides/notesSlide${s.file}.xml"/></Relationships>`,
      );
      zip.file(
        `ppt/notesSlides/notesSlide${s.file}.xml`,
        `<?xml version="1.0"?><p:notes ${P} ${A}><p:cSld><p:spTree>${shape(s.notes)}<p:sp><p:txBody><a:p><a:fld type="slidenum"><a:t>99</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      );
    }
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("classifyDocument", () => {
  it("reads Office types by MIME type or extension", () => {
    expect(classifyDocument("Plan.DOCX", null)).toBe("docx");
    expect(classifyDocument("x", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("pptx");
    expect(classifyDocument("Budget.xlsx", "application/octet-stream")).toBe("xlsx");
    expect(classifyDocument("notes.md", null)).toBe("text");
    expect(classifyDocument("scan.pdf", "application/pdf")).toBe("unsupported");
  });
});

describe("docx extraction", () => {
  it("returns paragraphs and table rows in document order, without deleted text", async () => {
    const bytes = await buildDocx(
      [
        para(run("Kickoff agenda")),
        para(run("Scope: "), run("phase one"), "<w:r><w:tab/></w:r>", run("(draft)")),
        `<w:tbl><w:tblPr/><w:tr><w:trPr/>${cell("Item")}${cell("Owner")}</w:tr><w:tr>${cell("Survey")}${cell("Person A")}</w:tr></w:tbl>`,
        `<w:p><w:del w:id="1"><w:r><w:delText>REMOVED-CLAUSE</w:delText></w:r></w:del>${run("Closing &amp; next steps")}</w:p>`,
      ].join(""),
    );
    const result = await extractDocumentText(bytes, "docx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(
      ["Kickoff agenda", "Scope: phase one\t(draft)", "Item | Owner", "Survey | Person A", "", "Closing & next steps"].join("\n"),
    );
    expect(result.text).not.toContain("REMOVED-CLAUSE");
  });

  it("keeps numbers as written (no numeric coercion)", async () => {
    const bytes = await buildDocx(para(run("007")) + para(run("1e3")));
    const result = await extractDocumentText(bytes, "docx");
    expect(result.ok && result.text).toBe("007\n1e3");
  });

  it("refuses a part that declares a DOCTYPE (entity expansion) as unreadable", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY a "aaaaaaaaaa">]><w:document ${W}><w:body>${para(run("&a;"))}</w:body></w:document>`,
    );
    const result = await extractDocumentText(await zip.generateAsync({ type: "nodebuffer" }), "docx");
    expect(result).toMatchObject({ ok: false, reason: "content_unreadable" });
  });

  it("stops inflating a zip bomb and answers content_unreadable", async () => {
    const zip = new JSZip();
    // ~240 MB of one repeated character inflates past the 200 MB budget but
    // compresses to well under the 25 MB download cap.
    const filler = "a".repeat(8 * 1024 * 1024);
    zip.file(
      "word/document.xml",
      `<w:document ${W}><w:body>${Array.from({ length: 30 }, () => filler).join("")}</w:body></w:document>`,
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
    expect(bytes.byteLength).toBeLessThan(DOCUMENT_MAX_BYTES);
    const result = await extractDocumentText(bytes, "docx");
    expect(result).toMatchObject({ ok: false, reason: "content_unreadable" });
    if (!result.ok) expect(result.message).toContain("extraction limit");
  }, 60_000);

  it("answers content_unreadable for bytes that are not a zip", async () => {
    const result = await extractDocumentText(Buffer.from("not a zip"), "docx");
    expect(result).toMatchObject({ ok: false, reason: "content_unreadable" });
  });
});

describe("pptx extraction", () => {
  it("numbers slides in presentation order, with speaker notes and without field placeholders", async () => {
    const bytes = await buildPptx([
      { file: 2, body: shape("Title slide", "Person A") },
      { file: 1, body: shape("Agenda") + `<p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Phase</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Date</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame>` },
      { file: 3, body: shape("Budget overview", "Line one"), notes: "Say the number out loud", hidden: true },
    ]);
    const result = await extractDocumentText(bytes, "pptx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slideCount).toBe(3);
    expect(result.text).toBe(
      [
        "--- Slide 1 ---",
        "Title slide",
        "Person A",
        "",
        "--- Slide 2 ---",
        "Agenda",
        "Phase | Date",
        "",
        "--- Slide 3 (hidden) ---",
        "Budget overview",
        "Line one",
        "Notes:",
        "Say the number out loud",
      ].join("\n"),
    );
    expect(result.text).not.toContain("99");
  });
});

describe("refusals and plain text", () => {
  it("refuses spreadsheets with a pointer, without reading them", async () => {
    const result = await extractDocumentText(Buffer.from("PK"), "xlsx");
    expect(result).toMatchObject({ ok: false, reason: "spreadsheet_not_supported" });
    if (!result.ok) expect(result.message).toMatch(/csv/i);
  });

  it("answers content_unsupported for other types", async () => {
    expect(await extractDocumentText(Buffer.from("%PDF-1.7"), "unsupported")).toMatchObject({
      ok: false,
      reason: "content_unsupported",
    });
  });

  it("decodes plain text as UTF-8 without the byte-order mark", async () => {
    const result = await extractDocumentText(Buffer.from("﻿name,owner\nSurvey,Person A\n", "utf8"), "text");
    expect(result.ok && result.text).toBe("name,owner\nSurvey,Person A\n");
  });
});

describe("pageDocumentText", () => {
  it("pages at the character cap with offsets that join back to the whole", () => {
    const text = "x".repeat(DOCUMENT_MAX_TEXT_CHARS * 2 + 5);
    const first = pageDocumentText(text);
    expect(first).toMatchObject({ offset: 0, nextOffset: DOCUMENT_MAX_TEXT_CHARS, truncated: true, totalChars: text.length });
    const second = pageDocumentText(text, first.nextOffset!);
    const third = pageDocumentText(text, second.nextOffset!);
    expect(third).toMatchObject({ nextOffset: null, truncated: false });
    expect(first.text + second.text + third.text).toBe(text);
  });

  it("never splits a surrogate pair across pages", () => {
    const text = `${"a".repeat(9)}\u{1F600}tail`;
    const page = pageDocumentText(text, 0, 10);
    expect(page.text).toBe("a".repeat(9));
    expect(page.nextOffset).toBe(9);
    expect(pageDocumentText(text, 9, 10).text.startsWith("\u{1F600}")).toBe(true);
  });

  it("clamps an offset past the end to an empty last page", () => {
    expect(pageDocumentText("abc", 50)).toMatchObject({ text: "", offset: 3, nextOffset: null, truncated: false });
  });
});
