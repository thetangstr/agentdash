// AgentDash (per-steward document access, slice 5): the ONLY place AgentDash
// writes to Microsoft Graph on an agent's behalf.
//
// Imported by `connector-send-execution.ts` and nothing else (a source scan in
// microsoft-documents-propose.test.ts enforces it), so a write can only happen
// after a steward approved a `connector_send` and the executor re-checked
// every authority at apply time. The read services stay GET-only.
//
// What it can do, and nothing more:
// - find a folder in the token holder's OWN OneDrive (`/me/drive`), by item id
//   or by path, and confirm it is a folder on that drive;
// - create ONE new file in that folder with
//   `@microsoft.graph.conflictBehavior=rename`, so a name already in use gets
//   a numbered sibling and nothing that exists is ever replaced (D5, D15).
//
// No overwrite, no in-place edit, no delete, no sharing, and no other drive:
// every address is rooted at `/me/drive`, which is the signed-in person's own
// OneDrive. Tenant-wide write scopes are never requested (D5, D11).
//
// It never sees a refresh token and never logs or returns the access token;
// results carry ids and machine reasons, never Graph response text.
import { microsoftGraphBaseUrl } from "./microsoft-graph-auth.js";
import { logger } from "../middleware/logger.js";

/** Graph's documented ceiling for a single `PUT …/content` upload. */
export const MICROSOFT_SIMPLE_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 60_000;

export interface MicrosoftUploadTarget {
  folderId?: string | null;
  path?: string | null;
  driveId?: string | null;
}

export type MicrosoftFolderRefusal =
  | "target_not_found"
  | "target_not_folder"
  | "target_not_own_drive"
  | "reconnect_required"
  | "microsoft_unreachable"
  | `provider_${number}`;

export type ResolveOwnFolderResult =
  | { ok: true; driveId: string; folderId: string }
  | { ok: false; reason: MicrosoftFolderRefusal };

export type UploadNewFileResult =
  | { outcome: "succeeded"; driveId: string | null; itemId: string | null }
  | { outcome: "failed"; reason: string }
  | { outcome: "outcome_unknown"; reason: string };

function encodePath(path: string): string {
  return path
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function graphGet(
  accessToken: string,
  path: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: MicrosoftFolderRefusal }> {
  let response: Response;
  try {
    response = await fetch(`${microsoftGraphBaseUrl()}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error }, "microsoft graph folder lookup failed in transport");
    return { ok: false, reason: "microsoft_unreachable" };
  }
  if (response.status === 401) return { ok: false, reason: "reconnect_required" };
  if (response.status === 404) return { ok: false, reason: "target_not_found" };
  if (response.status === 429 || response.status >= 500) return { ok: false, reason: "microsoft_unreachable" };
  if (!response.ok) return { ok: false, reason: `provider_${response.status}` };
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return { ok: false, reason: "microsoft_unreachable" };
  return { ok: true, body };
}

function parentDriveId(item: Record<string, unknown>): string | null {
  const parent = item.parentReference;
  if (parent && typeof parent === "object" && typeof (parent as Record<string, unknown>).driveId === "string") {
    return (parent as Record<string, unknown>).driveId as string;
  }
  return null;
}

export function microsoftDocumentsWriteService() {
  /**
   * The destination folder, proven to be a folder on the token holder's own
   * OneDrive. Read-only (GET); a refusal here means nothing was written.
   */
  async function resolveOwnFolder(accessToken: string, target: MicrosoftUploadTarget): Promise<ResolveOwnFolderResult> {
    const drive = await graphGet(accessToken, "/me/drive?$select=id");
    if (!drive.ok) return drive;
    const ownDriveId = typeof drive.body.id === "string" ? drive.body.id : null;
    if (!ownDriveId) return { ok: false, reason: "microsoft_unreachable" };
    if (target.driveId && target.driveId !== ownDriveId) return { ok: false, reason: "target_not_own_drive" };

    const select = "?$select=id,name,folder,file,parentReference";
    let lookup: string;
    if (target.folderId) {
      lookup = `/me/drive/items/${encodeURIComponent(target.folderId)}${select}`;
    } else if (typeof target.path === "string" && target.path.trim() === "/") {
      lookup = `/me/drive/root${select}`;
    } else if (typeof target.path === "string" && target.path.trim().length > 0) {
      lookup = `/me/drive/root:/${encodePath(target.path)}${select}`;
    } else {
      return { ok: false, reason: "target_not_found" };
    }
    const item = await graphGet(accessToken, lookup);
    if (!item.ok) return item;
    const folderId = typeof item.body.id === "string" ? item.body.id : null;
    if (!folderId) return { ok: false, reason: "target_not_found" };
    if (!item.body.folder || typeof item.body.folder !== "object") return { ok: false, reason: "target_not_folder" };
    const itemDrive = parentDriveId(item.body);
    if (itemDrive && itemDrive !== ownDriveId) return { ok: false, reason: "target_not_own_drive" };
    return { ok: true, driveId: ownDriveId, folderId };
  }

  /**
   * Create one new file. `rename` on conflict: an existing name is never
   * replaced. Never retried: a 5xx or a dropped connection may mean the file
   * landed, and only a person can tell, so those are `outcome_unknown`.
   */
  async function uploadNewFile(
    accessToken: string,
    input: { folderId: string; fileName: string; body: Buffer; contentType: string },
  ): Promise<UploadNewFileResult> {
    if (input.body.length > MICROSOFT_SIMPLE_UPLOAD_MAX_BYTES) {
      return { outcome: "failed", reason: "attachment_too_large" };
    }
    const url =
      `${microsoftGraphBaseUrl()}/me/drive/items/${encodeURIComponent(input.folderId)}` +
      `:/${encodeURIComponent(input.fileName)}:/content?@microsoft.graph.conflictBehavior=rename`;
    const signal = AbortSignal.timeout(WRITE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": input.contentType,
          accept: "application/json",
        },
        body: new Uint8Array(input.body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) return { outcome: "outcome_unknown", reason: "provider_timeout" };
      logger.warn({ err: error }, "microsoft document upload failed in transport");
      return { outcome: "outcome_unknown", reason: "transport_failure" };
    }
    if (response.status >= 500) return { outcome: "outcome_unknown", reason: `provider_${response.status}` };
    if (response.status === 401) return { outcome: "failed", reason: "reconnect_required" };
    if (!response.ok) return { outcome: "failed", reason: `provider_${response.status}` };
    const created = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      outcome: "succeeded",
      itemId: typeof created.id === "string" ? created.id : null,
      driveId: parentDriveId(created),
    };
  }

  return { resolveOwnFolder, uploadNewFile };
}
