// AgentDash (per-steward document access): the ONLY file that writes to
// Microsoft Graph. Every PUT, POST and DELETE against Graph or an upload
// session lives here, so a reviewer can read the whole write surface in one
// place and the read services can be proven write-free by a source scan.
//
// Allowed importers (enforced by a source-scan test):
//   - services/bridge-upload.ts   slice 8: a person's own upload, as that person
//   - the slice 5 executor, when it exists (agent proposals after approval)
//
// What it can do, and nothing else:
//   - create an upload session for a NEW file in a folder, with
//     conflictBehavior "rename" (an existing file is never replaced);
//   - forward one fragment to that session, read its status, cancel it;
//   - invite one person to an item (sign-in required, Microsoft emails them);
//   - create an organization-scoped sharing link.
// There is no overwrite, no delete of a drive item, no anonymous link, no
// "users"-scope link and no tenant-wide scope anywhere in this file (D5, D11).
//
// Tokens arrive as arguments and are used only in the Authorization header.
// An upload session URL is a bearer capability: it is called WITHOUT an
// Authorization header (Microsoft's documented rule), is never logged, and
// is returned only to the caller in this process, which stores it encrypted.
import { logger } from "../middleware/logger.js";
import { microsoftGraphBaseUrl } from "./microsoft-graph-auth.js";

const HTTP_TIMEOUT_MS = 30_000;
/** A fragment can be 10 MiB; give it longer than a metadata call. */
const FRAGMENT_TIMEOUT_MS = 120_000;
const FRAGMENT_RETRIES = 3;

/**
 * The whole time one fragment may take to forward, every retry included.
 * The bridge client gives each fragment request FRAGMENT_TIMEOUT_MS in
 * packages/connect/src/inbox-mcp.mjs, which must stay well above this:
 * a client that gives up while the server is still forwarding would ask for
 * status and resend a range Microsoft may be committing. A source test pins
 * the gap.
 */
export const FRAGMENT_FORWARD_BUDGET_MS = 180_000;
let forwardBudgetMs = FRAGMENT_FORWARD_BUDGET_MS;

/** Test seam: shorten the forwarding budget; null restores it. */
export function __setFragmentForwardBudget(ms: number | null): void {
  forwardBudgetMs = ms ?? FRAGMENT_FORWARD_BUDGET_MS;
}

/** Overridable so tests do not sleep for real. */
let retryDelayMs = (attempt: number) => 250 * 2 ** (attempt - 1);

/** Test seam: make retries immediate. */
export function __setGraphWriteRetryDelay(fn: (attempt: number) => number): void {
  retryDelayMs = fn;
}

