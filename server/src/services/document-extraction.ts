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
// ## Memory is bounded by the input, not by the document's structure
//
// This runs inside the server process, on files anyone who can share a file
// with a steward can write, so a hostile file must not be able to exhaust the
// heap. Three bounds hold that:
//
// - Inflation. OOXML is a zip, and a 25 MB zip can inflate to gigabytes. Each
//   part is inflated as a stream and abandoned past `MAX_PART_INFLATED_BYTES`
//   (16 MB), and the parts together past `MAX_INFLATED_BYTES` (32 MB). A real
//   document.xml or slide is a few MB at most. A zip that lists more than
//   `MAX_ZIP_ENTRIES` parts is refused before it is opened.
// - Parsing. XML is scanned once, tag by tag, and the text is collected as it
//   goes. No element tree is built: an object tree is many times the size of
//   the XML (a 0.6 MB file whose document.xml inflated to 195 MB of tiny
//   paragraphs built a tree past 4 GB and took the process down), so memory
//   here is the part's own string plus the text it yields.
// - Concurrency. At most `MAX_CONCURRENT_EXTRACTIONS` extractions run at once;
//   the rest wait their turn.
//
// A part that declares a DOCTYPE (or any `<!` declaration other than a comment
// or CDATA) is refused: OOXML never carries one, and entity expansion is how
// XML bombs work. Only the five predefined entities and numeric character
// references are decoded.
import JSZip from "jszip";

/** Largest file the read service downloads. Past it the download is aborted. */
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Most characters of extracted text returned in one read; the rest is paged with `offset`. */
export const DOCUMENT_MAX_TEXT_CHARS = 60_000;
/** Most bytes inflated from any one zip part. */
export const MAX_PART_INFLATED_BYTES = 16 * 1024 * 1024;
/** Most bytes inflated from one document's zip parts, all parts together. */
export const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
/** A zip that lists more parts than this is refused before it is opened. */
export const MAX_ZIP_ENTRIES = 20_000;
/** Extractions running at once, process-wide. */
export const MAX_CONCURRENT_EXTRACTIONS = 2;
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

type Budget = { remaining: number };

// -- concurrency ---------------------------------------------------------------

let activeExtractions = 0;
let peakActiveExtractions = 0;
const extractionQueue: Array<() => void> = [];

async function withExtractionSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeExtractions >= MAX_CONCURRENT_EXTRACTIONS) {
    await new Promise<void>((resolve) => extractionQueue.push(resolve));
  } else {
    activeExtractions += 1;
  }
  peakActiveExtractions = Math.max(peakActiveExtractions, activeExtractions);
  try {
    return await work();
  } finally {
    const next = extractionQueue.shift();
    // The slot passes straight to the next waiter, so the count never dips
    // and lets an arrival jump the queue.
    if (next) next();
    else activeExtractions -= 1;
  }
}

/** Test seam: how many extractions have run at once since the last reset. */
export function __extractionConcurrencyStats() {
  return { active: activeExtractions, peak: peakActiveExtractions, waiting: extractionQueue.length };
}

export function __resetExtractionConcurrencyStats() {
  peakActiveExtractions = activeExtractions;
}

// -- zip ---------------------------------------------------------------------

/**
 * The number of entries a zip's end-of-central-directory record declares
 * (zip64 included), read before JSZip builds an object per entry. Null when
 * there is no such record, which JSZip then rejects on its own.
 */
function zipEntryCount(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let at = bytes.byteLength - 22; at >= lowest; at -= 1) {
    if (view.getUint32(at, true) !== 0x06054b50) continue;
    const count = view.getUint16(at + 10, true);
    if (count !== 0xffff) return count;
    // zip64: the locator sits just before the classic record.
    const locator = at - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) return count;
    const record = Number(view.getBigUint64(locator + 8, true));
    if (!Number.isSafeInteger(record) || record < 0 || record + 40 > bytes.byteLength) return Number.MAX_SAFE_INTEGER;
    if (view.getUint32(record, true) !== 0x06064b50) return Number.MAX_SAFE_INTEGER;
    const total = view.getBigUint64(record + 32, true);
    return total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total);
  }
  return null;
}

