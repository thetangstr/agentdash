// AgentDash (per-steward document access, slice 3): an agent reads its
// steward's Microsoft 365 documents (OneDrive and the SharePoint sites the
// steward can open), through the server, as the steward.
//
// ## Who the agent reads as
//
// The connection is resolved ONLY by `connectorService.resolveActingAs` for
// provider "microsoft" (slice 1): the private row of the person who currently
// stewards the agent, or nothing. No request parameter names a connection.
// The access token comes ONLY from `microsoftGraphAuthService
// .tokenForConnection` (slice 2), stays in this module, and never reaches a
// response, a log line or an agent. Graph then answers with exactly what the
// steward can see.
//
// ## Read-only is structural
//
// Every request in this file is a GET: `graphGet` and `fetchDownload` hardcode
// the method and take no request options. There is no write verb anywhere in
// this source, and a test scans it to keep it that way. Writes (slice 5) live
// in their own file, which this one never imports.
//
// Search uses the drive search functions, not the Microsoft Search API (which
// is called with a request body) and not the shared-with-me listing (deprecated
// by Microsoft). `/me/drive/search(q=)` covers the steward's own drive plus
// items shared with them; `/me/drive/root/search(q=)` only their own drive.
//
// ## What an agent gets back
//
// Names, descriptions and document text are written by whoever can edit the
// file, possibly outside the organization, so each is framed with
// `frameUntrustedDocumentText` under the requesting run's id (slice 6b strips
// framed text from every stored copy of that run). Ids, sizes, URLs and
// timestamps are not framed. Text arrives in pages of at most
// `DOCUMENT_MAX_TEXT_CHARS` characters with `nextOffset`.
//
// ## Limits
//
// - Downloads stop at `DOCUMENT_MAX_BYTES` (25 MB): refused from the item's
//   metadata before any download, and the stream is aborted if the content
//   runs past the cap anyway.
// - A per-connection call budget (120 calls a minute, in process).
// - Extracted text is kept in process for a few minutes, keyed by the
//   connection, the item and its eTag, so paging a long document downloads
//   and parses it once. The item's metadata is still fetched on every read, so
//   a steward who loses access stops the reads at once. An unreadable result
//   is kept too, so retrying a hostile file does not parse it again.
// - A download redirect is followed over https only (http only when Graph
//   itself is configured as http, which only a local test double is): the
//   pre-authenticated URL is a credential.
// - A 401 from Graph marks the connection `error` (the steward must reconnect)
//   and records a `connection.microsoft_read_failed` activity row, which the
//   steward's My Agent panel shows as the last error. A short in-process
//   breaker stops presenting a token Graph has refused repeatedly.
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connections, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { agentStewardshipService } from "./agent-stewardships.js";
import { connectorService } from "./connectors.js";
import { frameUntrustedDocumentText, newDocumentFrameNonce } from "./document-content.js";
import {
  DOCUMENT_MAX_BYTES,
  type DocumentExtraction,
  classifyDocument,
  extractDocumentText,
  pageDocumentText,
  unreadableFor,
  type DocumentKind,
  type DocumentUnreadableReason,
} from "./document-extraction.js";
import {
  MicrosoftGraphAuthError,
  microsoftGraphAuthService,
  microsoftGraphBaseUrl,
} from "./microsoft-graph-auth.js";
import { elapsedMsBetween, workflowEventsService } from "./workflow-events.js";

export const MICROSOFT_DOCUMENTS_PROVIDER = "microsoft";

/** Per-connection call ceiling over a sliding minute. A ceiling, not an accountant. */
const RATE_LIMIT_PER_MINUTE = 120;
const RATE_WINDOW_MS = 60_000;
/** Consecutive 401s for one access token before it is no longer presented. */
const AUTH_FAILURE_THRESHOLD = 3;
const GRAPH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export const DOCUMENT_SEARCH_MAX_RESULTS = 25;
export const DOCUMENT_SEARCH_DEFAULT_RESULTS = 10;
export const DOCUMENT_LIST_MAX_RESULTS = 100;
export const DOCUMENT_LIST_DEFAULT_RESULTS = 50;
export const DOCUMENT_QUERY_MAX_CHARS = 200;
/** scope "shared": drive search ranks the steward's own files first, so pages are read until enough shared ones turn up. */
const SHARED_SEARCH_PAGE_SIZE = 200;
const SHARED_SEARCH_MAX_PAGES = 5;

/** Extracted text kept between page requests: per connection, item and eTag. */
const EXTRACTION_CACHE_TTL_MS = 10 * 60_000;
const EXTRACTION_CACHE_MAX_ENTRIES = 64;
/** Characters held across all entries (a 25 MB text file is about 25 million). */
const EXTRACTION_CACHE_MAX_CHARS = 32 * 1024 * 1024;

export const DOCUMENT_SEARCH_SCOPES = ["all", "my_drive", "shared", "sites"] as const;
export type DocumentSearchScope = (typeof DOCUMENT_SEARCH_SCOPES)[number];

const ITEM_SELECT = "id,eTag,name,size,file,folder,webUrl,lastModifiedDateTime,parentReference,remoteItem,description";

export type DocumentReadFailureReason =
  | "provider_not_allowed"
  | "data_scope_not_allowed"
  | "autonomy_blocked"
  | "no_connection"
  | "not_authorized"
  | "reconnect_required"
  | "not_configured"
  | "rate_limited"
  | "provider_unreachable"
  | "provider_error"
  | "not_found"
  | "access_denied"
  | "invalid_reference"
  | "is_folder"
  | "run_mismatch"
  | "run_id_required";

