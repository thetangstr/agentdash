// AgentDash (per-steward document access, slice 8): a person uploads a file
// from their own machine to their own OneDrive, and shares it, from their own
// assistant session.
//
// It is the person's own act under the person's own Microsoft credential
// (slice 2), so it is not the slice 5 agent-write approval path. It still has
// a confirm step, the shape of inbox_propose / inbox_confirm:
//
//   1. destinations  list folders in the person's own OneDrive (GET only).
//   2. propose       resolve EVERYTHING (folder, recipients by name among
//                    active members, the task or issue) and mint a
//                    single-use handle over the resolved plan. Changes nothing.
//                    A missing or ambiguous destination or person mints no
//                    handle and comes back as a question (D10: no default).
//   3. confirm       spend the handle, re-check, open a Graph upload session.
//                    The session URL is a bearer capability: it is stored
//                    encrypted and never returned.
//   4. fragment      the client streams bounded fragments here; each is
//                    forwarded unchanged. The last one triggers sharing
//                    (invite with sign-in required and Microsoft's email,
//                    D13; an organization link if asked), then the task or
//                    the issue comment, then the audit rows.
//   5. status/cancel resume from Microsoft's expected ranges, or give up.
//
// Every route is behind the per-company flag `document_access_enabled` (404
// when off) and the endpoint capability `bridge:upload` (403 without it).
// Responses carry names and roles, never an email, a token or the upload URL.
// Audit rows carry ids, hashes and sizes only: never a file name, a path or
// content.
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type { Request } from "express";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  bridgeEndpoints,
  bridgeUploads,
  companyMemberships,
  instanceUserRoles,
  issues,
  stewardInboxActionHandles,
} from "@paperclipai/db";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { visibleAgentIdsFor, assertIssueIdVisible } from "../routes/visibility.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { accessService } from "./access.js";
import { logActivity } from "./activity-log.js";
import { BRIDGE_UPLOAD_CAPABILITY } from "./bridge.js";
import { connectorService } from "./connectors.js";
import { type IssueAssignmentWakeupDeps, queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";
import {
  MICROSOFT_PROVIDER,
  MicrosoftGraphAuthError,
  microsoftGraphAuthService,
  microsoftGraphBaseUrl,
} from "./microsoft-graph-auth.js";
import {
  cancelUploadSession,
  createOrganizationLink,
  createUploadSession,
  getUploadSessionStatus,
  inviteRecipient,
  putUploadFragment,
  type UploadedDriveItem,
} from "./microsoft-documents-write.js";
import { suggestNames } from "./steward-inbox-actions.js";
import { resolveStewardedAgentRoute } from "./stewarded-agent-routing.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** What a person may upload. Its own list, not the attachment allowlist. */
export const PERSON_UPLOAD_CONTENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/pdf": [".pdf"],
};

/** 250 MB: Microsoft's documented ceiling for the simple upload path, kept for the session path too. */
export const DEFAULT_PERSON_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;
export const PERSON_UPLOAD_MAX_BYTES_ENV = "AGENTDASH_PERSON_UPLOAD_MAX_BYTES";

export function personUploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[PERSON_UPLOAD_MAX_BYTES_ENV]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PERSON_UPLOAD_MAX_BYTES;
}

/** Microsoft requires fragments in multiples of 320 KiB. */
export const UPLOAD_FRAGMENT_UNIT = 320 * 1024;
/** 10 MiB = 32 × 320 KiB: the one fragment size the client uses. */
export const UPLOAD_FRAGMENT_BYTES = 32 * UPLOAD_FRAGMENT_UNIT;

export const MAX_UPLOAD_RECIPIENTS = 10;
export const MAX_UPLOAD_MESSAGE_CHARS = 2000;

/** Long enough to read a read-back, short enough to be worthless if it leaks. */
const HANDLE_TTL_MS = 15 * 60 * 1000;
const HANDLE_KIND = "upload_file";
const GRAPH_TIMEOUT_MS = 15_000;
const MAX_DESTINATIONS = 50;

