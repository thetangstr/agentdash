// AgentDash (per-steward document access, slice 3): provider-neutral text
// extraction and paging for documents an agent reads.
//
// Everything here works on bytes already in memory. No provider, no network,
// no disk: the read service downloads (capped at `DOCUMENT_MAX_BYTES`), hands
// the bytes here, and frames what comes back with `frameUntrustedDocumentText`
// (document-content.ts) before any of it reaches an agent.
//
// What is extracted:
// - .docx: body paragraphs and table rows (cells joined with " | "), in
//   document order. Headers, footers, comments and deleted (tracked) text are
//   not included.
// - .pptx: per slide, in presentation order, each headed "--- Slide N ---"
//   (N is the number PowerPoint shows), with that slide's speaker notes after
//   a "Notes:" line, so "slide 3" means the same thing to the agent and to the
//   person who asked.
// - Plain text (.txt, .md, .csv): decoded as UTF-8.
// - .xlsx is refused (`spreadsheet_not_supported`): a sheet flattened to text
//   reads as a wrong cell, so the agent is told how to get the figures instead.
// - Anything else is `content_unsupported`; the caller still returns metadata.
//
// Decompression is bounded: OOXML is a zip, and a 25 MB zip can inflate to
// gigabytes. Each part is inflated as a stream and abandoned once the running
// total passes `MAX_INFLATED_BYTES`; a part that declares a DOCTYPE is refused
// before parsing (OOXML never carries one, and entity expansion is how XML
// bombs work).
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

/** Largest file the read service downloads. Past it the download is aborted. */
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Most characters of extracted text returned in one read; the rest is paged with `offset`. */
export const DOCUMENT_MAX_TEXT_CHARS = 60_000;
/** Most bytes inflated from one document's zip parts, all parts together. */
const MAX_INFLATED_BYTES = 200 * 1024 * 1024;
/** A deck with more slides than this is refused rather than half-read. */
const MAX_SLIDES = 2_000;

export type DocumentKind = "docx" | "pptx" | "xlsx" | "text" | "unsupported";

export type DocumentUnreadableReason =
  | "spreadsheet_not_supported"
  | "content_unsupported"
  | "content_unreadable"
  | "too_large";

export type DocumentExtraction =
  | { ok: true; kind: Exclude<DocumentKind, "xlsx" | "unsupported">; text: string; slideCount: number | null }
  | { ok: false; reason: DocumentUnreadableReason; message: string };

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "text/x-markdown"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv"]);

export const SPREADSHEET_NOT_SUPPORTED_MESSAGE =
  "Spreadsheets are not read as text: a sheet flattened to text puts figures under the wrong headings. " +
  "Ask your steward which table or figures you need, or ask them to export the sheet as .csv, then read that file.";