export type DocumentReadFailure = { ok: false; reason: DocumentReadFailureReason; message: string };

/** HTTP status for each refusal. A refusal is an answer, not a fault to retry. */
export function documentFailureStatus(reason: DocumentReadFailureReason): number {
  switch (reason) {
    case "invalid_reference":
    case "is_folder":
    case "run_id_required":
      return 400;
    case "not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "provider_unreachable":
    case "provider_error":
      return 502;
    case "not_configured":
      return 503;
    default:
      return 403;
  }
}

/** A file or folder as an agent sees it. `name`/`description` are framed. */
export interface DocumentItemView {
  /** Pass back to documents_read or documents_list (as folderRef). */
  itemRef: string;
  kind: "file" | "folder";
  name: string;
  description?: string;
  mimeType: string | null;
  size: number | null;
  webUrl: string | null;
  lastModified: string | null;
  /** Shared with the steward from someone else's drive. */
  shared: boolean;
  /** How documents_read treats it: text, spreadsheet (refused), or unsupported. Null for folders. */
  readAs: "text" | "spreadsheet" | "unsupported" | null;
}

export interface DocumentSiteView {
  kind: "site";
  /** Pass as siteId to documents_search (scope "sites") or documents_list. */
  siteId: string;
  name: string;
  description?: string;
  webUrl: string | null;
}

export interface DocumentRunContext {
  pipelineId: string;
  runId: string;
  stepKey: string;
}

// -- in-process limiter -----------------------------------------------------

const rateBuckets = new Map<string, number[]>();
const authFailures = new Map<string, number>();

type CachedExtraction = { at: number; chars: number; byteCount: number; result: DocumentExtraction };
/** Insertion order is recency: a hit is re-inserted, eviction takes the first key. */
const extractionCache = new Map<string, CachedExtraction>();
let extractionCacheChars = 0;

/** Test seam, named like `__resetSharepointLimiterState`. */
export function __resetMicrosoftDocumentsLimiterState() {
  rateBuckets.clear();
  authFailures.clear();
  extractionCache.clear();
  extractionCacheChars = 0;
}

function dropCached(key: string) {
  const entry = extractionCache.get(key);
  if (!entry) return;
  extractionCache.delete(key);
  extractionCacheChars -= entry.chars;
}

function getCached(key: string): CachedExtraction | null {
  const entry = extractionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > EXTRACTION_CACHE_TTL_MS) {
    dropCached(key);
    return null;
  }
  extractionCache.delete(key);
  extractionCache.set(key, entry);
  return entry;
}

function putCached(key: string, byteCount: number, result: DocumentExtraction) {
  const chars = result.ok ? result.text.length : result.message.length;
  if (chars > EXTRACTION_CACHE_MAX_CHARS) return;
  dropCached(key);
  extractionCache.set(key, { at: Date.now(), chars, byteCount, result });
  extractionCacheChars += chars;
  const now = Date.now();
  for (const [oldKey, entry] of extractionCache) {
    const over = extractionCache.size > EXTRACTION_CACHE_MAX_ENTRIES || extractionCacheChars > EXTRACTION_CACHE_MAX_CHARS;
    if (!over && now - entry.at <= EXTRACTION_CACHE_TTL_MS) break;
    dropCached(oldKey);
  }
}

/**
 * Which version of an item's content this is. Null when Graph gives nothing
 * to tell versions apart; such an item is never cached.
 */
function extractionCacheKey(connectionId: string, ref: ItemRef, body: Record<string, unknown>): string | null {
  const eTag = typeof body.eTag === "string" ? body.eTag : "";
  const modified = typeof body.lastModifiedDateTime === "string" ? body.lastModifiedDateTime : "";
  if (!eTag && !modified) return null;
  const size = typeof body.size === "number" ? body.size : null;
  return JSON.stringify([connectionId, ref.driveId ?? "", ref.itemId, eTag, modified, size]);
}

/**
 * The URL Graph's `/content` redirect may send the server to. The
 * pre-authenticated download URL carries its own credential in the query, so
 * it is fetched over https only; plain http is allowed only when Graph itself
 * is configured as http (a local test double, never Microsoft).
 */
export function allowedDownloadLocation(location: string | null, graphBaseUrl: string): URL | null {
  if (!location) return null;
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return null;
  }
  if (target.protocol === "https:") return target;
  if (target.protocol === "http:" && graphBaseUrl.toLowerCase().startsWith("http:")) return target;
  return null;
}