/** Characters OneDrive refuses in a file name. */
const INVALID_NAME_CHARS = /["*:<>?/\\|\u0000-\u001f]/;

const ACTIVITY = {
  proposed: "document.person_upload_proposed",
  confirmed: "document.person_upload_confirmed",
  completed: "document.person_upload_completed",
  shared: "document.person_upload_shared",
  failed: "document.person_upload_failed",
  cancelled: "document.person_upload_cancelled",
} as const;

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export type UploadRole = "read" | "write";

export interface PersonRef {
  name?: string;
  userId?: string;
}

export interface UploadProposal {
  file: { name: string; byteSize: number; contentType: string; sha256: string };
  destination?: { folderId: string } | { path: string };
  recipients?: Array<PersonRef & { role?: UploadRole }>;
  link?: { scope: "organization"; type: "view" | "edit" };
  issueId?: string;
  task?: { title: string; instructions?: string; assignee: PersonRef };
  message?: string;
}

/** The resolved plan a handle carries: ids, not names typed in a chat. */
interface ResolvedPlan {
  fileName: string;
  byteSize: number;
  sha256: string;
  contentType: string;
  folderId: string;
  folderPath: string;
  recipients: Array<{ userId: string; name: string; role: UploadRole }>;
  link: { scope: "organization"; type: "view" | "edit" } | null;
  issueId: string | null;
  task: { title: string; instructions: string | null; assigneeUserId: string; assigneeName: string } | null;
  message: string | null;
}

export interface Refusal {
  ok: false;
  reason: string;
  message: string;
  [extra: string]: unknown;
}

const refusal = (reason: string, message: string, extra: Record<string, unknown> = {}): Refusal => ({
  ok: false,
  reason,
  message,
  ...extra,
});

export interface DestinationFolder {
  folderId: string;
  name: string;
  path: string;
  webUrl: string | null;
}

export interface SharingOutcome {
  userId: string;
  name: string;
  role: UploadRole;
  ok: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** `/drive/root:/Client projects` + `Kickoff` → `Client projects/Kickoff`. */
function folderPathOf(item: { name?: unknown; parentReference?: unknown }): string {
  const name = typeof item.name === "string" ? item.name : "";
  const parentPath = (item.parentReference as { path?: unknown } | undefined)?.path;
  if (typeof parentPath !== "string") return name;
  const colon = parentPath.indexOf(":");
  const parent = colon >= 0 ? decodeURIComponent(parentPath.slice(colon + 1)).replace(/^\/+/, "") : "";
  return parent ? `${parent}/${name}` : name;
}

function toFolder(item: Record<string, unknown>): DestinationFolder | null {
  if (typeof item.id !== "string" || !item.folder) return null;
  return {
    folderId: item.id,
    name: typeof item.name === "string" ? item.name : "",
    path: folderPathOf(item),
    webUrl: typeof item.webUrl === "string" ? item.webUrl : null,
  };
}

/** A path inside the person's own drive: no `..`, no empty segments. */
function normalizeDrivePath(raw: string): string | null {
  const segments = raw
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((s) => s === "." || s === "..")) return null;
  return segments.join("/");
}

async function encryptUploadUrl(uploadUrl: string): Promise<Record<string, unknown>> {
  const result = await localEncryptedProvider.createVersion({
    value: JSON.stringify({ uploadUrl }),
    externalRef: null,
  });
  return result.material;
}

async function decryptUploadUrl(material: Record<string, unknown>): Promise<string> {
  const json = await localEncryptedProvider.resolveVersion({ material, externalRef: null });
  const parsed = JSON.parse(json) as { uploadUrl?: unknown };
  if (typeof parsed.uploadUrl !== "string") throw new Error("stored upload session is unreadable");
  return parsed.uploadUrl;
}

/** GET only. Read helpers for the person's own drive and directory. */
async function graphGet(
  accessToken: string,
  path: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number | null }> {
  let response: Response;
  try {
    response = await fetch(`${microsoftGraphBaseUrl()}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error }, "microsoft graph read unreachable");
    return { ok: false, status: null };
  }
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

const FOLDER_SELECT = "$select=id,name,folder,parentReference,webUrl";

/** Graph OData string literal: single quotes doubled. */
function odataString(value: string): string {
  return value.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export function bridgeUploadService(
  db: Db,
  options: {
    /** Wakes the agent a new task is routed to. Optional for unit tests. */
    heartbeat?: IssueAssignmentWakeupDeps;
  } = {},
) {
  const connectors = connectorService(db);
  const auth = microsoftGraphAuthService(db);
  const access = accessService(db);
  const issueSvc = issueService(db);

  // -- endpoint ---------------------------------------------------------------

  /** The endpoint, enrolled, live, and holding `bridge:upload`; else a refusal. */
  async function requireUploadEndpoint(endpointId: string) {
    const endpoint = await db
      .select()
      .from(bridgeEndpoints)
      .where(and(eq(bridgeEndpoints.id, endpointId), isNull(bridgeEndpoints.revokedAt)))
      .then((rows) => rows[0] ?? null);
    if (!endpoint) throw notFound("Endpoint not found");
    if (!endpoint.enrolledAt) throw conflict("That endpoint has not been approved yet");
    if (!(endpoint.capabilities ?? []).includes(BRIDGE_UPLOAD_CAPABILITY)) {
      throw forbidden(
        `That endpoint did not declare the ${BRIDGE_UPLOAD_CAPABILITY} capability. Re-run agentdash-connect with a fresh code from My Agent.`,
      );
    }
    return endpoint;
  }

  // -- the person's own Microsoft connection -----------------------------------

  type PersonConnection = { ok: true; connectionId: string; accessToken: string; scopes: string[] };

  async function personConnection(companyId: string, userId: string): Promise<PersonConnection | Refusal> {
    const resolved = await connectors.resolveActingAs(companyId, userId, "read", MICROSOFT_PROVIDER, {
      actorType: "user",
    });
    if (!resolved.ok) {
      return refusal(
        "microsoft_not_connected",
        "You have not connected Microsoft. Connect it from your My Agent page (choose the tier that can save files), then try again.",
      );
    }
    try {
      const token = await auth.tokenForConnection(resolved.resolution.connectionId);
      return {
        ok: true,
        connectionId: resolved.resolution.connectionId,
        accessToken: token.accessToken,
        scopes: token.grantedScopes,
      };
    } catch (error) {
      if (error instanceof MicrosoftGraphAuthError) {
        if (error.reason === "reconnect_required") {
          return refusal("reconnect_required", "Microsoft no longer accepts your connection. Reconnect Microsoft from My Agent.");
        }
        if (error.reason === "microsoft_unreachable") {
          return refusal("microsoft_unreachable", "Microsoft could not be reached. Try again in a minute.");
        }
        if (error.reason === "not_configured") {
          return refusal("microsoft_not_configured", "Microsoft sign-in is not configured on this AgentDash instance. Ask an administrator.");
        }
        return refusal("microsoft_not_connected", "You have not connected Microsoft. Connect it from your My Agent page.");
      }
      throw error;
    }
  }

  const hasScope = (scopes: readonly string[], wanted: string) =>
    scopes.some((s) => s.toLowerCase() === wanted.toLowerCase());

  function scopeRefusal(scopes: readonly string[], needsDirectory: boolean): Refusal | null {
    const missing = ["Files.ReadWrite", ...(needsDirectory ? ["User.ReadBasic.All"] : [])].filter(
      (s) => !hasScope(scopes, s),
    );
    if (missing.length === 0) return null;
    return refusal(
      "write_scope_missing",
      "Your Microsoft connection can read but not save files. Reconnect Microsoft from My Agent and choose the tier that can save files, then try again.",
      { missingScopes: missing },
    );
  }

  // -- folders ----------------------------------------------------------------

  async function listFolders(accessToken: string, query: string | null, limit: number) {
    const top = Math.min(Math.max(limit, 1), MAX_DESTINATIONS);
    const path = query
      ? `/me/drive/root/search(q='${encodeURIComponent(odataString(query))}')?${FOLDER_SELECT}&$top=${top * 4}`
      : `/me/drive/root/children?${FOLDER_SELECT}&$top=${top * 4}`;
    const result = await graphGet(accessToken, path);
    if (!result.ok) return null;
    const values = Array.isArray(result.body.value) ? (result.body.value as Array<Record<string, unknown>>) : [];
    return values
      .map(toFolder)
      .filter((f): f is DestinationFolder => f !== null)
      .slice(0, top);
  }

  async function folderById(accessToken: string, folderId: string) {
    const result = await graphGet(accessToken, `/me/drive/items/${encodeURIComponent(folderId)}?${FOLDER_SELECT}`);
    if (!result.ok) return { found: false as const, status: result.status, isFolder: false };
    const folder = toFolder(result.body);
    return folder ? { found: true as const, folder } : { found: false as const, status: 200, isFolder: false, notFolder: true };
  }

  async function folderByPath(accessToken: string, drivePath: string) {
    const encoded = drivePath.split("/").map(encodeURIComponent).join("/");
    const result = await graphGet(accessToken, `/me/drive/root:/${encoded}?${FOLDER_SELECT}`);
    if (!result.ok) return { found: false as const, status: result.status, isFolder: false };
    const folder = toFolder(result.body);
    return folder ? { found: true as const, folder } : { found: false as const, status: 200, isFolder: false, notFolder: true };
  }

  async function resolveDestination(
    accessToken: string,
    destination: UploadProposal["destination"],
  ): Promise<{ ok: true; folder: DestinationFolder } | Refusal> {
    if (!destination) {
      return refusal(
        "destination_required",
        "Which folder should it go in? Pick one of these, or name another.",
        { candidates: (await listFolders(accessToken, null, 20)) ?? [] },
      );
    }
    let lookup;
    let lastSegment = "";
    if ("folderId" in destination) {
      lookup = await folderById(accessToken, destination.folderId);
    } else {
      const drivePath = normalizeDrivePath(destination.path);
      if (!drivePath) return refusal("destination_invalid", "That folder path is not usable. Name a folder in your OneDrive.");
      lastSegment = drivePath.split("/").pop() ?? "";
      lookup = await folderByPath(accessToken, drivePath);
    }
    if (lookup.found) return { ok: true, folder: lookup.folder };
    if (lookup.status === null || (lookup.status !== undefined && lookup.status >= 500)) {
      return refusal("microsoft_unreachable", "Microsoft could not be reached. Try again in a minute.");
    }
    if ("notFolder" in lookup && lookup.notFolder) {
      return refusal("destination_not_folder", "That is a file, not a folder. Pick a folder.", {
        candidates: (await listFolders(accessToken, null, 20)) ?? [],
      });
    }
    const candidates = lastSegment
      ? ((await listFolders(accessToken, lastSegment, 20)) ?? [])
      : ((await listFolders(accessToken, null, 20)) ?? []);
    return refusal("destination_not_found", "No such folder in your OneDrive. Pick one of these, or name another.", {
      candidates,
    });
  }

  // -- people -----------------------------------------------------------------

  type Member = { userId: string; name: string; email: string | null; role: string | null };

  /** Active human members with a name. Emails stay inside this module. */
  async function activeMembers(companyId: string): Promise<Member[]> {
    const rows = await db
      .select({
        userId: companyMemberships.principalId,
        role: companyMemberships.membershipRole,
        name: authUsers.name,
        email: authUsers.email,
      })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      );
    return rows.map((r) => ({ userId: r.userId, name: r.name ?? "", email: r.email ?? null, role: r.role ?? null }));
  }

  const describeMember = (m: Member) => ({ userId: m.userId, name: m.name, role: m.role });

  /**
   * One person by id or by exact name. Zero or several matches is a question
   * with the candidates (name and role, never an email), not a guess.
   */
  function resolvePerson(
    members: Member[],
    ref: PersonRef,
  ): { ok: true; member: Member } | { ok: false; given: string; didYouMean: Array<ReturnType<typeof describeMember>> } {
    if (ref.userId) {
      const member = members.find((m) => m.userId === ref.userId);
      if (member) return { ok: true, member };
      return { ok: false, given: ref.userId, didYouMean: [] };
    }
    const given = (ref.name ?? "").trim();
    const exact = members.filter((m) => normalizeName(m.name) === normalizeName(given));
    if (exact.length === 1) return { ok: true, member: exact[0]! };
    if (exact.length > 1) return { ok: false, given, didYouMean: exact.map(describeMember) };
    const near = new Set(suggestNames(given, members.map((m) => m.name)));
    return { ok: false, given, didYouMean: members.filter((m) => near.has(m.name)).map(describeMember) };
  }

  /**
   * Is this address a member of the person's own Microsoft organization?
   * Checked before any invite, because a delegated invite to an unknown
   * address can create a guest. A guest account already in the directory is
   * outside the organization too.
   */
  async function tenantCheck(
    accessToken: string,
    email: string,
  ): Promise<"member" | "outside" | "unreachable"> {
    // Basic profile fields only: User.ReadBasic.All may not expose userType,
    // so a guest is recognised by the `#EXT#` Microsoft puts in a guest's
    // user principal name, and by userType when Microsoft does return it.
    const select = "$select=id,mail,userPrincipalName";
    const direct = await graphGet(accessToken, `/users/${encodeURIComponent(email)}?${select}`);
    let user: Record<string, unknown> | null = null;
    if (direct.ok) {
      user = direct.body;
    } else if (direct.status === 404) {
      const filtered = await graphGet(
        accessToken,
        `/users?$filter=${encodeURIComponent(`mail eq '${odataString(email)}'`)}&${select}`,
      );
      if (!filtered.ok) return filtered.status === null || filtered.status >= 500 ? "unreachable" : "outside";
      const values = Array.isArray(filtered.body.value) ? (filtered.body.value as Array<Record<string, unknown>>) : [];
      user = values.length === 1 ? values[0]! : null;
    } else {
      return direct.status === null || direct.status >= 500 ? "unreachable" : "outside";
    }
    if (!user || typeof user.id !== "string") return "outside";
    if (typeof user.userType === "string" && user.userType.toLowerCase() === "guest") return "outside";
    if (typeof user.userPrincipalName === "string" && user.userPrincipalName.toUpperCase().includes("#EXT#")) {
      return "outside";
    }
    return "member";
  }

  // -- handles ------------------------------------------------------------------

  async function mintHandle(input: { companyId: string; endpointId: string; actorUserId: string; plan: ResolvedPlan }) {
    const token = randomBytes(32).toString("base64url");
    await db.insert(stewardInboxActionHandles).values({
      token,
      companyId: input.companyId,
      bridgeEndpointId: input.endpointId,
      actorUserId: input.actorUserId,
      kind: HANDLE_KIND,
      payload: input.plan as unknown as Record<string, unknown>,
      expiresAt: new Date(Date.now() + HANDLE_TTL_MS),
    });
    return token;
  }

  /** Spend once. Conditional UPDATE, so two confirmations cannot both win. */
  async function consumeHandle(token: string, endpointId: string) {
    const now = new Date();
    return db
      .update(stewardInboxActionHandles)
      .set({ consumedAt: now })
      .where(
        and(
          eq(stewardInboxActionHandles.token, token),
          eq(stewardInboxActionHandles.bridgeEndpointId, endpointId),
          eq(stewardInboxActionHandles.kind, HANDLE_KIND),
          isNull(stewardInboxActionHandles.consumedAt),
          gt(stewardInboxActionHandles.expiresAt, now),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  // -- visibility, as the person ------------------------------------------------

  /**
   * The person as a board actor, built from their real membership, so the
   * visibility rules the web applies to them apply here too. Only read by the
   * visibility helpers; it carries no credential.
   */
  async function personView(companyId: string, userId: string): Promise<Request> {
    const [membership, admin] = await Promise.all([
      db
        .select({ membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        )
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
    ]);
    return {
      actor: {
        type: "board",
        userId,
        source: "session",
        isInstanceAdmin: admin !== null,
        companyIds: [companyId],
        memberships: membership
          ? [{ companyId, membershipRole: membership.membershipRole, status: membership.status }]
          : [],
      },
    } as unknown as Request;
  }

  async function findIssue(companyId: string, ref: string) {
    const trimmed = ref.trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(trimmed);
    if (!isUuid && !isIdentifier) return null;
    return db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          isUuid ? eq(issues.id, trimmed) : eq(issues.identifier, trimmed.toUpperCase()),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function issueVisibleTo(companyId: string, userId: string, issueId: string): Promise<boolean> {
    try {
      await assertIssueIdVisible(db, await personView(companyId, userId), issueId);
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
  }

  /** Where a task for `assigneeUserId` goes: their agent, when routing applies and the person can see it. */
  async function previewRoute(companyId: string, actorUserId: string, assigneeUserId: string) {
    const routed = await resolveStewardedAgentRoute(db, {
      companyId,
      actorAgentId: null,
      actorUserId,
      assigneeUserId,
    });
    if (!routed) return null;
    const visible = await visibleAgentIdsFor(db, await personView(companyId, actorUserId), companyId);
    if (visible !== null && !visible.has(routed.toAgentId)) return null;
    const agent = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, routed.toAgentId))
      .then((rows) => rows[0] ?? null);
    return { ...routed, agentName: agent?.name ?? "their agent" };
  }

  // -- audit ------------------------------------------------------------------

  async function audit(
    companyId: string,
    actorUserId: string,
    action: string,
    entity: { type: "bridge_endpoint" | "bridge_upload"; id: string },
    details: Record<string, unknown>,
  ) {
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action,
      entityType: entity.type,
      entityId: entity.id,
      details: { provider: MICROSOFT_PROVIDER, ...details },
    }).catch((err) => logger.warn({ err, action }, "person upload activity not recorded"));
  }

  /** Ids, hashes and sizes only. Never a file name, a path, or content. */
  function planAuditDetails(plan: ResolvedPlan) {
    return {
      sha256: plan.sha256,
      byteSize: plan.byteSize,
      contentType: plan.contentType,
      folderId: plan.folderId,
      recipients: plan.recipients.map((r) => ({ userId: r.userId, role: r.role })),
      link: plan.link,
      issueId: plan.issueId,
      taskAssigneeUserId: plan.task?.assigneeUserId ?? null,
    };
  }

  // =========================================================================
  // 1. destinations
  // =========================================================================

  async function destinations(endpointId: string, input: { query?: unknown; limit?: unknown }) {
    const endpoint = await requireUploadEndpoint(endpointId);
    const query = typeof input.query === "string" && input.query.trim() ? input.query.trim().slice(0, 200) : null;
    const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : 25;
    if (limit < 1 || limit > MAX_DESTINATIONS) throw badRequest(`limit must be between 1 and ${MAX_DESTINATIONS}`);
    const conn = await personConnection(endpoint.companyId, endpoint.userId);
    if (!conn.ok) return conn;
    const folders = await listFolders(conn.accessToken, query, limit);
    if (folders === null) return refusal("microsoft_unreachable", "Microsoft could not be reached. Try again in a minute.");
    return { ok: true as const, folders };
  }

  // =========================================================================
  // 2. propose
  // =========================================================================

  async function propose(endpointId: string, request: UploadProposal) {
    const endpoint = await requireUploadEndpoint(endpointId);
    const companyId = endpoint.companyId;
    const actorUserId = endpoint.userId;
    const recipientsIn = request.recipients ?? [];

    const conn = await personConnection(companyId, actorUserId);
    if (!conn.ok) return conn;
    const scopeProblem = scopeRefusal(conn.scopes, recipientsIn.length > 0);
    if (scopeProblem) return scopeProblem;

    // The file, as declared. The client checked it on disk; this is the
    // server's own limit, so a modified client cannot exceed it.
    const { file } = request;
    const fileName = file.name.trim();
    if (!fileName || fileName.length > 255 || INVALID_NAME_CHARS.test(fileName) || fileName.startsWith(".")) {
      return refusal("file_name_invalid", "That file name cannot be saved to OneDrive. Rename the file and try again.");
    }
    const maxBytes = personUploadMaxBytes();
    if (file.byteSize > maxBytes) {
      return refusal("file_too_large", `That file is ${formatBytes(file.byteSize)}; the limit is ${formatBytes(maxBytes)}.`, {
        maxBytes,
      });
    }
    const allowedExtensions = PERSON_UPLOAD_CONTENT_TYPES[file.contentType];
    if (!allowedExtensions || !allowedExtensions.includes(extensionOf(fileName))) {
      return refusal(
        "file_type_not_allowed",
        "Only PowerPoint (.pptx), Word (.docx), Excel (.xlsx) and PDF files can be uploaded this way.",
        { allowed: Object.values(PERSON_UPLOAD_CONTENT_TYPES).flat() },
      );
    }

    const destination = await resolveDestination(conn.accessToken, request.destination);
    if (!destination.ok) return destination;

    if (request.issueId && request.task) {
      return refusal("task_or_issue", "Link the file to an existing task or create a new one, not both.");
    }

    // People: recipients, then the task assignee, all by name among active members.
    const members = await activeMembers(companyId);
    const ambiguities: Array<{ given: string; didYouMean: Array<ReturnType<typeof describeMember>> }> = [];
    const resolvedRecipients: Array<{ member: Member; role: UploadRole }> = [];
    const needsRole: string[] = [];
    for (const ref of recipientsIn) {
      if (!ref.userId && !ref.name?.trim()) return refusal("recipient_unnamed", "Each person to share with needs a name.");
      const person = resolvePerson(members, ref);
      if (!person.ok) {
        ambiguities.push({ given: person.given, didYouMean: person.didYouMean });
        continue;
      }
      if (!ref.role) {
        needsRole.push(person.member.name);
        continue;
      }
      resolvedRecipients.push({ member: person.member, role: ref.role });
    }
    let assignee: Member | null = null;
    if (request.task) {
      const person = resolvePerson(members, request.task.assignee);
      if (person.ok) assignee = person.member;
      else ambiguities.push({ given: person.given, didYouMean: person.didYouMean });
    }
    if (ambiguities.length > 0) {
      return refusal("person_unresolved", "Some names did not match exactly one person. Ask which one they meant.", {
        ambiguities,
      });
    }
    if (needsRole.length > 0) {
      return refusal("role_required", `Should ${needsRole.join(", ")} be able to view or edit? Ask; do not assume.`, {
        people: needsRole,
      });
    }
    const seen = new Set<string>();
    for (const { member } of resolvedRecipients) {
      if (member.userId === actorUserId) {
        return refusal("recipient_is_you", "You already own the file; share it with someone else or leave yourself out.");
      }
      if (seen.has(member.userId)) {
        return refusal("duplicate_recipient", `${member.name} is listed twice. Say once, with view or edit.`);
      }
      seen.add(member.userId);
    }

    // Each recipient must be in the person's own Microsoft organization.
    for (const { member } of resolvedRecipients) {
      if (!member.email) {
        return refusal("recipient_outside_organization", `${member.name} has no sign-in address AgentDash can match in your organization, so the file cannot be shared with them.`, {
          person: member.name,
        });
      }
      const check = await tenantCheck(conn.accessToken, member.email);
      if (check === "unreachable") return refusal("microsoft_unreachable", "Microsoft could not be reached. Try again in a minute.");
      if (check === "outside") {
        return refusal(
          "recipient_outside_organization",
          `${member.name} is not in your Microsoft organization (or signs in with a different address there). Files can be shared only inside your organization.`,
          { person: member.name },
        );
      }
    }

    // The task, or the issue the link is posted on.
    let issueRow: Awaited<ReturnType<typeof findIssue>> = null;
    if (request.issueId) {
      issueRow = await findIssue(companyId, request.issueId);
      if (!issueRow || !(await issueVisibleTo(companyId, actorUserId, issueRow.id))) {
        return refusal("issue_not_found", "No such task in this company.");
      }
    }
    let route: Awaited<ReturnType<typeof previewRoute>> = null;
    if (request.task && assignee) {
      if (!(await access.canUser(companyId, actorUserId, "tasks:assign"))) {
        return refusal("task_not_permitted", "You do not have permission to assign work, so the task cannot be created.");
      }
      const canOpen =
        assignee.userId === actorUserId ||
        resolvedRecipients.some((r) => r.member.userId === assignee!.userId) ||
        request.link !== undefined;
      if (!canOpen) {
        return refusal(
          "task_assignee_without_access",
          `${assignee.name} would get the task but could not open the file. Share it with them (view or edit) or add an organization link.`,
          { person: assignee.name },
        );
      }
      route = await previewRoute(companyId, actorUserId, assignee.userId);
    }

    const plan: ResolvedPlan = {
      fileName,
      byteSize: file.byteSize,
      sha256: file.sha256.toLowerCase(),
      contentType: file.contentType,
      folderId: destination.folder.folderId,
      folderPath: destination.folder.path,
      recipients: resolvedRecipients.map((r) => ({ userId: r.member.userId, name: r.member.name, role: r.role })),
      link: request.link ?? null,
      issueId: issueRow?.id ?? null,
      task:
        request.task && assignee
          ? {
              title: request.task.title.trim(),
              instructions: request.task.instructions?.trim() || null,
              assigneeUserId: assignee.userId,
              assigneeName: assignee.name,
            }
          : null,
      message: request.message?.trim() || null,
    };
    const handle = await mintHandle({ companyId, endpointId, actorUserId, plan });
    await audit(companyId, actorUserId, ACTIVITY.proposed, { type: "bridge_endpoint", id: endpointId }, planAuditDetails(plan));

    const readback: string[] = [
      `Upload ${plan.fileName} (${formatBytes(plan.byteSize)}) to your OneDrive folder: ${plan.folderPath || "(top level)"}`,
      "If that folder already has a file with this name, both are kept and the new one is numbered.",
    ];
    for (const r of plan.recipients) {
      const member = resolvedRecipients.find((x) => x.member.userId === r.userId)!.member;
      readback.push(`Share with ${r.name}${member.role ? ` (${member.role})` : ""}: can ${r.role === "write" ? "edit" : "view"}`);
    }
    if (plan.recipients.length > 0) readback.push("Microsoft will email each of them an invitation; they must sign in to open it.");
    if (plan.link) {
      readback.push(`Create a link everyone in your organization can ${plan.link.type === "edit" ? "edit" : "view"}`);
    }
    if (plan.message) readback.push(`With the message: "${plan.message}"`);
    if (issueRow) {
      readback.push(`Post the link on ${issueRow.identifier ?? "the task"}: ${issueRow.title}`);
    }
    if (plan.task) {
      readback.push(
        `Create the task "${plan.task.title}" for ${plan.task.assigneeName}` +
          (route ? `; ${route.agentName}, ${plan.task.assigneeName}'s agent, takes the first pass` : ""),
      );
    }
    readback.push(
      plan.recipients.length > 0 || plan.link
        ? "Nothing is uploaded or shared until you say yes."
        : "Nothing is uploaded until you say yes.",
    );
    return { ok: true as const, handle, readback };
  }

  // =========================================================================
  // 3. confirm
  // =========================================================================

  async function confirm(endpointId: string, token: string) {
    const endpoint = await requireUploadEndpoint(endpointId);
    const record = await consumeHandle(token, endpointId);
    if (!record || record.companyId !== endpoint.companyId || record.actorUserId !== endpoint.userId) {
      return refusal("handle_invalid", "That confirmation is no longer valid. Propose the upload again.");
    }
    const plan = record.payload as unknown as ResolvedPlan;
    const companyId = endpoint.companyId;
    const actorUserId = endpoint.userId;

    // Re-checked now, not trusted from the read-back: the connection, its
    // scopes, the folder, that every person is still an active member, and
    // the permission to assign the task.
    const conn = await personConnection(companyId, actorUserId);
    if (!conn.ok) return conn;
    const scopeProblem = scopeRefusal(conn.scopes, plan.recipients.length > 0);
    if (scopeProblem) return scopeProblem;
    const folder = await folderById(conn.accessToken, plan.folderId);
    if (!folder.found) {
      return refusal("destination_not_found", "That folder is no longer in your OneDrive. Propose the upload again.");
    }
    const memberIds = new Set((await activeMembers(companyId)).map((m) => m.userId));
    const gone = plan.recipients.filter((r) => !memberIds.has(r.userId)).map((r) => r.name);
    if (plan.task && !memberIds.has(plan.task.assigneeUserId)) gone.push(plan.task.assigneeName);
    if (gone.length > 0) {
      return refusal("person_no_longer_member", `${gone.join(", ")} is no longer an active member. Propose the upload again.`);
    }
    if (plan.task && !(await access.canUser(companyId, actorUserId, "tasks:assign"))) {
      return refusal("task_not_permitted", "You no longer have permission to assign work. Nothing was uploaded.");
    }

    const session = await createUploadSession(conn.accessToken, { folderId: plan.folderId, fileName: plan.fileName });
    if (!session.ok) {
      return session.kind === "unreachable"
        ? refusal("microsoft_unreachable", "Microsoft could not be reached. Nothing was uploaded; propose it again.")
        : refusal("microsoft_refused", "Microsoft refused to start the upload. Nothing was uploaded.", { code: session.code });
    }
    const row = await db
      .insert(bridgeUploads)
      .values({
        companyId,
        bridgeEndpointId: endpointId,
        actorUserId,
        connectionId: conn.connectionId,
        fileName: plan.fileName,
        contentType: plan.contentType,
        byteSize: plan.byteSize,
        sha256: plan.sha256,
        destination: { folderId: plan.folderId, folderPath: plan.folderPath },
        sharing: { plan: plan as unknown as Record<string, unknown> },
        uploadUrlEncrypted: await encryptUploadUrl(session.uploadUrl),
        status: "open",
        expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
      })
      .returning()
      .then((rows) => rows[0]!);
    await audit(companyId, actorUserId, ACTIVITY.confirmed, { type: "bridge_upload", id: row.id }, planAuditDetails(plan));
    return {
      ok: true as const,
      uploadId: row.id,
      fragmentBytes: UPLOAD_FRAGMENT_BYTES,
      byteSize: plan.byteSize,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };
  }

  // =========================================================================
  // 4. fragments
  // =========================================================================

  async function loadUpload(endpointId: string, uploadId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
      throw badRequest("uploadId must be a uuid");
    }
    const row = await db
      .select()
      .from(bridgeUploads)
      .where(and(eq(bridgeUploads.id, uploadId), eq(bridgeUploads.bridgeEndpointId, endpointId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Upload not found");
    return row;
  }

  /** `bytes a-b/total`, checked against the upload and Microsoft's fragment rules. */
  function parseContentRange(header: string | undefined, byteSize: number) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec((header ?? "").trim());
    if (!match) throw badRequest("Content-Range must be `bytes <start>-<end>/<total>`");
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    if (total !== byteSize) throw badRequest("Content-Range total does not match the confirmed file size");
    if (end < start || end >= total) throw badRequest("Content-Range is outside the file");
    const length = end - start + 1;
    if (length > UPLOAD_FRAGMENT_BYTES) {
      throw new HttpError(413, `A fragment may be at most ${UPLOAD_FRAGMENT_BYTES} bytes`);
    }
    if (end !== total - 1 && length % UPLOAD_FRAGMENT_UNIT !== 0) {
      throw badRequest(`Every fragment but the last must be a multiple of ${UPLOAD_FRAGMENT_UNIT} bytes`);
    }
    return { start, end, length, contentRange: `bytes ${start}-${end}/${total}` };
  }

  /**
   * Read exactly `length` bytes. More than declared is a 413 and nothing is
   * forwarded; at most one fragment is ever held in memory.
   */
  async function readExactly(stream: Readable, length: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      received += buf.length;
      if (received > length) {
        throw new HttpError(413, "The fragment is longer than its Content-Range");
      }
      chunks.push(buf);
    }
    if (received !== length) throw badRequest("The fragment is shorter than its Content-Range");
    return Buffer.concat(chunks, length);
  }

  async function markFailed(row: typeof bridgeUploads.$inferSelect, reason: string) {
    const updated = await db
      .update(bridgeUploads)
      .set({ status: "failed", uploadUrlEncrypted: null, completedAt: new Date() })
      .where(and(eq(bridgeUploads.id, row.id), eq(bridgeUploads.status, "open")))
      .returning({ id: bridgeUploads.id })
      .then((rows) => rows.length > 0);
    if (updated) {
      await audit(row.companyId, row.actorUserId, ACTIVITY.failed, { type: "bridge_upload", id: row.id }, {
        reason,
        sha256: row.sha256,
        byteSize: row.byteSize,
      });
    }
  }

  async function fragment(
    endpointId: string,
    input: { uploadId: string | undefined; contentRange: string | undefined; contentLength: string | undefined; body: Readable },
  ) {
    await requireUploadEndpoint(endpointId);
    if (!input.uploadId) throw badRequest("X-AgentDash-Upload-Id is required");
    const row = await loadUpload(endpointId, input.uploadId);
    if (row.status !== "open" || !row.uploadUrlEncrypted) {
      if (row.status === "completed") return { status: 409, body: { ok: false, reason: "already_completed", ...completedView(row) } };
      return { status: 409, body: refusal(`upload_${row.status}`, `This upload is ${row.status}. Propose it again.`) };
    }
    const range = parseContentRange(input.contentRange, row.byteSize);
    // A declared body longer than the range is refused before a byte is read.
    if (input.contentLength !== undefined) {
      const declared = Number(input.contentLength);
      if (!Number.isFinite(declared) || declared < 0) throw badRequest("Content-Length is not a number");
      if (declared > range.length) throw new HttpError(413, "The fragment is longer than its Content-Range");
      if (declared < range.length) throw badRequest("The fragment is shorter than its Content-Range");
    }
    const bytes = await readExactly(input.body, range.length);
    const uploadUrl = await decryptUploadUrl(row.uploadUrlEncrypted);
    const result = await putUploadFragment(uploadUrl, { contentRange: range.contentRange, body: bytes });

    if (result.kind === "accepted") {
      if (result.expiresAt) {
        await db.update(bridgeUploads).set({ expiresAt: new Date(result.expiresAt) }).where(eq(bridgeUploads.id, row.id));
      }
      return { status: 200, body: { ok: true, nextExpectedRanges: result.nextExpectedRanges, expiresAt: result.expiresAt } };
    }
    if (result.kind === "expired") {
      await markFailed(row, "session_expired");
      return { status: 410, body: refusal("session_expired", "The upload session expired. Nothing was shared; propose it again.") };
    }
    if (result.kind === "rejected") {
      return {
        status: 409,
        body: refusal("fragment_rejected", "Microsoft did not accept that fragment. Ask for the upload status and resume from there.", {
          status: result.status,
        }),
      };
    }
    if (result.kind === "unreachable") {
      return {
        status: 502,
        body: refusal("microsoft_unreachable", "Microsoft could not be reached. Ask for the upload status and resume from there."),
      };
    }
    return { status: 200, body: await finish(row, result.item) };
  }

  function completedView(row: typeof bridgeUploads.$inferSelect) {
    const outcome = (row.sharing as { outcome?: Record<string, unknown> } | null)?.outcome ?? {};
    return {
      item: { driveId: row.driveId, itemId: row.itemId, name: (outcome.name as string | undefined) ?? row.fileName, webUrl: row.webUrl },
      sharing: (outcome.sharing as SharingOutcome[] | undefined) ?? [],
      ...(outcome.link ? { link: outcome.link } : {}),
      ...(outcome.issue ? { issue: outcome.issue } : {}),
    };
  }

  /** The last fragment landed: verify, share, link, post, audit. Runs once. */
  async function finish(row: typeof bridgeUploads.$inferSelect, item: UploadedDriveItem) {
    const plan = (row.sharing as { plan: ResolvedPlan }).plan;
    if (item.size !== null && item.size !== row.byteSize) {
      await markFailed(row, "size_mismatch");
      return refusal(
        "size_mismatch",
        "Microsoft stored a file of a different size than you confirmed, so it was not shared. Check the file in your OneDrive.",
        { item: { driveId: item.driveId, itemId: item.itemId, name: item.name, webUrl: item.webUrl } },
      );
    }
    const claimed = await db
      .update(bridgeUploads)
      .set({
        status: "completed",
        driveId: item.driveId,
        itemId: item.itemId,
        webUrl: item.webUrl,
        uploadUrlEncrypted: null,
        completedAt: new Date(),
      })
      .where(and(eq(bridgeUploads.id, row.id), eq(bridgeUploads.status, "open")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) {
      const current = await db.select().from(bridgeUploads).where(eq(bridgeUploads.id, row.id)).then((rows) => rows[0]!);
      return { ok: true as const, completed: true as const, ...completedView(current) };
    }
    const target = { driveId: item.driveId, itemId: item.itemId };
    await audit(row.companyId, row.actorUserId, ACTIVITY.completed, { type: "bridge_upload", id: row.id }, {
      sha256: row.sha256,
      byteSize: row.byteSize,
      driveId: item.driveId,
      itemId: item.itemId,
    });

    // Sharing. A refusal is that person's outcome, never a thrown error: the
    // person learns the file is up and exactly who did not get access.
    const sharing: SharingOutcome[] = [];
    let linkOutcome: { scope: "organization"; type: "view" | "edit"; ok: boolean; webUrl?: string | null; reason?: string } | null =
      null;
    const conn = plan.recipients.length > 0 || plan.link ? await personConnection(row.companyId, row.actorUserId) : null;
    if (conn && !conn.ok) {
      for (const r of plan.recipients) sharing.push({ userId: r.userId, name: r.name, role: r.role, ok: false, reason: conn.reason });
      if (plan.link) linkOutcome = { ...plan.link, ok: false, reason: conn.reason };
    } else if (conn) {
      const members = new Map((await activeMembers(row.companyId)).map((m) => [m.userId, m]));
      for (const r of plan.recipients) {
        const member = members.get(r.userId);
        if (!member?.email) {
          sharing.push({ userId: r.userId, name: r.name, role: r.role, ok: false, reason: "no_longer_member" });
          continue;
        }
        const check = await tenantCheck(conn.accessToken, member.email);
        if (check !== "member") {
          sharing.push({
            userId: r.userId,
            name: r.name,
            role: r.role,
            ok: false,
            reason: check === "outside" ? "recipient_outside_organization" : "microsoft_unreachable",
          });
          continue;
        }
        const invited = await inviteRecipient(conn.accessToken, target, {
          email: member.email,
          role: r.role,
          message: plan.message,
        });
        sharing.push(
          invited.ok
            ? { userId: r.userId, name: r.name, role: r.role, ok: true }
            : { userId: r.userId, name: r.name, role: r.role, ok: false, reason: invited.reason },
        );
      }
      if (plan.link) {
        const link = await createOrganizationLink(conn.accessToken, target, { type: plan.link.type });
        linkOutcome = link.ok ? { ...plan.link, ok: true, webUrl: link.webUrl } : { ...plan.link, ok: false, reason: link.reason };
      }
    }

    const issueOutcome = await postToIssue(row, plan, item, sharing, linkOutcome);

    const outcome = {
      name: item.name || row.fileName,
      sharing,
      ...(linkOutcome ? { link: linkOutcome } : {}),
      ...(issueOutcome ? { issue: issueOutcome } : {}),
    };
    await db
      .update(bridgeUploads)
      .set({ sharing: { plan: plan as unknown as Record<string, unknown>, outcome } })
      .where(eq(bridgeUploads.id, row.id));
    if (sharing.length > 0 || linkOutcome) {
      await audit(row.companyId, row.actorUserId, ACTIVITY.shared, { type: "bridge_upload", id: row.id }, {
        driveId: item.driveId,
        itemId: item.itemId,
        recipients: sharing.map((s) => ({ userId: s.userId, role: s.role, ok: s.ok, ...(s.reason ? { reason: s.reason } : {}) })),
        link: linkOutcome ? { scope: linkOutcome.scope, type: linkOutcome.type, ok: linkOutcome.ok } : null,
        issueId: issueOutcome && "issueId" in issueOutcome ? issueOutcome.issueId : null,
      });
    }
    return {
      ok: true as const,
      completed: true as const,
      item: { driveId: item.driveId, itemId: item.itemId, name: item.name || row.fileName, webUrl: item.webUrl },
      sharing,
      ...(linkOutcome ? { link: linkOutcome } : {}),
      ...(issueOutcome ? { issue: issueOutcome } : {}),
    };
  }

  /** One metadata-only comment: name, link, who has access, the drive item id. Never content. */
  function commentBody(
    actorName: string,
    item: UploadedDriveItem,
    fileName: string,
    sharing: SharingOutcome[],
    link: { type: "view" | "edit"; ok: boolean; webUrl?: string | null } | null,
  ): string {
    const lines = [`${actorName} uploaded **${item.name || fileName}** to their OneDrive.`, ""];
    if (item.webUrl) lines.push(`- Link: ${item.webUrl}`);
    const shared = sharing.filter((s) => s.ok);
    if (shared.length > 0) {
      lines.push(`- Shared with: ${shared.map((s) => `${s.name} (can ${s.role === "write" ? "edit" : "view"})`).join(", ")}`);
    }
    const notShared = sharing.filter((s) => !s.ok);
    if (notShared.length > 0) lines.push(`- Not shared with: ${notShared.map((s) => s.name).join(", ")}`);
    if (link?.ok) {
      lines.push(`- Anyone in the organization can ${link.type === "edit" ? "edit" : "view"}${link.webUrl ? `: ${link.webUrl}` : ""}`);
    }
    lines.push(`- Drive item: \`${item.driveId ?? "me"}/${item.itemId}\``);
    return lines.join("\n");
  }

  async function postToIssue(
    row: typeof bridgeUploads.$inferSelect,
    plan: ResolvedPlan,
    item: UploadedDriveItem,
    sharing: SharingOutcome[],
    link: { type: "view" | "edit"; ok: boolean; webUrl?: string | null } | null,
  ): Promise<
    | { ok: true; issueId: string; identifier: string | null; commentId: string; created: boolean; assignedTo?: { agentName: string } | { personName: string } }
    | { ok: false; reason: string }
    | null
  > {
    if (!plan.issueId && !plan.task) return null;
    const actor = await db
      .select({ name: authUsers.name })
      .from(authUsers)
      .where(eq(authUsers.id, row.actorUserId))
      .then((rows) => rows[0] ?? null);
    const body = commentBody(actor?.name ?? "Someone", item, row.fileName, sharing, link);
    try {
      if (plan.issueId) {
        const issue = await findIssue(row.companyId, plan.issueId);
        if (!issue) return { ok: false, reason: "issue_not_found" };
        const comment = await issueSvc.addComment(issue.id, body, { userId: row.actorUserId });
        await logActivity(db, {
          companyId: row.companyId,
          actorType: "user",
          actorId: row.actorUserId,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: issue.id,
          details: { commentId: comment.id, identifier: issue.identifier, via: "bridge_upload", uploadId: row.id },
        }).catch((err) => logger.warn({ err }, "upload comment activity not recorded"));
        // The agent working the issue hears about it, as with any comment.
        if (issue.assigneeAgentId && options.heartbeat && !["done", "cancelled"].includes(issue.status)) {
          void options.heartbeat
            .wakeup(issue.assigneeAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "issue_commented",
              payload: { issueId: issue.id, commentId: comment.id, mutation: "comment" },
              requestedByActorType: "user",
              requestedByActorId: row.actorUserId,
              contextSnapshot: {
                issueId: issue.id,
                taskId: issue.id,
                commentId: comment.id,
                wakeCommentId: comment.id,
                source: "issue.comment",
                wakeReason: "issue_commented",
              },
            })
            .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on upload comment"));
        }
        return { ok: true, issueId: issue.id, identifier: issue.identifier ?? null, commentId: comment.id, created: false };
      }

      // A new task, created the way any person's assignment is: routed to
      // the assignee's agent when they steward one the uploader can see.
      const task = plan.task!;
      if (!(await access.canUser(row.companyId, row.actorUserId, "tasks:assign"))) {
        return { ok: false, reason: "task_not_permitted" };
      }
      const route = await previewRoute(row.companyId, row.actorUserId, task.assigneeUserId);
      const description = [
        task.instructions ?? null,
        `File: ${item.name || row.fileName}${item.webUrl ? ` (${item.webUrl})` : ""}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const issue = await issueSvc.create(row.companyId, {
        title: task.title,
        description,
        status: "todo",
        ...(route ? { assigneeAgentId: route.toAgentId, assigneeUserId: null } : { assigneeUserId: task.assigneeUserId }),
        createdByUserId: row.actorUserId,
      });
      const routedToStewardedAgent = route ? { fromUserId: route.fromUserId, toAgentId: route.toAgentId } : null;
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "user",
        actorId: row.actorUserId,
        action: "issue.created",
        entityType: "issue",
        entityId: issue.id,
        ...(route ? { agentId: route.toAgentId } : {}),
        details: {
          title: issue.title,
          identifier: issue.identifier,
          via: "bridge_upload",
          uploadId: row.id,
          ...(routedToStewardedAgent ? { routedToStewardedAgent } : {}),
        },
      }).catch((err) => logger.warn({ err }, "upload task activity not recorded"));
      const comment = await issueSvc.addComment(issue.id, body, { userId: row.actorUserId });
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "user",
        actorId: row.actorUserId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: { commentId: comment.id, identifier: issue.identifier, via: "bridge_upload", uploadId: row.id },
      }).catch((err) => logger.warn({ err }, "upload comment activity not recorded"));
      if (options.heartbeat) {
        void queueIssueAssignmentWakeup({
          heartbeat: options.heartbeat,
          issue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "bridge.upload",
          requestedByActorType: "user",
          requestedByActorId: row.actorUserId,
          routedFromStewardUserId: routedToStewardedAgent?.fromUserId ?? null,
        });
      }
      return {
        ok: true,
        issueId: issue.id,
        identifier: (issue as { identifier?: string | null }).identifier ?? null,
        commentId: comment.id,
        created: true,
        assignedTo: route ? { agentName: route.agentName } : { personName: task.assigneeName },
      };
    } catch (error) {
      logger.error({ err: error, uploadId: row.id }, "person upload: task or comment failed after the file landed");
      return { ok: false, reason: "issue_write_failed" };
    }
  }

  // =========================================================================
  // 5. status and cancel
  // =========================================================================

  async function status(endpointId: string, uploadId: string) {
    await requireUploadEndpoint(endpointId);
    const row = await loadUpload(endpointId, uploadId);
    if (row.status === "completed") return { ok: true as const, status: "completed" as const, ...completedView(row) };
    if (row.status !== "open" || !row.uploadUrlEncrypted) {
      return refusal(`upload_${row.status}`, `This upload is ${row.status}. Propose it again.`, { status: row.status });
    }
    const result = await getUploadSessionStatus(await decryptUploadUrl(row.uploadUrlEncrypted));
    if (result.kind === "expired") {
      await markFailed(row, "session_expired");
      return refusal("session_expired", "The upload session expired. Nothing was shared; propose it again.");
    }
    if (result.kind === "unreachable") return refusal("microsoft_unreachable", "Microsoft could not be reached. Try again in a minute.");
    return {
      ok: true as const,
      status: "open" as const,
      nextExpectedRanges: result.nextExpectedRanges,
      expiresAt: result.expiresAt,
    };
  }

  async function cancel(endpointId: string, uploadId: string) {
    await requireUploadEndpoint(endpointId);
    const row = await loadUpload(endpointId, uploadId);
    if (row.status !== "open" || !row.uploadUrlEncrypted) {
      return refusal(`upload_${row.status}`, `This upload is already ${row.status}.`, { status: row.status });
    }
    const uploadUrl = await decryptUploadUrl(row.uploadUrlEncrypted);
    const cancelled = await cancelUploadSession(uploadUrl);
    const updated = await db
      .update(bridgeUploads)
      .set({ status: "cancelled", uploadUrlEncrypted: null, completedAt: new Date() })
      .where(and(eq(bridgeUploads.id, row.id), eq(bridgeUploads.status, "open")))
      .returning({ id: bridgeUploads.id })
      .then((rows) => rows.length > 0);
    if (updated) {
      await audit(row.companyId, row.actorUserId, ACTIVITY.cancelled, { type: "bridge_upload", id: row.id }, {
        sha256: row.sha256,
        byteSize: row.byteSize,
        microsoftAcknowledged: cancelled,
      });
    }
    return { ok: true as const, status: "cancelled" as const, nothingShared: true };
  }

  return { requireUploadEndpoint, destinations, propose, confirm, fragment, status, cancel };
}

export type BridgeUploadService = ReturnType<typeof bridgeUploadService>;

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Upload rows are an audit convenience, not the audit: activity rows stay. */
export const BRIDGE_UPLOAD_RETENTION_DAYS = 7;

export async function pruneBridgeUploads(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - BRIDGE_UPLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(bridgeUploads)
    .where(lt(bridgeUploads.createdAt, cutoff))
    .returning({ id: bridgeUploads.id });
  return deleted.length;
}

/** Sweep once now, then hourly. The timer is unref'd. */
export function startBridgeUploadRetention(db: Db, intervalMs: number = 60 * 60 * 1000): () => void {
  const sweep = (label: string) => {
    pruneBridgeUploads(db).catch((err) => logger.warn({ err }, `${label} bridge upload retention sweep failed`));
  };
  const timer = setInterval(() => sweep("Scheduled"), intervalMs);
  timer.unref?.();
  sweep("Initial");
  return () => clearInterval(timer);
}