/** Decide how to read an item from its name and the provider's MIME type. */
export function classifyDocument(name: string | null | undefined, mimeType: string | null | undefined): DocumentKind {
  const mime = (mimeType ?? "").toLowerCase().split(";")[0]!.trim();
  const dot = (name ?? "").lastIndexOf(".");
  const ext = dot >= 0 ? (name ?? "").slice(dot + 1).toLowerCase() : "";
  if (mime === DOCX_MIME || ext === "docx") return "docx";
  if (mime === PPTX_MIME || ext === "pptx") return "pptx";
  if (mime === XLSX_MIME || ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (TEXT_MIMES.has(mime) || TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

export function unreadableFor(kind: "xlsx" | "unsupported"): Extract<DocumentExtraction, { ok: false }> {
  return kind === "xlsx"
    ? { ok: false, reason: "spreadsheet_not_supported", message: SPREADSHEET_NOT_SUPPORTED_MESSAGE }
    : {
        ok: false,
        reason: "content_unsupported",
        message: "Text can be read from .docx, .pptx, .txt, .md and .csv files only; this item's details are returned without its content.",
      };
}

class ExtractionLimitError extends Error {}

interface JsZipStreamHelper {
  on(event: "data", cb: (chunk: Uint8Array) => void): JsZipStreamHelper;
  on(event: "error", cb: (error: Error) => void): JsZipStreamHelper;
  on(event: "end", cb: () => void): JsZipStreamHelper;
  pause(): JsZipStreamHelper;
  resume(): JsZipStreamHelper;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: false,
});

type XmlNode = Record<string, unknown>;

function tagOf(node: XmlNode): string | null {
  for (const key of Object.keys(node)) if (key !== ":@") return key;
  return null;
}

function childrenOf(node: XmlNode, tag: string): XmlNode[] {
  const value = node[tag];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

function attrsOf(node: XmlNode): Record<string, string> {
  const attrs = node[":@"];
  return attrs && typeof attrs === "object" ? (attrs as Record<string, string>) : {};
}

function textContent(children: XmlNode[]): string {
  let out = "";
  for (const child of children) {
    const value = child["#text"];
    if (typeof value === "string") out += value;
  }
  return out;
}

function parseXml(xml: string): XmlNode[] {
  if (/<!DOCTYPE/i.test(xml)) throw new ExtractionLimitError("document part declares a DOCTYPE");
  return parser.parse(xml) as XmlNode[];
}

/**
 * Inflate one zip part as UTF-8, charging it against the document's budget.
 * Stops inflating (and fails) as soon as the budget is spent.
 */
async function readPart(zip: JSZip, path: string, budget: { remaining: number }): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;
  const chunks: Uint8Array[] = [];
  // `internalStream` is JSZip's documented streaming reader (ZipObject#internalStream);
  // its typings omit it. Pausing it stops inflation, so a bomb never finishes.
  const stream = (file as unknown as { internalStream(type: "uint8array"): JsZipStreamHelper }).internalStream("uint8array");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    stream
      .on("data", (chunk: Uint8Array) => {
        if (settled) return;
        budget.remaining -= chunk.length;
        if (budget.remaining < 0) {
          settled = true;
          stream.pause();
          reject(new ExtractionLimitError("document inflates past the extraction limit"));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      })
      .resume();
  });
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

// -- docx -------------------------------------------------------------------

function docxWalk(nodes: XmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag || tag === "#text") continue;
    const children = childrenOf(node, tag);
    switch (tag) {
      case "w:t":
        out += textContent(children);
        break;
      case "w:tab":
        out += "\t";
        break;
      case "w:br":
      case "w:cr":
        out += "\n";
        break;
      case "w:p":
        out += `${docxWalk(children)}\n`;
        break;
      case "w:tr": {
        const cells: string[] = [];
        for (const child of children) {
          const childTag = tagOf(child);
          if (!childTag || childTag === "#text" || childTag === "w:trPr" || childTag === "w:tblPrEx") continue;
          const cell = docxWalk(childrenOf(child, childTag)).replace(/\s*\n\s*/g, " ").trim();
          if (childTag === "w:tc" || cell.length > 0) cells.push(cell);
        }
        out += `${cells.join(" | ")}\n`;
        break;
      }
      case "w:tbl":
        out += `${docxWalk(children)}\n`;
        break;
      // Field instructions, deleted text, drawings' alt XML: not body text.
      case "w:instrText":
      case "w:delText":
      case "w:del":
      case "w:rPr":
      case "w:pPr":
      case "w:sectPr":
        break;
      default:
        out += docxWalk(children);
    }
  }
  return out;
}

async function extractDocx(zip: JSZip, budget: { remaining: number }): Promise<string> {
  const xml = await readPart(zip, "word/document.xml", budget);
  if (xml === null) throw new ExtractionLimitError("not a Word document (word/document.xml is missing)");
  return docxWalk(parseXml(xml));
}

// -- pptx -------------------------------------------------------------------

function pptxWalk(nodes: XmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag || tag === "#text") continue;
    const children = childrenOf(node, tag);
    switch (tag) {
      case "a:t":
        out += textContent(children);
        break;
      case "a:tab":
        out += "\t";
        break;
      case "a:br":
        out += "\n";
        break;
      case "a:p":
        out += `${pptxWalk(children)}\n`;
        break;
      case "a:tr": {
        const cells = children
          .filter((child) => tagOf(child) === "a:tc")
          .map((child) => pptxWalk(childrenOf(child, "a:tc")).replace(/\s*\n\s*/g, " ").trim());
        out += `${cells.join(" | ")}\n`;
        break;
      }
      // Slide-number and date fields: placeholders, not what the author wrote.
      case "a:fld":
      case "a:rPr":
      case "a:pPr":
        break;
      default:
        out += pptxWalk(children);
    }
  }
  return out;
}

/** Relationship id -> target, from one `.rels` part. */
function parseRels(xml: string | null): Array<{ id: string; type: string; target: string }> {
  if (!xml) return [];
  const out: Array<{ id: string; type: string; target: string }> = [];
  const visit = (nodes: XmlNode[]) => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (!tag || tag === "#text") continue;
      if (tag === "Relationship") {
        const attrs = attrsOf(node);
        if (attrs.Id && attrs.Target) out.push({ id: attrs.Id, type: attrs.Type ?? "", target: attrs.Target });
      }
      visit(childrenOf(node, tag));
    }
  };
  visit(parseXml(xml));
  return out;
}

/** Resolve a relationship target against the directory of the part that names it. */
function resolvePartPath(fromDir: string, target: string): string {
  const segments = target.startsWith("/") ? [] : fromDir.split("/").filter(Boolean);
  for (const part of target.replace(/^\/+/, "").split("/")) {
    if (part === "..") segments.pop();
    else if (part !== "." && part !== "") segments.push(part);
  }
  return segments.join("/");
}

