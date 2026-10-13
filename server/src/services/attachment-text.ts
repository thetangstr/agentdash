// AgentDash (co-worker slice 5a): the text of an issue attachment, for agents.
//
// An agent handed a brief as a .docx, a deck as a .pptx or figures as a .csv
// could only download the bytes, which most adapters cannot read. This runs
// the server's document extractor (document-extraction.ts) on the stored file
// and returns one page of its text:
//
// - Paged at `DOCUMENT_MAX_TEXT_CHARS` characters; the caller passes the
//   returned `nextOffset` to read on.
// - Framed with `frameUntrustedDocumentText` (document-content.ts): a
//   plain-language notice that the text is data, never instructions, then the
//   text between nonce-carrying markers. Anyone who can attach a file to the
//   issue (a person, another agent, an outside sender) wrote that text. The
//   frame is bound to the run the read was made for, so the stored copy of
//   that run (log file, run events) withholds the text: the attachment is
//   already stored once, under the issue's visibility, and the run log is not
//   a second copy of it.
// - The file's details (id, name, type, size, sha256) are not framed.
// - What the extractor cannot read comes back as details with its reason:
//   spreadsheets (`spreadsheet_not_supported`, with a pointer to export a
//   .csv), other types including HTML (`content_unsupported`), a file over
//   `DOCUMENT_MAX_BYTES` (`too_large`, refused before the file is read), a
//   damaged or hostile file (`content_unreadable`).
//
// Who may read is decided by the caller (for an agent, the route: company
// access plus the issue's project visibility, the same as downloading the
// file; for the person's own session, the bridge's work scope in
// steward-work.ts, which frames the text its own way); this module trusts
// that decision.
//
// Memory is bounded three ways:
// - At most `MAX_CONCURRENT_ATTACHMENT_READS` files are downloaded and
//   extracted at once, plain text included; the rest wait their turn.
//   Concurrent first reads of the same file share one download.
// - Only the first `ATTACHMENT_MAX_TEXT_CHARS` characters of a file's text are
//   served (`textLimit` says when a file has more), so every extraction fits
//   the cache.
// - Paging a long file reads and parses it once: extracted text is cached per
//   attachment and content hash for ten minutes, bounded by entries and
//   characters. Attachments are immutable (a changed file is a new
//   attachment), so the hash only guards against a reused id.
import type { Readable } from "node:stream";
import type { StorageService } from "../storage/types.js";
import { frameUntrustedDocumentText } from "./document-content.js";
import {
  DOCUMENT_MAX_BYTES,
  classifyDocument,
  extractDocumentText,
  pageDocumentText,
  unreadableFor,
  type DocumentExtraction,
  type DocumentKind,
} from "./document-extraction.js";

/** Frame provider key for issue attachments; labelled in document-content.ts. */
export const ATTACHMENT_FRAME_PROVIDER = "issue_attachment";

export type AttachmentTextUnreadableReason =
  | "spreadsheet_not_supported"
  | "content_unsupported"
  | "content_unreadable"
  | "too_large"
  | "not_enabled";

export type AttachmentForText = {
  id: string;
  companyId: string;
  issueId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
};

export type AttachmentTextResult = {
  attachmentId: string;
  issueId: string;
  filename: string | null;
  contentType: string;
  byteSize: number;
  sha256: string;
  kind: DocumentKind;
  format: "text" | "metadata";
  /** One page of the text, framed as untrusted material; null when there is none. */
  text: string | null;
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
  totalChars: number | null;
  slideCount: number | null;
  unreadable: { reason: AttachmentTextUnreadableReason; message: string } | null;
  /** Set when the file's text is longer than is served: only its first `maxChars` characters are. */
  textLimit: { maxChars: number; fullChars: number; message: string } | null;
};

export const ATTACHMENT_TEXT_NOT_ENABLED_MESSAGE =
  "Reading attachment text is not switched on for this company (coworker_bridge_enabled). " +
  "The file's details are returned without its content.";

const TOO_LARGE_MESSAGE =
  `This file is larger than ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MB, so its text is not read. ` +
  "Ask the person who sent it for the part you need.";

/** Most characters of a file's text that are served (about 33 pages). */
export const ATTACHMENT_MAX_TEXT_CHARS = 2_000_000;

/** Most files downloaded and extracted at once. */
export const MAX_CONCURRENT_ATTACHMENT_READS = 2;

function textLimitMessage(fullChars: number) {
  return (
    `This file's text is ${fullChars.toLocaleString("en-US")} characters long; only the first ` +
    `${ATTACHMENT_MAX_TEXT_CHARS.toLocaleString("en-US")} are served. ` +
    "Ask the person who sent it for the part you need, or for a shorter file."
  );
}

/** What is cached and served: the extraction, its text cut to the served limit. */
type ServedExtraction = { extraction: DocumentExtraction; fullChars: number | null };

// -- cache -------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 32;
// Holds at least four files cut to the served limit.
const CACHE_MAX_CHARS = 4 * ATTACHMENT_MAX_TEXT_CHARS;

type CacheEntry = { at: number; chars: number; result: ServedExtraction };
const cache = new Map<string, CacheEntry>();
let cachedChars = 0;
const inFlight = new Map<string, Promise<ServedExtraction>>();

function cacheKey(attachment: AttachmentForText): string {
  return `${attachment.id}:${attachment.sha256}`;
}

function dropEntry(key: string) {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  cachedChars -= entry.chars;
}

function getCached(key: string): ServedExtraction | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    dropEntry(key);
    return null;
  }
  // Refresh recency: Map iteration order is insertion order.
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

function putCached(key: string, result: ServedExtraction) {
  const chars = result.extraction.ok ? result.extraction.text.length : 0;
  dropEntry(key);
  cache.set(key, { at: Date.now(), chars, result });
  cachedChars += chars;
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES && cachedChars <= CACHE_MAX_CHARS) break;
    dropEntry(oldest);
  }
}