/**
 * Inflate one zip part as UTF-8, charging it against the part cap and the
 * document's budget. Stops inflating (and fails) as soon as either is spent.
 */
async function readPart(zip: JSZip, path: string, budget: Budget): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;
  const chunks: Uint8Array[] = [];
  let partBytes = 0;
  // `internalStream` is JSZip's documented streaming reader (ZipObject#internalStream);
  // its typings omit it. Pausing it stops inflation, so a bomb never finishes.
  const stream = (file as unknown as { internalStream(type: "uint8array"): JsZipStreamHelper }).internalStream("uint8array");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    stream
      .on("data", (chunk: Uint8Array) => {
        if (settled) return;
        partBytes += chunk.length;
        budget.remaining -= chunk.length;
        if (partBytes > MAX_PART_INFLATED_BYTES || budget.remaining < 0) {
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

// -- XML scanning --------------------------------------------------------------

interface XmlVisitor {
  /** An element opened. `attrs` is the raw attribute source; parse it with `parseAttributes` only when needed. */
  open(name: string, attrs: string): void;
  close(name: string): void;
  /** Character data, entities already decoded. */
  text(value: string): void;
}

const PREDEFINED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,4});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    }
    return PREDEFINED_ENTITIES[body] ?? whole;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    out[m[1]!] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return out;
}

/**
 * One pass over an XML string, in document order, holding nothing but the
 * position. Malformed markup is an error, not a guess.
 */
function scanXml(xml: string, visitor: XmlVisitor): void {
  const length = xml.length;
  let at = 0;
  while (at < length) {
    const lt = xml.indexOf("<", at);
    if (lt < 0) {
      visitor.text(decodeEntities(xml.slice(at)));
      return;
    }
    if (lt > at) visitor.text(decodeEntities(xml.slice(at, lt)));
    const next = xml.charCodeAt(lt + 1);
    if (next === 0x3f /* ? */) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new ExtractionLimitError("document part is not well-formed XML");
      at = end + 2;
      continue;
    }
    if (next === 0x21 /* ! */) {
      if (xml.startsWith("<!--", lt)) {
        const end = xml.indexOf("-->", lt + 4);
        if (end < 0) throw new ExtractionLimitError("document part is not well-formed XML");
        at = end + 3;
        continue;
      }
      if (xml.startsWith("<![CDATA[", lt)) {
        const end = xml.indexOf("]]>", lt + 9);
        if (end < 0) throw new ExtractionLimitError("document part is not well-formed XML");
        visitor.text(xml.slice(lt + 9, end));
        at = end + 3;
        continue;
      }
      throw new ExtractionLimitError("document part declares a DOCTYPE");
    }
    if (next === 0x2f /* / */) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) throw new ExtractionLimitError("document part is not well-formed XML");
      visitor.close(xml.slice(lt + 2, end).trim());
      at = end + 1;
      continue;
    }
    // A start tag. `>` may appear inside a quoted attribute value.
    let end = lt + 1;
    let quote = 0;
    for (; end < length; end += 1) {
      const c = xml.charCodeAt(end);
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === 0x22 || c === 0x27) {
        quote = c;
      } else if (c === 0x3e /* > */) {
        break;
      } else if (c === 0x3c /* < */) {
        throw new ExtractionLimitError("document part is not well-formed XML");
      }
    }
    if (end >= length) throw new ExtractionLimitError("document part is not well-formed XML");
    const selfClosing = xml.charCodeAt(end - 1) === 0x2f;
    const inner = xml.slice(lt + 1, selfClosing ? end - 1 : end);
    const nameEnd = inner.search(/[\s]/);
    const name = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
    if (name.length === 0) throw new ExtractionLimitError("document part is not well-formed XML");
    visitor.open(name, nameEnd < 0 ? "" : inner.slice(nameEnd));
    if (selfClosing) visitor.close(name);
    at = end + 1;
  }
}

// -- text walking ----------------------------------------------------------------