/** Slide part paths in presentation order. */
async function slideOrder(zip: JSZip, budget: { remaining: number }): Promise<string[]> {
  const presentation = await readPart(zip, "ppt/presentation.xml", budget);
  if (presentation === null) throw new ExtractionLimitError("not a PowerPoint deck (ppt/presentation.xml is missing)");
  const rels = parseRels(await readPart(zip, "ppt/_rels/presentation.xml.rels", budget));
  const byId = new Map(rels.map((rel) => [rel.id, rel.target]));
  const ids: string[] = [];
  const visit = (nodes: XmlNode[]) => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (!tag || tag === "#text") continue;
      if (tag === "p:sldId") {
        const rid = attrsOf(node)["r:id"];
        if (rid) ids.push(rid);
      }
      visit(childrenOf(node, tag));
    }
  };
  visit(parseXml(presentation));
  const ordered = ids
    .map((rid) => byId.get(rid))
    .filter((target): target is string => typeof target === "string")
    .map((target) => resolvePartPath("ppt", target));
  if (ordered.length > 0) return ordered;
  // No slide list (a damaged or hand-built deck): fall back to file order.
  return Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPptx(zip: JSZip, budget: { remaining: number }): Promise<{ text: string; slideCount: number }> {
  const slides = await slideOrder(zip, budget);
  if (slides.length > MAX_SLIDES) throw new ExtractionLimitError(`deck has more than ${MAX_SLIDES} slides`);
  const blocks: string[] = [];
  for (let index = 0; index < slides.length; index += 1) {
    const path = slides[index]!;
    const xml = await readPart(zip, path, budget);
    const number = index + 1;
    if (xml === null) {
      blocks.push(`--- Slide ${number} ---\n(this slide could not be read)`);
      continue;
    }
    const nodes = parseXml(xml);
    const sld = nodes.find((node) => tagOf(node) === "p:sld");
    const hidden = sld ? attrsOf(sld).show === "0" : false;
    const body = tidy(pptxWalk(nodes));
    let block = `--- Slide ${number}${hidden ? " (hidden)" : ""} ---\n${body || "(no text on this slide)"}`;

    const dir = path.slice(0, path.lastIndexOf("/"));
    const file = path.slice(path.lastIndexOf("/") + 1);
    const notesRel = parseRels(await readPart(zip, `${dir}/_rels/${file}.rels`, budget)).find((rel) =>
      rel.type.endsWith("/notesSlide"),
    );
    if (notesRel) {
      const notesXml = await readPart(zip, resolvePartPath(dir, notesRel.target), budget);
      const notes = notesXml ? tidy(pptxWalk(parseXml(notesXml))) : "";
      if (notes) block += `\nNotes:\n${notes}`;
    }
    blocks.push(block);
  }
  return { text: blocks.join("\n\n"), slideCount: slides.length };
}

// -- entry point ------------------------------------------------------------

/**
 * Extract the text of a document already in memory. Never throws for a bad
 * document: a damaged, oversized or hostile file is `content_unreadable`.
 */
export async function extractDocumentText(bytes: Uint8Array, kind: DocumentKind): Promise<DocumentExtraction> {
  if (kind === "xlsx" || kind === "unsupported") return unreadableFor(kind);
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) {
    return { ok: false, reason: "too_large", message: `Documents larger than ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MB are not read.` };
  }
  if (kind === "text") {
    const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
    return { ok: true, kind, text, slideCount: null };
  }
  try {
    const zip = await JSZip.loadAsync(bytes);
    const budget = { remaining: MAX_INFLATED_BYTES };
    if (kind === "docx") {
      return { ok: true, kind, text: tidy(await extractDocx(zip, budget)), slideCount: null };
    }
    const deck = await extractPptx(zip, budget);
    return { ok: true, kind, text: deck.text, slideCount: deck.slideCount };
  } catch (error) {
    const detail = error instanceof ExtractionLimitError ? `: ${error.message}` : "";
    return {
      ok: false,
      reason: "content_unreadable",
      message: `The file could not be read as a ${kind === "docx" ? "Word document" : "PowerPoint deck"}${detail}.`,
    };
  }
}

export type DocumentTextPage = {
  /** This page of the text (unframed; the caller frames it). */
  text: string;
  offset: number;
  /** Where the next page starts, or null when this page reaches the end. */
  nextOffset: number | null;
  truncated: boolean;
  totalChars: number;
};

/**
 * One page of at most `DOCUMENT_MAX_TEXT_CHARS` characters starting at
 * `offset`. A page never ends between the two halves of a surrogate pair.
 */
export function pageDocumentText(text: string, offset = 0, maxChars = DOCUMENT_MAX_TEXT_CHARS): DocumentTextPage {
  const totalChars = text.length;
  const start = Math.min(Math.max(0, Math.floor(offset)), totalChars);
  let end = Math.min(start + maxChars, totalChars);
  if (end < totalChars && end > start) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  const truncated = end < totalChars;
  return { text: text.slice(start, end), offset: start, nextOffset: truncated ? end : null, truncated, totalChars };
}