export type GraphWriteFailure = {
  ok: false;
  /** `unreachable` = network or 5xx/429; `refused` = Microsoft said no. */
  kind: "unreachable" | "refused";
  status: number | null;
  code: string | null;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * An upload URL is accepted only over HTTPS (or loopback, which is where the
 * test double lives). It came from Microsoft, but it is about to receive the
 * person's file, so it is checked rather than trusted.
 */
export function assertUploadUrlShape(uploadUrl: string): URL {
  const url = new URL(uploadUrl);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error("upload session URL is not HTTPS");
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function graphErrorCode(body: Record<string, unknown>): string | null {
  const error = body.error as { code?: unknown } | undefined;
  return typeof error?.code === "string" ? error.code : null;
}

async function graphPost(
  accessToken: string,
  path: string,
  body: unknown,
): Promise<{ ok: true; status: number; body: Record<string, unknown> } | GraphWriteFailure> {
  let response: Response;
  try {
    response = await fetch(`${microsoftGraphBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error, path }, "microsoft graph write unreachable");
    return { ok: false, kind: "unreachable", status: null, code: null };
  }
  const parsed = await readJson(response);
  if (response.ok) return { ok: true, status: response.status, body: parsed };
  return {
    ok: false,
    kind: response.status >= 500 || response.status === 429 ? "unreachable" : "refused",
    status: response.status,
    code: graphErrorCode(parsed),
  };
}

function itemPath(target: { driveId: string | null; itemId: string }): string {
  return target.driveId
    ? `/drives/${encodeURIComponent(target.driveId)}/items/${encodeURIComponent(target.itemId)}`
    : `/me/drive/items/${encodeURIComponent(target.itemId)}`;
}

/**
 * A new upload session for `fileName` inside the person's own folder.
 * `conflictBehavior: "rename"` means a name already in that folder gets a
 * number, never a replacement.
 */
export async function createUploadSession(
  accessToken: string,
  input: { folderId: string; fileName: string },
): Promise<{ ok: true; uploadUrl: string; expiresAt: string | null } | GraphWriteFailure> {
  const path =
    `/me/drive/items/${encodeURIComponent(input.folderId)}:/` +
    `${encodeURIComponent(input.fileName)}:/createUploadSession`;
  const result = await graphPost(accessToken, path, {
    item: { "@microsoft.graph.conflictBehavior": "rename", name: input.fileName },
  });
  if (!result.ok) return result;
  const uploadUrl = result.body.uploadUrl;
  if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
    return { ok: false, kind: "refused", status: result.status, code: "no_upload_url" };
  }
  try {
    assertUploadUrlShape(uploadUrl);
  } catch {
    return { ok: false, kind: "refused", status: result.status, code: "insecure_upload_url" };
  }
  const expiresAt = typeof result.body.expirationDateTime === "string" ? result.body.expirationDateTime : null;
  return { ok: true, uploadUrl, expiresAt };
}

/** The driveItem Microsoft returns when the last fragment lands. */
export interface UploadedDriveItem {
  driveId: string | null;
  itemId: string;
  name: string;
  size: number | null;
  webUrl: string | null;
}

function toDriveItem(body: Record<string, unknown>): UploadedDriveItem | null {
  if (typeof body.id !== "string") return null;
  const parent = (body.parentReference ?? {}) as { driveId?: unknown };
  return {
    driveId: typeof parent.driveId === "string" ? parent.driveId : null,
    itemId: body.id,
    name: typeof body.name === "string" ? body.name : "",
    size: typeof body.size === "number" ? body.size : null,
    webUrl: typeof body.webUrl === "string" ? body.webUrl : null,
  };
}

export type FragmentResult =
  | { kind: "accepted"; nextExpectedRanges: string[]; expiresAt: string | null }
  | { kind: "completed"; item: UploadedDriveItem }
  /** 404/410: the session is gone (expired or cancelled). */
  | { kind: "expired" }
  /** 409/416 and other 4xx: this fragment was not what the session expected. */
  | { kind: "rejected"; status: number; code: string | null }
  | { kind: "unreachable"; status: number | null };

function rangesFrom(body: Record<string, unknown>): string[] {
  return Array.isArray(body.nextExpectedRanges)
    ? body.nextExpectedRanges.filter((r): r is string => typeof r === "string")
    : [];
}

/**
 * Forward one fragment, unchanged, with the same Content-Range and NO
 * Authorization header. Retries a 5xx or a network failure up to three times
 * with backoff; anything else is the caller's to report.
 */
export async function putUploadFragment(
  uploadUrl: string,
  input: { contentRange: string; body: Buffer },
): Promise<FragmentResult> {
  const url = assertUploadUrlShape(uploadUrl);
  const deadline = Date.now() + forwardBudgetMs;
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= FRAGMENT_RETRIES + 1; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "PUT",
        // Content-Length comes from the Buffer body; Microsoft requires it.
        headers: { "content-range": input.contentRange },
        body: new Uint8Array(input.body),
        signal: AbortSignal.timeout(Math.min(FRAGMENT_TIMEOUT_MS, remaining)),
      });
    } catch (error) {
      logger.warn({ err: error, attempt }, "upload fragment forward failed");
      lastStatus = null;
      if (attempt <= FRAGMENT_RETRIES) await sleep(Math.min(retryDelayMs(attempt), Math.max(0, deadline - Date.now())));
      continue;
    }
    const body = await readJson(response);
    if (response.status === 200 || response.status === 201) {
      const item = toDriveItem(body);
      if (!item) return { kind: "rejected", status: response.status, code: "no_drive_item" };
      return { kind: "completed", item };
    }
    if (response.status === 202) {
      return {
        kind: "accepted",
        nextExpectedRanges: rangesFrom(body),
        expiresAt: typeof body.expirationDateTime === "string" ? body.expirationDateTime : null,
      };
    }
    if (response.status === 404 || response.status === 410) return { kind: "expired" };
    if (response.status >= 500 || response.status === 429) {
      lastStatus = response.status;
      if (attempt <= FRAGMENT_RETRIES) await sleep(Math.min(retryDelayMs(attempt), Math.max(0, deadline - Date.now())));
      continue;
    }
    return { kind: "rejected", status: response.status, code: graphErrorCode(body) };
  }
  return { kind: "unreachable", status: lastStatus };
}

/** Where the session stands: which byte ranges it still expects. */
export async function getUploadSessionStatus(
  uploadUrl: string,
): Promise<
  | { kind: "open"; nextExpectedRanges: string[]; expiresAt: string | null }
  | { kind: "expired" }
  | { kind: "unreachable"; status: number | null }
> {
  const url = assertUploadUrlShape(uploadUrl);
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch {
    return { kind: "unreachable", status: null };
  }
  if (response.status === 404 || response.status === 410) return { kind: "expired" };
  if (!response.ok) return { kind: "unreachable", status: response.status };
  const body = await readJson(response);
  return {
    kind: "open",
    nextExpectedRanges: rangesFrom(body),
    expiresAt: typeof body.expirationDateTime === "string" ? body.expirationDateTime : null,
  };
}

/** Cancel the session. Microsoft discards what it received. */
export async function cancelUploadSession(uploadUrl: string): Promise<boolean> {
  const url = assertUploadUrlShape(uploadUrl);
  try {
    const response = await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    // Already gone counts as cancelled.
    return response.ok || response.status === 404 || response.status === 410;
  } catch {
    return false;
  }
}

/**
 * Invite one person to the item: they must sign in (no anonymous access) and
 * Microsoft emails them the invitation (D13). One person per call, so a
 * refusal is that person's alone and the others still land.
 */
export async function inviteRecipient(
  accessToken: string,
  target: { driveId: string | null; itemId: string },
  input: { email: string; role: "read" | "write"; message?: string | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await graphPost(accessToken, `${itemPath(target)}/invite`, {
    recipients: [{ email: input.email }],
    roles: [input.role],
    requireSignIn: true,
    sendInvitation: true,
    ...(input.message ? { message: input.message.slice(0, 2000) } : {}),
  });
  if (!result.ok) {
    return { ok: false, reason: result.kind === "unreachable" ? "microsoft_unreachable" : result.code ?? "invite_refused" };
  }
  // 207 Multi-Status: the call succeeded but this recipient did not.
  if (result.status === 207) {
    const values = Array.isArray(result.body.value) ? (result.body.value as Array<Record<string, unknown>>) : [];
    const failed = values.find((v) => v && typeof v === "object" && "error" in v);
    const code = (failed?.error as { code?: unknown } | undefined)?.code;
    return { ok: false, reason: typeof code === "string" ? code : "invite_partially_failed" };
  }
  return { ok: true };
}

/**
 * An organization-scoped link: everyone signed in to the organization can
 * open it, nobody outside can. The scope is a literal here, not a parameter.
 */
export async function createOrganizationLink(
  accessToken: string,
  target: { driveId: string | null; itemId: string },
  input: { type: "view" | "edit" },
): Promise<{ ok: true; webUrl: string | null } | { ok: false; reason: string }> {
  const result = await graphPost(accessToken, `${itemPath(target)}/createLink`, {
    type: input.type,
    scope: "organization",
  });
  if (!result.ok) {
    return { ok: false, reason: result.kind === "unreachable" ? "microsoft_unreachable" : result.code ?? "link_refused" };
  }
  const link = (result.body.link ?? {}) as { webUrl?: unknown };
  return { ok: true, webUrl: typeof link.webUrl === "string" ? link.webUrl : null };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