/** The tag names that carry text in one OOXML dialect (WordprocessingML or DrawingML). */
interface TextRules {
  text: string;
  tab: string;
  breaks: ReadonlySet<string>;
  paragraph: string;
  row: string;
  cell: string;
  /** Word: any child of a row is a cell slot (content controls wrap cells); DrawingML: only `cell`. */
  rowChildren: "any" | "cells_only";
  /** Row children that are row properties, not cells. */
  rowSkip: ReadonlySet<string>;
  /** Elements whose whole subtree is not body text. */
  skip: ReadonlySet<string>;
  /** Elements whose text is followed by a line break (paragraphs, tables). */
  block: ReadonlySet<string>;
}

const DOCX_RULES: TextRules = {
  text: "w:t",
  tab: "w:tab",
  breaks: new Set(["w:br", "w:cr"]),
  paragraph: "w:p",
  row: "w:tr",
  cell: "w:tc",
  rowChildren: "any",
  rowSkip: new Set(["w:trPr", "w:tblPrEx"]),
  // Field instructions, deleted text, run and paragraph properties: not body text.
  skip: new Set(["w:instrText", "w:delText", "w:del", "w:rPr", "w:pPr", "w:sectPr"]),
  block: new Set(["w:p", "w:tbl"]),
};

const PPTX_RULES: TextRules = {
  text: "a:t",
  tab: "a:tab",
  breaks: new Set(["a:br"]),
  paragraph: "a:p",
  row: "a:tr",
  cell: "a:tc",
  rowChildren: "cells_only",
  rowSkip: new Set(),
  // Slide-number and date fields are placeholders, not what the author wrote.
  skip: new Set(["a:fld", "a:rPr", "a:pPr"]),
  block: new Set(["a:p"]),
};

type Frame =
  | { kind: "block"; name: string; out: string[] }
  | { kind: "row"; name: string; cells: string[] }
  | { kind: "cell"; name: string; out: string[]; isCell: boolean }
  | { kind: "pass"; name: string };

/**
 * The text of one part, in document order. A stack of open elements that
 * change how text is joined (paragraphs, tables, rows, cells) holds only the
 * text gathered so far; every other element passes its text straight through.
 */
function walkText(xml: string, rules: TextRules, onRoot?: (name: string, attrs: string) => void): string {
  const root: string[] = [];
  const stack: Frame[] = [];
  let skipName: string | null = null;
  let skipDepth = 0;
  let inText = 0;
  let sawRoot = false;

  const sink = (): string[] => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const frame = stack[i]!;
      if (frame.kind === "block" || frame.kind === "cell") return frame.out;
      if (frame.kind === "row") return [];
    }
    return root;
  };
  const enterSkip = (name: string) => {
    skipName = name;
    skipDepth = 1;
  };

  scanXml(xml, {
    open(name, attrs) {
      if (!sawRoot) {
        sawRoot = true;
        onRoot?.(name, attrs);
      }
      if (skipName !== null) {
        if (name === skipName) skipDepth += 1;
        return;
      }
      const parent = stack[stack.length - 1];
      if (parent?.kind === "row") {
        if (rules.rowSkip.has(name) || (rules.rowChildren === "cells_only" && name !== rules.cell)) {
          enterSkip(name);
          return;
        }
        stack.push({ kind: "cell", name, out: [], isCell: name === rules.cell });
        return;
      }
      if (rules.skip.has(name)) {
        enterSkip(name);
        return;
      }
      if (name === rules.text) {
        inText += 1;
        stack.push({ kind: "pass", name });
        return;
      }
      if (name === rules.tab || rules.breaks.has(name)) {
        sink().push(name === rules.tab ? "\t" : "\n");
        // Whatever such an element contains is not text.
        enterSkip(name);
        return;
      }
      if (name === rules.row) {
        stack.push({ kind: "row", name, cells: [] });
        return;
      }
      if (rules.block.has(name)) {
        stack.push({ kind: "block", name, out: [] });
        return;
      }
      stack.push({ kind: "pass", name });
    },
    close(name) {
      if (skipName !== null) {
        if (name === skipName) {
          skipDepth -= 1;
          if (skipDepth === 0) skipName = null;
        }
        return;
      }
      const frame = stack.pop();
      if (!frame || frame.name !== name) throw new ExtractionLimitError("document part is not well-formed XML");
      if (frame.kind === "pass") {
        if (name === rules.text) inText -= 1;
        return;
      }
      if (frame.kind === "block") {
        sink().push(`${frame.out.join("")}\n`);
        return;
      }
      if (frame.kind === "cell") {
        const cell = frame.out.join("").replace(/\s*\n\s*/g, " ").trim();
        const row = stack[stack.length - 1];
        if (row?.kind === "row" && (frame.isCell || cell.length > 0)) row.cells.push(cell);
        return;
      }
      sink().push(`${frame.cells.join(" | ")}\n`);
    },
    text(value) {
      if (skipName === null && inText > 0) sink().push(value);
    },
  });
  if (stack.length > 0 || skipName !== null) throw new ExtractionLimitError("document part is not well-formed XML");
  return root.join("");
}