/** Test seam: forget every cached extraction. */
export function __resetAttachmentTextCacheForTests() {
  cache.clear();
  cachedChars = 0;
}

// -- concurrency ---------------------------------------------------------------

let activeReads = 0;
const readQueue: Array<() => void> = [];

async function withReadSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeReads >= MAX_CONCURRENT_ATTACHMENT_READS) {
    await new Promise<void>((resolve) => readQueue.push(resolve));
  } else {
    activeReads += 1;
  }
  try {
    return await work();
  } finally {
    // The slot passes straight to the next waiter.
    const next = readQueue.shift();
    if (next) next();
    else activeReads -= 1;
  }
}

/** Cut text to the served limit, never between the halves of a surrogate pair. */
function capText(extraction: DocumentExtraction): ServedExtraction {
  if (!extraction.ok || extraction.text.length <= ATTACHMENT_MAX_TEXT_CHARS) {
    return { extraction, fullChars: null };
  }
  let end = ATTACHMENT_MAX_TEXT_CHARS;
  const last = extraction.text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return {
    extraction: { ...extraction, text: extraction.text.slice(0, end) },
    fullChars: extraction.text.length,
  };
}

// -- reading -----------------------------------------------------------------

class TooLargeError extends Error {}

/** Read a stored object into memory, aborting once it passes `maxBytes`. */
async function readCapped(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new TooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function attachmentTextService(storage: StorageService) {
  function details(attachment: AttachmentForText, kind: DocumentKind) {
    return {
      attachmentId: attachment.id,
      issueId: attachment.issueId,
      filename: attachment.originalFilename,
      contentType: attachment.contentType,
      byteSize: attachment.byteSize,
      sha256: attachment.sha256,
      kind,
    };
  }

  function metadataOnly(
    attachment: AttachmentForText,
    kind: DocumentKind,
    reason: AttachmentTextUnreadableReason,
    message: string,
  ): AttachmentTextResult {
    return {
      ...details(attachment, kind),
      format: "metadata",
      text: null,
      offset: 0,
      nextOffset: null,
      truncated: false,
      totalChars: null,
      slideCount: null,
      unreadable: { reason, message },
      textLimit: null,
    };
  }

  async function download(attachment: AttachmentForText, kind: DocumentKind): Promise<ServedExtraction> {
    return withReadSlot(async () => {
      const object = await storage.getObject(attachment.companyId, attachment.objectKey);
      try {
        return capText(await extractDocumentText(await readCapped(object.stream, DOCUMENT_MAX_BYTES), kind));
      } catch (error) {
        if (!(error instanceof TooLargeError)) throw error;
        return { extraction: { ok: false, reason: "too_large", message: TOO_LARGE_MESSAGE }, fullChars: null };
      }
    });
  }

  async function extract(attachment: AttachmentForText, kind: DocumentKind): Promise<ServedExtraction> {
    const key = cacheKey(attachment);
    const cached = getCached(key);
    if (cached) return cached;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const work = download(attachment, kind)
      .then((result) => {
        putCached(key, result);
        return result;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, work);
    return work;
  }

  return {
    /** Details only, for a company with the flag off: nothing is read. */
    notEnabled(attachment: AttachmentForText): AttachmentTextResult {
      const kind = classifyDocument(attachment.originalFilename, attachment.contentType);
      return metadataOnly(attachment, kind, "not_enabled", ATTACHMENT_TEXT_NOT_ENABLED_MESSAGE);
    },

    /**
     * One page of the attachment's text from `offset`, framed for `runId`
     * (the requesting run, or a stand-in when there is none) -- or, for a
     * reader that is not an agent run, by the caller's own `frame`: the
     * person's own session reads through the bridge (steward-work.ts), whose
     * material is framed as untrusted agent material, not bound to a run.
     * `pageChars` narrows the page for a caller with a smaller output budget.
     */
    async read(
      attachment: AttachmentForText,
      input: { offset: number; pageChars?: number } & ({ runId: string } | { frame: (pageText: string) => string }),
    ): Promise<AttachmentTextResult> {
      const kind = classifyDocument(attachment.originalFilename, attachment.contentType);
      if (kind === "xlsx" || kind === "unsupported") {
        const refusal = unreadableFor(kind);
        return metadataOnly(attachment, kind, refusal.reason, refusal.message);
      }
      if (attachment.byteSize > DOCUMENT_MAX_BYTES) {
        return metadataOnly(attachment, kind, "too_large", TOO_LARGE_MESSAGE);
      }
      const served = await extract(attachment, kind);
      const extracted = served.extraction;
      if (!extracted.ok) {
        return metadataOnly(
          attachment,
          kind,
          extracted.reason,
          extracted.reason === "too_large" ? TOO_LARGE_MESSAGE : extracted.message,
        );
      }
      const page = pageDocumentText(extracted.text, input.offset, input.pageChars);
      return {
        ...details(attachment, kind),
        format: "text",
        text:
          "frame" in input
            ? input.frame(page.text)
            : frameUntrustedDocumentText(ATTACHMENT_FRAME_PROVIDER, page.text, {
                runId: input.runId,
                docId: attachment.id,
                title: attachment.originalFilename,
              }),
        offset: page.offset,
        nextOffset: page.nextOffset,
        truncated: page.truncated,
        totalChars: page.totalChars,
        slideCount: extracted.slideCount,
        unreadable: null,
        textLimit:
          served.fullChars === null
            ? null
            : { maxChars: ATTACHMENT_MAX_TEXT_CHARS, fullChars: served.fullChars, message: textLimitMessage(served.fullChars) },
      };
    },
  };
}