function consumeRateBudget(connectionId: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(connectionId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_PER_MINUTE) {
    rateBuckets.set(connectionId, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(connectionId, hits);
  return true;
}

/** Breaker key: the connection AND the token, so a refresh or reconnect starts clean. */
function tokenKey(connectionId: string, accessToken: string): string {
  return `${connectionId}:${createHash("sha256").update(accessToken).digest("hex").slice(0, 16)}`;
}

// -- references -------------------------------------------------------------

const REF_PART_RE = /^[A-Za-z0-9!_.\-]{1,400}$/;
const SITE_ID_RE = /^[A-Za-z0-9.,_\-]{1,400}$/;
/** "." and ".." are dot segments: a URL parser collapses them into a different path. */
const DOTS_ONLY_RE = /^\.+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRefPart(value: string): boolean {
  return REF_PART_RE.test(value) && !DOTS_ONLY_RE.test(value);
}

function isSiteId(value: unknown): value is string {
  return typeof value === "string" && SITE_ID_RE.test(value) && !DOTS_ONLY_RE.test(value);
}

type ItemRef = { driveId: string | null; itemId: string };

/** `<driveId>:<itemId>`, or a bare `<itemId>` in the steward's own drive. */
export function parseItemRef(value: unknown): ItemRef | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return isRefPart(trimmed) ? { driveId: null, itemId: trimmed } : null;
  const driveId = trimmed.slice(0, colon);
  const itemId = trimmed.slice(colon + 1);
  return isRefPart(driveId) && isRefPart(itemId) ? { driveId, itemId } : null;
}

function formatItemRef(driveId: unknown, itemId: unknown): string | null {
  if (typeof itemId !== "string" || !isRefPart(itemId)) return null;
  return typeof driveId === "string" && isRefPart(driveId) ? `${driveId}:${itemId}` : itemId;
}

function itemPath(ref: ItemRef): string {
  return ref.driveId
    ? `/drives/${encodeURIComponent(ref.driveId)}/items/${encodeURIComponent(ref.itemId)}`
    : `/me/drive/items/${encodeURIComponent(ref.itemId)}`;
}

/** A folder path in a drive, as Graph's `root:/{path}:` addressing wants it. */
function drivePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const segments = value.split("/").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0 || segments.length > 64) return null;
  if (segments.some((s) => s === "." || s === ".." || s.length > 255 || /[\u0000-\u001f]/.test(s))) return null;
  return segments.map(encodeURIComponent).join("/");
}