/** Every element with this name, as attribute maps, in document order. */
function elementsNamed(xml: string, wanted: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  let depth = 0;
  scanXml(xml, {
    open(name, attrs) {
      depth += 1;
      if (name === wanted) out.push(parseAttributes(attrs));
    },
    close() {
      depth -= 1;
      if (depth < 0) throw new ExtractionLimitError("document part is not well-formed XML");
    },
    text() {},
  });
  return out;
}

// -- docx -------------------------------------------------------------------

async function extractDocx(zip: JSZip, budget: Budget): Promise<string> {
  const xml = await readPart(zip, "word/document.xml", budget);
  if (xml === null) throw new ExtractionLimitError("not a Word document (word/document.xml is missing)");
  return walkText(xml, DOCX_RULES);
}

// -- pptx -------------------------------------------------------------------

/** Relationship id -> target, from one `.rels` part. */
function parseRels(xml: string | null): Array<{ id: string; type: string; target: string }> {
  if (!xml) return [];
  return elementsNamed(xml, "Relationship")
    .filter((attrs) => attrs.Id && attrs.Target)
    .map((attrs) => ({ id: attrs.Id!, type: attrs.Type ?? "", target: attrs.Target! }));
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
async function slideOrder(zip: JSZip, budget: Budget): Promise<string[]> {
  const presentation = await readPart(zip, "ppt/presentation.xml", budget);
  if (presentation === null) throw new ExtractionLimitError("not a PowerPoint deck (ppt/presentation.xml is missing)");
  const rels = parseRels(await readPart(zip, "ppt/_rels/presentation.xml.rels", budget));
  const byId = new Map(rels.map((rel) => [rel.id, rel.target]));
  const ordered = elementsNamed(presentation, "p:sldId")
    .map((attrs) => attrs["r:id"])
    .filter((rid): rid is string => typeof rid === "string" && rid.length > 0)
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

async function extractPptx(zip: JSZip, budget: Budget): Promise<{ text: string; slideCount: number }> {
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
    let hidden = false;
    const body = tidy(
      walkText(xml, PPTX_RULES, (name, attrs) => {
        if (name === "p:sld") hidden = parseAttributes(attrs).show === "0";
      }),
    );
    let block = `--- Slide ${number}${hidden ? " (hidden)" : ""} ---\n${body || "(no text on this slide)"}`;

    const dir = path.slice(0, path.lastIndexOf("/"));
    const file = path.slice(path.lastIndexOf("/") + 1);
    const notesRel = parseRels(await readPart(zip, `${dir}/_rels/${file}.rels`, budget)).find((rel) =>
      rel.type.endsWith("/notesSlide"),
    );
    if (notesRel) {
      const notesXml = await readPart(zip, resolvePartPath(dir, notesRel.target), budget);
      const notes = notesXml ? tidy(walkText(notesXml, PPTX_RULES)) : "";
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
  return withExtractionSlot(async (): Promise<DocumentExtraction> => {
    try {
      const entries = zipEntryCount(bytes);
      if (entries !== null && entries > MAX_ZIP_ENTRIES) {
        throw new ExtractionLimitError(`the file holds more than ${MAX_ZIP_ENTRIES} parts`);
      }
      const zip = await JSZip.loadAsync(bytes);
      const budget: Budget = { remaining: MAX_INFLATED_BYTES };
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
  });
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