/** OData string literal inside a function call: quotes doubled, then URL-encoded. */
function searchLiteral(query: string): string {
  return encodeURIComponent(query.replace(/'/g, "''"));
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

// -- service ----------------------------------------------------------------

type Authorized = {
  ok: true;
  connectionId: string;
  accessToken: string;
  accountLabel: string | null;
  grantedScopes: string[];
};

type Framer = { frame: (text: string, docId: string, title: string | null) => string };

export function microsoftDocumentsService(db: Db) {
  const connectors = connectorService(db);
  const auth = microsoftGraphAuthService(db);
  const stewardships = agentStewardshipService(db);
  const workflow = workflowEventsService(db);

  /**
   * The ONLY way this file calls Graph's JSON API. GET is hardcoded and there
   * is no options parameter, so a write would have to be a visible new helper.
   */
  async function graphGet(path: string, accessToken: string): Promise<Response> {
    return fetch(`${microsoftGraphBaseUrl()}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  }

  /**
   * A file's bytes. Graph answers `/content` with a redirect to a
   * pre-authenticated download URL; that URL is fetched WITHOUT the access
   * token (it needs none, and the token must not travel to another host).
   */
  async function fetchDownload(url: string, accessToken: string | null, signal: AbortSignal): Promise<Response> {
    return fetch(url, {
      method: "GET",
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      redirect: accessToken ? "manual" : "follow",
      signal,
    });
  }

  // -- run binding ----------------------------------------------------------

  /**
   * The run whose output the framed text will land in. Frames verify (and are
   * stripped from stored logs) only in that run, so it must really be one of
   * this agent's live runs. Outside any run (a steward's own terminal session
   * using the agent key) nothing server-side records the output; an agent that
   * IS in a run must say which, or its text would be stored unstripped.
   *
   * The run named must be the one the output will land in: while any run of
   * the agent is running, a queued run's id is refused (its frames would not
   * verify in the running run's log, so the stripper would leave them in). A
   * run JWT names its run, and a header naming another is refused.
   */
  async function frameRunFor(
    companyId: string,
    agentId: string,
    requestRunId: string | null | undefined,
    jwtRunId?: string | null,
  ): Promise<{ ok: true; runId: string } | DocumentReadFailure> {
    const live = ["queued", "running"];
    if (jwtRunId && requestRunId !== jwtRunId) {
      return {
        ok: false,
        reason: "run_mismatch",
        message: "The run id sent with this request is not the run your credential was issued for; send $PAPERCLIP_RUN_ID as given",
      };
    }
    const runningRun = () =>
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["running"])),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
    if (requestRunId) {
      if (!UUID_RE.test(requestRunId)) {
        return { ok: false, reason: "run_mismatch", message: "The run id sent with this request is not one of your runs" };
      }
      const run = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(
          and(eq(heartbeatRuns.id, requestRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)),
        )
        .then((rows) => rows[0] ?? null);
      if (!run) {
        return { ok: false, reason: "run_mismatch", message: "The run id sent with this request is not one of your runs" };
      }
      if (!live.includes(run.status)) {
        return { ok: false, reason: "run_mismatch", message: "The run id sent with this request belongs to a run that has ended" };
      }
      if (run.status === "queued" && (await runningRun())) {
        return {
          ok: false,
          reason: "run_mismatch",
          message: "The run id sent with this request is a queued run, not the run you are in; send $PAPERCLIP_RUN_ID as given",
        };
      }
      return { ok: true, runId: run.id };
    }
    if (await runningRun()) {
      return {
        ok: false,
        reason: "run_id_required",
        message: "You are inside a run: send its id as the X-Paperclip-Run-Id header ($PAPERCLIP_RUN_ID) with every document request",
      };
    }
    return { ok: true, runId: `no-run:${agentId}` };
  }

  function framerFor(runId: string): Framer {
    const nonce = newDocumentFrameNonce();
    return {
      frame: (text, docId, title) =>
        frameUntrustedDocumentText(MICROSOFT_DOCUMENTS_PROVIDER, text, { runId, docId, title, nonce }),
    };
  }

  // -- authorization ----------------------------------------------------------

  async function authorize(companyId: string, agentId: string): Promise<Authorized | DocumentReadFailure> {
    const acting = await connectors.resolveActingAs(companyId, agentId, "read", MICROSOFT_DOCUMENTS_PROVIDER);
    if (!acting.ok) return explainNoConnection(companyId, agentId, acting.blocked);
    const connectionId = acting.resolution.connectionId;
    if (!consumeRateBudget(connectionId)) {
      return {
        ok: false,
        reason: "rate_limited",
        message: "The document request budget for your steward's Microsoft connection is used up for this minute; try again shortly",
      };
    }
    let token: { accessToken: string; grantedScopes: string[] };
    try {
      token = await auth.tokenForConnection(connectionId);
    } catch (error) {
      if (error instanceof MicrosoftGraphAuthError) {
        const reason: DocumentReadFailureReason =
          error.reason === "reconnect_required"
            ? "reconnect_required"
            : error.reason === "not_connected"
              ? "no_connection"
              : error.reason === "not_configured"
                ? "not_configured"
                : error.reason === "microsoft_unreachable"
                  ? "provider_unreachable"
                  : "provider_error";
        return { ok: false, reason, message: error.message };
      }
      throw error;
    }
    if ((authFailures.get(tokenKey(connectionId, token.accessToken)) ?? 0) >= AUTH_FAILURE_THRESHOLD) {
      return {
        ok: false,
        reason: "reconnect_required",
        message: "Microsoft has refused your steward's connection repeatedly; they must reconnect Microsoft from My Agent",
      };
    }
    return {
      ok: true,
      connectionId,
      accessToken: token.accessToken,
      accountLabel: acting.resolution.accountLabel,
      grantedScopes: token.grantedScopes,
    };
  }

  /** `no_connection` says why when it can: no steward, or a connection that needs reconnecting. */
  async function explainNoConnection(
    companyId: string,
    agentId: string,
    blocked: { reason: string; message: string },
  ): Promise<DocumentReadFailure> {
    if (blocked.reason !== "no_connection") {
      return { ok: false, reason: blocked.reason as DocumentReadFailureReason, message: blocked.message };
    }
    const stewardship = await stewardships.activeByAgent(companyId, agentId);
    if (!stewardship) {
      return {
        ok: false,
        reason: "no_connection",
        message: "You have no steward, so you have no documents to read: an agent reads only its current steward's documents",
      };
    }
    const row = await db
      .select({ status: connections.status, encryptedToken: connections.encryptedToken })
      .from(connections)
      .where(
        and(
          eq(connections.companyId, companyId),
          eq(connections.provider, MICROSOFT_DOCUMENTS_PROVIDER),
          eq(connections.ownerType, "user"),
          eq(connections.ownerId, stewardship.userId),
          isNull(connections.revokedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (row && row.encryptedToken !== null && (row.status === "error" || row.status === "expired")) {
      return {
        ok: false,
        reason: "reconnect_required",
        message: "Your steward's Microsoft connection has stopped working; ask them to reconnect Microsoft from My Agent",
      };
    }
    return {
      ok: false,
      reason: "no_connection",
      message: "Your steward has not connected Microsoft 365; ask them to connect it from My Agent",
    };
  }

  /** A 401 from Graph: the token is dead. Mark the row, unless it already holds a newer token. */
  async function markRejected(authorized: Authorized, companyId: string) {
    const key = tokenKey(authorized.connectionId, authorized.accessToken);
    authFailures.set(key, (authFailures.get(key) ?? 0) + 1);
    const current = await connectors.getDecryptedToken(authorized.connectionId).catch(() => null);
    if (current?.accessToken !== authorized.accessToken) return;
    const marked = await db
      .update(connections)
      .set({ status: "error", updatedAt: new Date() })
      .where(
        and(eq(connections.id, authorized.connectionId), isNull(connections.revokedAt), eq(connections.status, "active")),
      )
      .returning({ id: connections.id })
      .then((rows) => rows.length > 0);
    if (!marked) return;
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "microsoft-documents",
      action: "connection.microsoft_read_failed",
      entityType: "connection",
      entityId: authorized.connectionId,
      details: {
        provider: MICROSOFT_DOCUMENTS_PROVIDER,
        reason: "reconnect_required",
        message: "Microsoft refused this connection when an agent read a document. Reconnect Microsoft.",
      },
    });
  }

  async function graphJson(
    authorized: Authorized,
    companyId: string,
    path: string,
  ): Promise<{ ok: true; body: Record<string, unknown> } | DocumentReadFailure> {
    let response: Response;
    try {
      response = await graphGet(path, authorized.accessToken);
    } catch (error) {
      logger.warn({ err: error }, "microsoft graph read failed");
      return { ok: false, reason: "provider_unreachable", message: "Microsoft Graph could not be reached; try again shortly" };
    }
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") {
        return { ok: false, reason: "provider_error", message: "Microsoft Graph returned an unreadable answer" };
      }
      return { ok: true, body };
    }
    return classifyFailure(response, authorized, companyId);
  }

  async function classifyFailure(
    response: Response,
    authorized: Authorized,
    companyId: string,
  ): Promise<DocumentReadFailure> {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) {
      await markRejected(authorized, companyId);
      return {
        ok: false,
        reason: "reconnect_required",
        message: "Microsoft refused your steward's connection; ask them to reconnect Microsoft from My Agent",
      };
    }
    if (response.status === 403) {
      return { ok: false, reason: "access_denied", message: "Your steward does not have access to that item" };
    }
    if (response.status === 404) {
      return { ok: false, reason: "not_found", message: "No such file, folder or site, or your steward cannot see it" };
    }
    if (response.status === 429 || response.status >= 500) {
      return { ok: false, reason: "provider_unreachable", message: "Microsoft Graph is busy or unavailable; try again shortly" };
    }
    if (response.status === 400) {
      return { ok: false, reason: "invalid_reference", message: "Microsoft Graph did not accept that reference or query" };
    }
    return { ok: false, reason: "provider_error", message: `Microsoft Graph answered ${response.status}` };
  }

  // -- projection -------------------------------------------------------------

  function projectItem(raw: unknown, framer: Framer): DocumentItemView | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, any>;
    const remote = item.remoteItem && typeof item.remoteItem === "object" ? (item.remoteItem as Record<string, any>) : null;
    const source = remote ?? item;
    const itemRef = formatItemRef(source.parentReference?.driveId ?? item.parentReference?.driveId, source.id ?? item.id);
    if (!itemRef) return null;
    const isFolder = Boolean(source.folder ?? item.folder);
    const name = typeof item.name === "string" ? item.name : typeof source.name === "string" ? source.name : "";
    const mimeType = typeof source.file?.mimeType === "string" ? source.file.mimeType : null;
    const kind = isFolder ? null : classifyDocument(name, mimeType);
    const view: DocumentItemView = {
      itemRef,
      kind: isFolder ? "folder" : "file",
      name: framer.frame(name, itemRef, null),
      mimeType,
      size: typeof source.size === "number" ? source.size : typeof item.size === "number" ? item.size : null,
      webUrl: typeof source.webUrl === "string" ? source.webUrl : typeof item.webUrl === "string" ? item.webUrl : null,
      lastModified:
        typeof source.lastModifiedDateTime === "string"
          ? source.lastModifiedDateTime
          : typeof item.lastModifiedDateTime === "string"
            ? item.lastModifiedDateTime
            : null,
      shared: remote !== null,
      readAs: kind === null ? null : kind === "xlsx" ? "spreadsheet" : kind === "unsupported" ? "unsupported" : "text",
    };
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (description) view.description = framer.frame(description, itemRef, null);
    return view;
  }

  function projectSite(raw: unknown, framer: Framer): DocumentSiteView | null {
    if (!raw || typeof raw !== "object") return null;
    const site = raw as Record<string, any>;
    if (!isSiteId(site.id)) return null;
    const name = typeof site.displayName === "string" ? site.displayName : typeof site.name === "string" ? site.name : "";
    const view: DocumentSiteView = {
      kind: "site",
      siteId: site.id,
      name: framer.frame(name, site.id, null),
      webUrl: typeof site.webUrl === "string" ? site.webUrl : null,
    };
    const description = typeof site.description === "string" ? site.description.trim() : "";
    if (description) view.description = framer.frame(description, site.id, null);
    return view;
  }

  // -- measurement -----------------------------------------------------------

  /** Item id (never the drive) and byte count; never text, name or person. */
  async function record(
    companyId: string,
    runContext: DocumentRunContext | undefined,
    startedAt: Date,
    outcome: { ok: true; itemId?: string; byteCount?: number; resultChars: number } | { ok: false; reasonChars: number },
  ) {
    if (!runContext) return;
    await workflow.emit({
      companyId,
      pipelineId: runContext.pipelineId,
      runId: runContext.runId,
      stepKey: runContext.stepKey,
      eventType: outcome.ok ? "step_completed" : "step_failed",
      actorKind: "agent",
      durationMs: elapsedMsBetween(startedAt, new Date()),
      payload: outcome.ok
        ? {
            taskClass: "document_read",
            resultChars: outcome.resultChars,
            ...(outcome.itemId ? { itemId: outcome.itemId } : {}),
            ...(outcome.byteCount !== undefined ? { byteCount: outcome.byteCount } : {}),
          }
        : { taskClass: "document_read", reasonChars: outcome.reasonChars },
    });
  }

  // -- prelude shared by every read ------------------------------------------

  type Prelude = { ok: true; authorized: Authorized; framer: Framer } | DocumentReadFailure;

  async function prelude(input: {
    companyId: string;
    agentId: string;
    requestRunId?: string | null;
    jwtRunId?: string | null;
  }): Promise<Prelude> {
    const run = await frameRunFor(input.companyId, input.agentId, input.requestRunId, input.jwtRunId);
    if (!run.ok) return run;
    const authorized = await authorize(input.companyId, input.agentId);
    if (!authorized.ok) return authorized;
    return { ok: true, authorized, framer: framerFor(run.runId) };
  }

  // -- status ------------------------------------------------------------------

  /** Whether this agent can read documents now, and as which account. Makes no Graph call. */
  async function status(companyId: string, agentId: string) {
    const acting = await connectors.resolveActingAs(companyId, agentId, "read", MICROSOFT_DOCUMENTS_PROVIDER);
    if (!acting.ok) {
      const failure = await explainNoConnection(companyId, agentId, acting.blocked);
      return { provider: MICROSOFT_DOCUMENTS_PROVIDER, available: false, reason: failure.reason, message: failure.message };
    }
    const row = await connectors.getById(acting.resolution.connectionId);
    const scopes = ((row?.scopes ?? []) as string[]).map((s) => s.toLowerCase());
    return {
      provider: MICROSOFT_DOCUMENTS_PROVIDER,
      available: true,
      account: acting.resolution.accountLabel,
      /** Whether the steward granted the write tier (proposed copies, slice 5). Reads need nothing more. */
      canProposeUploads: scopes.includes("files.readwrite"),
    };
  }

  // -- search -------------------------------------------------------------------

  async function search(input: {
    companyId: string;
    agentId: string;
    requestRunId?: string | null;
    jwtRunId?: string | null;
    query: unknown;
    scope?: unknown;
    siteId?: unknown;
    limit?: unknown;
    runContext?: DocumentRunContext;
  }) {
    const startedAt = new Date();
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (query.length === 0 || query.length > DOCUMENT_QUERY_MAX_CHARS) {
      return fail({ ok: false, reason: "invalid_reference", message: `query is required (at most ${DOCUMENT_QUERY_MAX_CHARS} characters)` });
    }
    const scope = (input.scope ?? "all") as DocumentSearchScope;
    if (!(DOCUMENT_SEARCH_SCOPES as readonly string[]).includes(scope)) {
      return fail({ ok: false, reason: "invalid_reference", message: `scope must be one of: ${DOCUMENT_SEARCH_SCOPES.join(", ")}` });
    }
    const siteId = input.siteId === undefined || input.siteId === null || input.siteId === "" ? null : input.siteId;
    if (siteId !== null && (!isSiteId(siteId) || scope !== "sites")) {
      return fail({ ok: false, reason: "invalid_reference", message: "siteId must be a site id from a scope \"sites\" search, and only with scope \"sites\"" });
    }
    const limit = clampLimit(input.limit, DOCUMENT_SEARCH_DEFAULT_RESULTS, DOCUMENT_SEARCH_MAX_RESULTS);

    const ready = await prelude(input);
    if (!ready.ok) return fail(ready);
    const { authorized, framer } = ready;

    const q = searchLiteral(query);
    let path: string;
    if (scope === "sites" && siteId === null) path = `/sites?search=${encodeURIComponent(query)}&$top=${limit}`;
    else if (scope === "sites") path = `/sites/${encodeURIComponent(siteId as string)}/drive/root/search(q='${q}')?$top=${limit}&$select=${ITEM_SELECT}`;
    else if (scope === "my_drive") path = `/me/drive/root/search(q='${q}')?$top=${limit}&$select=${ITEM_SELECT}`;
    // "all" and "shared": drive-level search covers the steward's own drive AND
    // what others shared with them.
    else if (scope === "all") path = `/me/drive/search(q='${q}')?$top=${limit}&$select=${ITEM_SELECT}`;
    else return sharedSearch(`/me/drive/search(q='${q}')?$top=${SHARED_SEARCH_PAGE_SIZE}&$select=${ITEM_SELECT}`);

    const result = await graphJson(authorized, input.companyId, path);
    if (!result.ok) return fail(result);
    const values = Array.isArray(result.body.value) ? (result.body.value as unknown[]) : [];

    if (scope === "sites" && siteId === null) {
      const sites = values.map((v) => projectSite(v, framer)).filter((v): v is DocumentSiteView => v !== null).slice(0, limit);
      await record(input.companyId, input.runContext, startedAt, { ok: true, resultChars: JSON.stringify(sites).length });
      return { ok: true as const, provider: MICROSOFT_DOCUMENTS_PROVIDER, scope, results: sites };
    }
    const items = values
      .map((v) => projectItem(v, framer))
      .filter((v): v is DocumentItemView => v !== null)
      .slice(0, limit);
    await record(input.companyId, input.runContext, startedAt, { ok: true, resultChars: JSON.stringify(items).length });
    return { ok: true as const, provider: MICROSOFT_DOCUMENTS_PROVIDER, scope, results: items };

    /**
     * Drive search ranks the steward's own files with the shared ones, so a
     * page of `limit` can hold no shared file at all. Read full pages, and
     * follow Graph's nextLink (only back to Graph itself, each page charged
     * to the call budget) until `limit` shared items or the page cap.
     */
    async function sharedSearch(firstPath: string) {
      const graphBase = microsoftGraphBaseUrl();
      const shared: DocumentItemView[] = [];
      let nextPath: string | null = firstPath;
      for (let page = 0; nextPath !== null && page < SHARED_SEARCH_MAX_PAGES && shared.length < limit; page += 1) {
        if (page > 0 && !consumeRateBudget(authorized.connectionId)) break;
        const result = await graphJson(authorized, input.companyId, nextPath);
        if (!result.ok) {
          if (page === 0) return fail(result);
          break;
        }
        const values = Array.isArray(result.body.value) ? (result.body.value as unknown[]) : [];
        for (const value of values) {
          const item = projectItem(value, framer);
          if (item?.shared) shared.push(item);
        }
        const nextLink = result.body["@odata.nextLink"];
        nextPath = typeof nextLink === "string" && nextLink.startsWith(`${graphBase}/`) ? nextLink.slice(graphBase.length) : null;
      }
      const items = shared.slice(0, limit);
      await record(input.companyId, input.runContext, startedAt, { ok: true, resultChars: JSON.stringify(items).length });
      return { ok: true as const, provider: MICROSOFT_DOCUMENTS_PROVIDER, scope, results: items };
    }

    async function fail(failure: DocumentReadFailure) {
      await record(input.companyId, input.runContext, startedAt, { ok: false, reasonChars: failure.message.length });
      return failure;
    }
  }

  // -- list ----------------------------------------------------------------------

  async function list(input: {
    companyId: string;
    agentId: string;
    requestRunId?: string | null;
    jwtRunId?: string | null;
    folderRef?: unknown;
    path?: unknown;
    siteId?: unknown;
    limit?: unknown;
    runContext?: DocumentRunContext;
  }) {
    const startedAt = new Date();
    const fail = async (failure: DocumentReadFailure) => {
      await record(input.companyId, input.runContext, startedAt, { ok: false, reasonChars: failure.message.length });
      return failure;
    };
    const has = (v: unknown) => v !== undefined && v !== null && v !== "";
    const limit = clampLimit(input.limit, DOCUMENT_LIST_DEFAULT_RESULTS, DOCUMENT_LIST_MAX_RESULTS);
    let base: string;
    if (has(input.folderRef)) {
      if (has(input.path) || has(input.siteId)) {
        return fail({ ok: false, reason: "invalid_reference", message: "Give folderRef on its own, or path (optionally with siteId)" });
      }
      const ref = parseItemRef(input.folderRef);
      if (!ref) return fail({ ok: false, reason: "invalid_reference", message: "folderRef must be an itemRef from a search or list result" });
      base = `${itemPath(ref)}/children`;
    } else {
      let root = "/me/drive/root";
      if (has(input.siteId)) {
        if (!isSiteId(input.siteId)) {
          return fail({ ok: false, reason: "invalid_reference", message: "siteId must be a site id from a scope \"sites\" search" });
        }
        root = `/sites/${encodeURIComponent(input.siteId)}/drive/root`;
      }
      if (has(input.path)) {
        const encoded = drivePath(input.path);
        if (!encoded) return fail({ ok: false, reason: "invalid_reference", message: "path must be a folder path such as \"Projects/Kickoff\" (no \"..\")" });
        base = `${root}:/${encoded}:/children`;
      } else {
        base = `${root}/children`;
      }
    }

    const ready = await prelude(input);
    if (!ready.ok) return fail(ready);
    const result = await graphJson(ready.authorized, input.companyId, `${base}?$top=${limit}&$select=${ITEM_SELECT}`);
    if (!result.ok) return fail(result);
    const values = Array.isArray(result.body.value) ? (result.body.value as unknown[]) : [];
    const items = values
      .map((v) => projectItem(v, ready.framer))
      .filter((v): v is DocumentItemView => v !== null)
      .slice(0, limit);
    await record(input.companyId, input.runContext, startedAt, { ok: true, resultChars: JSON.stringify(items).length });
    return {
      ok: true as const,
      provider: MICROSOFT_DOCUMENTS_PROVIDER,
      items,
      hasMore: typeof result.body["@odata.nextLink"] === "string" || values.length > limit,
    };
  }

  // -- read ------------------------------------------------------------------------

  /** Download at most DOCUMENT_MAX_BYTES; abort the stream past it. */
  async function download(
    authorized: Authorized,
    companyId: string,
    ref: ItemRef,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; tooLarge: true } | DocumentReadFailure> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
    try {
      let response = await fetchDownload(`${microsoftGraphBaseUrl()}${itemPath(ref)}/content`, authorized.accessToken, signal);
      if (response.status >= 300 && response.status < 400) {
        const target = allowedDownloadLocation(response.headers.get("location"), microsoftGraphBaseUrl());
        await response.body?.cancel().catch(() => undefined);
        if (!target) {
          return { ok: false, reason: "provider_error", message: "Microsoft Graph returned no usable download location" };
        }
        response = await fetchDownload(target.toString(), null, signal);
      }
      if (!response.ok) {
        if (response.status === 401 && response.url.startsWith(microsoftGraphBaseUrl())) {
          return classifyFailure(response, authorized, companyId);
        }
        if (response.status === 403 || response.status === 404 || response.status === 429 || response.status >= 500) {
          return classifyFailure(response, authorized, companyId);
        }
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "provider_error", message: `The download answered ${response.status}` };
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > DOCUMENT_MAX_BYTES) {
        controller.abort();
        return { ok: false, tooLarge: true };
      }
      if (!response.body) return { ok: true, bytes: new Uint8Array() };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > DOCUMENT_MAX_BYTES) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          return { ok: false, tooLarge: true };
        }
        chunks.push(value);
      }
      return { ok: true, bytes: Buffer.concat(chunks) };
    } catch (error) {
      logger.warn({ err: error }, "microsoft document download failed");
      return { ok: false, reason: "provider_unreachable", message: "The document could not be downloaded; try again shortly" };
    }
  }

  async function read(input: {
    companyId: string;
    agentId: string;
    requestRunId?: string | null;
    jwtRunId?: string | null;
    itemRef: unknown;
    offset?: unknown;
    format?: unknown;
    runContext?: DocumentRunContext;
  }) {
    const startedAt = new Date();
    const fail = async (failure: DocumentReadFailure) => {
      await record(input.companyId, input.runContext, startedAt, { ok: false, reasonChars: failure.message.length });
      return failure;
    };
    let ref = parseItemRef(input.itemRef);
    if (!ref) return fail({ ok: false, reason: "invalid_reference", message: "itemRef must be an itemRef from a search or list result" });
    const format = input.format === undefined || input.format === null || input.format === "" ? "text" : input.format;
    if (format !== "text" && format !== "metadata") {
      return fail({ ok: false, reason: "invalid_reference", message: "format must be \"text\" or \"metadata\"" });
    }
    const rawOffset = input.offset === undefined || input.offset === null || input.offset === "" ? 0 : Number(input.offset);
    if (!Number.isInteger(rawOffset) || rawOffset < 0) {
      return fail({ ok: false, reason: "invalid_reference", message: "offset must be a whole number of characters, 0 or more" });
    }

    const ready = await prelude(input);
    if (!ready.ok) return fail(ready);
    const { authorized, framer } = ready;

    let meta = await graphJson(authorized, input.companyId, `${itemPath(ref)}?$select=${ITEM_SELECT}`);
    if (!meta.ok) return fail(meta);
    // A shortcut in the steward's drive points at an item in someone else's:
    // read the item it points at.
    const remote = meta.body.remoteItem as Record<string, any> | undefined;
    const remoteRef = remote ? parseItemRef(formatItemRef(remote.parentReference?.driveId, remote.id)) : null;
    if (remoteRef && remoteRef.driveId) {
      ref = remoteRef;
      meta = await graphJson(authorized, input.companyId, `${itemPath(ref)}?$select=${ITEM_SELECT}`);
      if (!meta.ok) return fail(meta);
    }
    const item = projectItem(meta.body, framer);
    if (!item) return fail({ ok: false, reason: "provider_error", message: "Microsoft Graph returned an item without an id" });
    if (item.kind === "folder") {
      return fail({ ok: false, reason: "is_folder", message: "That is a folder: list it with documents_list (folderRef)" });
    }

    const rawName = typeof meta.body.name === "string" ? meta.body.name : "";
    const mimeType = item.mimeType;
    const kind: DocumentKind = classifyDocument(rawName, mimeType);
    const base = { ok: true as const, provider: MICROSOFT_DOCUMENTS_PROVIDER, item };
    const noText = (reason: DocumentUnreadableReason, message: string, byteCount?: number) => ({
      ...base,
      format: "metadata" as const,
      text: null,
      offset: 0,
      nextOffset: null,
      truncated: false,
      totalChars: null,
      slideCount: null,
      unreadable: { reason, message },
      ...(byteCount !== undefined ? { byteCount } : {}),
    });

    if (format === "metadata") {
      await record(input.companyId, input.runContext, startedAt, { ok: true, itemId: ref.itemId, resultChars: JSON.stringify(item).length });
      return { ...base, format: "metadata" as const, text: null, offset: 0, nextOffset: null, truncated: false, totalChars: null, slideCount: null, unreadable: null };
    }
    if (kind === "xlsx" || kind === "unsupported") {
      const refusal = unreadableFor(kind);
      await record(input.companyId, input.runContext, startedAt, { ok: true, itemId: ref.itemId, byteCount: 0, resultChars: 0 });
      return noText(refusal.reason, refusal.message);
    }
    const tooLargeMessage = `This file is larger than ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MB, so its text is not read. Ask your steward for the part you need.`;
    if (item.size !== null && item.size > DOCUMENT_MAX_BYTES) {
      await record(input.companyId, input.runContext, startedAt, { ok: true, itemId: ref.itemId, byteCount: 0, resultChars: 0 });
      return noText("too_large", tooLargeMessage);
    }

    // Paging a document reads it once: the metadata call above has just
    // confirmed the steward can still open this version of it.
    const cacheKey = extractionCacheKey(authorized.connectionId, ref, meta.body);
    let content = cacheKey ? getCached(cacheKey) : null;
    if (!content) {
      const downloaded = await download(authorized, input.companyId, ref);
      let fresh: { byteCount: number; result: DocumentExtraction };
      if (downloaded.ok) {
        fresh = { byteCount: downloaded.bytes.byteLength, result: await extractDocumentText(downloaded.bytes, kind) };
      } else if ("tooLarge" in downloaded) {
        fresh = { byteCount: 0, result: { ok: false, reason: "too_large", message: tooLargeMessage } };
      } else {
        return fail(downloaded);
      }
      if (cacheKey) putCached(cacheKey, fresh.byteCount, fresh.result);
      content = { at: Date.now(), chars: 0, ...fresh };
    }
    const extracted = content.result;
    const byteCount = content.byteCount;
    if (!extracted.ok) {
      await record(input.companyId, input.runContext, startedAt, { ok: true, itemId: ref.itemId, byteCount, resultChars: 0 });
      return extracted.reason === "too_large"
        ? noText("too_large", tooLargeMessage)
        : noText(extracted.reason, extracted.message, byteCount);
    }
    const page = pageDocumentText(extracted.text, rawOffset);
    const framed = framer.frame(page.text, formatItemRef(ref.driveId, ref.itemId) ?? ref.itemId, rawName);
    await record(input.companyId, input.runContext, startedAt, {
      ok: true,
      itemId: ref.itemId,
      byteCount,
      resultChars: page.text.length,
    });
    return {
      ...base,
      format: "text" as const,
      text: framed,
      offset: page.offset,
      nextOffset: page.nextOffset,
      truncated: page.truncated,
      totalChars: page.totalChars,
      slideCount: extracted.slideCount,
      unreadable: null,
      byteCount,
    };
  }

  return { status, search, list, read, frameRunFor };
}

export type MicrosoftDocumentsService = ReturnType<typeof microsoftDocumentsService>;
