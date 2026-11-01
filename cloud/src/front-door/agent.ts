// AgentDash (cloud MCP toolset, doc/plans/2026-10-31-cloud-mcp-toolset.md):
// the front door for agents. One dispatcher, `call(op, body, visitor)`, serves
// both transports: `POST /api/cloud/agent/<op>` (stdio agentdash-mcp with
// AGENTDASH_TOOLSET=cloud) and the hosted MCP endpoint `POST /api/cloud/mcp`,
// whose tools call it in process (routes/agent.ts). Same code, same limits.
//
//   check-name  the slug check the /start page uses.
//   start       the browser signup on the "agent" channel (service.ts): the
//               PERSON gets the verification email. Answers a handle, once.
//   status      where that one signup stands. Never a claim link, an email
//               link or anything else the person's inbox holds.
//   connect     once the box is claimed, the box's own CLI-auth approval
//               (POST /api/cli-auth/challenges): the person signs in on their
//               box and approves "the agent that set up this workspace"; the
//               board key that approval activates is delivered to the handle
//               holder exactly once.
//
// The handle: `agdh_` + 32 random bytes (base64url), shown once, stored only
// as SHA-256, bound to one signup, valid for 7 days, read-only except for
// connect, rate-limited per handle and per address. The challenge secret and
// pending key are sealed under a key derived from the handle, so the control
// plane cannot use them without a request that carries the handle.
import { hkdfSync, randomBytes, randomInt, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { CloudConfig } from "../config.js";
import { decryptField, encryptField, sha256Hex } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { agentHandles, boxEvents, boxes, jobs, signupRequests, waitlist } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { Secret } from "../secret.js";
import { MemoryLimiter, takeHit } from "./rate-limit.js";
import { MAGIC_LINK_MINUTES, SLOW_AFTER_MS, STEP_INDEX, type FrontDoor, type Visitor } from "./service.js";

export const AGENT_HANDLE_PREFIX = "agdh_";
const HANDLE_RE = /^agdh_[A-Za-z0-9_-]{43}$/;
/** How long a handle works (the claim link's lifetime too). */
export const AGENT_HANDLE_DAYS = 7;
/** Approval requests one handle may make on its box, ever. */
export const MAX_CONNECT_REQUESTS = 5;
export const AGENT_LIMITS = {
  statusPerHandle: { bucket: "agent_status_handle", limit: 240, windowMs: 3_600_000 },
  connectPerHandle: { bucket: "agent_connect_handle", limit: 60, windowMs: 3_600_000 },
};
/** What the person sees on the box's approval page, followed by the request's confirmation code. */
export const CONNECT_COMMAND = "Connect the agent that set up this workspace";
/** Placeholder challenge id (`reserving:<uuid>`) while one call makes a request on the box; it reserves the count. */
const RESERVING = "reserving:";
const RESERVE_MS = 30_000;
/** Largest box answer read; CLI-auth answers are a few hundred bytes. */
const MAX_BOX_BODY = 64 * 1024;
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A short code shown both on the box's approval page (inside the command) and
 * to the agent, which tells the person to approve only if the two match. The
 * CLI-auth create route is public, so anyone can make a request with the same
 * words; nobody else can make the person's own agent show the same code.
 */
function confirmationCode(): string {
  const c = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}
export const CONNECT_CLIENT = "AgentDash cloud setup agent";
/** The box's board keys from CLI auth live this long (server/src/services/board-auth.ts). */
const BOARD_KEY_DAYS = 30;
const DAY_MS = 86_400_000;
const PROGRESS_STEPS = ["Reserving the address", "Setting up the database", "Configuring the workspace", "Starting it up", "Checking it is healthy"];

export const AGENT_OPS = ["check-name", "start", "status", "connect"] as const;
export type AgentOp = (typeof AGENT_OPS)[number];
export interface AgentAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface AgentDoorDeps {
  db: CloudDb;
  log: Logger;
  config: Pick<CloudConfig, "edgeDomain" | "dataKeys" | "frontDoor">;
  frontDoor: FrontDoor;
  /** Calls to the boxes (their CLI-auth routes, through the edge router). Tests pass a fake box. */
  boxFetch?: typeof fetch;
  now?: () => Date;
}

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): AgentAnswer => ({ status, body: { error, code, ...extra } });

/** The key a handle's sealed connect state is encrypted under; derived, never stored. */
function handleKey(handle: string, rowId: string): Secret {
  return new Secret(Buffer.from(hkdfSync("sha256", Buffer.from(handle, "utf8"), Buffer.from(rowId, "utf8"), "agentdash-cloud-agent-connect/v1", 32)).toString("hex"));
}

interface ConnectSecrets {
  /** The box's challenge secret: polls and cancels the request. */
  token: string;
  /** The pending board key; the box activates it only when the person approves. */
  key: string;
  /** The confirmation code in the request's command. */
  code: string;
}

/** Challenge secret plus pending key, under the handle-derived key and then the data key. */
function seal(deps: AgentDoorDeps, handle: string, rowId: string, secrets: ConnectSecrets): string {
  const aad = `agent_handles.connect_sealed:${rowId}`;
  return encryptField(deps.config.dataKeys, encryptField(handleKey(handle, rowId), JSON.stringify(secrets), aad), aad);
}

function unseal(deps: AgentDoorDeps, handle: string, rowId: string, sealed: string): ConnectSecrets {
  const aad = `agent_handles.connect_sealed:${rowId}`;
  const parsed = JSON.parse(decryptField(handleKey(handle, rowId), decryptField(deps.config.dataKeys, sealed, aad), aad)) as ConnectSecrets;
  if (typeof parsed.token !== "string" || typeof parsed.key !== "string" || typeof parsed.code !== "string") throw new Error("sealed connect state is malformed");
  return parsed;
}

type ChallengeStatus = "pending" | "approved" | "cancelled" | "expired";

export function agentDoor(deps: AgentDoorDeps) {
  const { db, log, config, frontDoor: fd } = deps;
  const now = () => deps.now?.() ?? new Date();
  const boxUrl = (slug: string) => `https://${slug}.${config.edgeDomain}`;
  const site = config.frontDoor.siteUrl;
  // Unknown or malformed handles: per address, so nobody scans for live ones.
  const lookupLimiter = new MemoryLimiter(120, 60_000);
  const slugLimiter = new MemoryLimiter(60, 60_000);

  // ---- the box's CLI-auth routes (server/src/routes/access.ts) -------------

  /** At most MAX_BOX_BODY bytes of an answer; anything longer is not a CLI-auth answer. */
  async function boundedText(res: Response): Promise<string | null> {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BOX_BODY) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function boxJson(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown>; json: boolean } | null> {
    try {
      const res = await (deps.boxFetch ?? fetch)(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const text = await boundedText(res);
      if (text === null) return null;
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      const json = Boolean(body && typeof body === "object" && !Array.isArray(body));
      return { status: res.status, body: json ? (body as Record<string, unknown>) : {}, json };
    } catch (err) {
      log.warn("agent connect: box unreachable", { err: err instanceof Error ? err.name : "error" });
      return null;
    }
  }

  async function createChallenge(slug: string, code: string): Promise<{ id: string; token: string; key: string; expiresAt: Date } | null> {
    const r = await boxJson(`${boxUrl(slug)}/api/cli-auth/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ command: `${CONNECT_COMMAND} (code ${code})`, clientName: CONNECT_CLIENT, requestedAccess: "board" }),
    });
    if (!r || r.status !== 201) return null;
    const { id, token, boardApiToken, expiresAt } = r.body;
    // Only what this flow expects is believed; anything else is a box we cannot use.
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    if (typeof token !== "string" || !/^pcp_cli_auth_[A-Za-z0-9_-]{16,200}$/.test(token)) return null;
    if (typeof boardApiToken !== "string" || !/^pcp_board_[A-Za-z0-9_-]{16,200}$/.test(boardApiToken)) return null;
    const ceiling = new Date(now().getTime() + 15 * 60_000);
    const parsed = typeof expiresAt === "string" ? new Date(expiresAt) : ceiling;
    return { id, token, key: boardApiToken, expiresAt: Number.isNaN(parsed.getTime()) || parsed > ceiling ? ceiling : parsed };
  }

  async function challengeStatus(slug: string, id: string, token: string): Promise<ChallengeStatus | "unreachable"> {
    const r = await boxJson(`${boxUrl(slug)}/api/cli-auth/challenges/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!r) return "unreachable";
    // Only the box's own JSON "not found" means it no longer knows the request;
    // an edge router page (a waking or unknown box) is just unreachable.
    if (r.status === 404) return r.json && typeof r.body.error === "string" ? "expired" : "unreachable";
    if (r.status !== 200) return "unreachable";
    const s = r.body.status;
    if (s === "cancelled") return "cancelled";
    // The box reports `expired` before `approved` once the 10 minutes are up
    // (board-auth.ts challengeStatusForRow), but an approval made in time
    // stands: its key is live. approvedAt is the evidence.
    if (typeof r.body.approvedAt === "string" && r.body.approvedAt) return "approved";
    return s === "pending" || s === "approved" || s === "expired" ? s : "unreachable";
  }

  async function cancelChallenge(slug: string, id: string, token: string): Promise<void> {
    await boxJson(`${boxUrl(slug)}/api/cli-auth/challenges/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token }),
    });
  }

  const declinedAnswer = (url: string): AgentAnswer => ({
    status: 200,
    body: {
      state: "declined",
      boxUrl: url,
      nextSteps: "The person cancelled the request on their workspace. Ask whether they want to connect you; only if they say yes, call agentdash_cloud_connect with restart: true.",
    },
  });

  const approvalUrl = (slug: string, id: string, token: string) => `${boxUrl(slug)}/cli-auth/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;

  // ---- handles ---------------------------------------------------------------

  type HandleRow = typeof agentHandles.$inferSelect;

  /** The handle's row, or the answer to give instead. */
  async function resolveHandle(raw: unknown, visitor: Visitor, rule: { bucket: string; limit: number; windowMs: number }): Promise<{ row: HandleRow; handle: string } | AgentAnswer> {
    if (!lookupLimiter.take(visitor.ip ?? "unknown")) return fail(429, "rate_limited", "Too many requests. Slow down a little.");
    const handle = typeof raw === "string" ? raw.trim() : "";
    if (!HANDLE_RE.test(handle)) return fail(400, "handle_invalid", "That is not an AgentDash cloud handle.");
    const [row] = await db.select().from(agentHandles).where(eq(agentHandles.tokenHash, sha256Hex(handle)));
    if (!row) return fail(404, "handle_unknown", "No signup has this handle. Start again with agentdash_cloud_start.");
    if (row.expiresAt <= now()) return fail(410, "handle_expired", `This handle has expired (handles work for ${AGENT_HANDLE_DAYS} days). The person can find their workspace at ${site}/find.`);
    if (!(await takeHit(db, rule, row.id, now()))) return fail(429, "rate_limited", "Too many requests for this handle. Wait a few minutes and try again.");
    return { row, handle };
  }

  // ---- status ----------------------------------------------------------------

  type Status = Record<string, unknown> & { state: string };

  async function statusOf(row: HandleRow): Promise<{ status: Status; box: typeof boxes.$inferSelect | null }> {
    const base = { handleExpiresAt: row.expiresAt.toISOString() };
    const expired = (): Status => ({
      ...base,
      state: "failed",
      reason: "verification_expired",
      nextSteps: "The verification link expired before the person used it (links work for 30 minutes). Start again with agentdash_cloud_start.",
    });
    const pending = (until: Date): Status => ({
      ...base,
      state: "email_pending",
      verifyBy: until.toISOString(),
      nextSteps: "Ask the person to open the verification email from AgentDash and click the link. It works once, for 30 minutes. Then check again.",
    });
    if (!row.signupRequestId) {
      // No signup was recorded (the address already has a workspace, or is
      // blocked). Same answers as a real signup the person never verifies.
      const until = new Date(row.createdAt.getTime() + MAGIC_LINK_MINUTES * 60_000);
      return { status: until > now() ? pending(until) : expired(), box: null };
    }
    const [request] = await db.select().from(signupRequests).where(eq(signupRequests.id, row.signupRequestId));
    if (!request) return { status: expired(), box: null };
    if (!request.verifiedAt) return { status: request.expiresAt > now() ? pending(request.expiresAt) : expired(), box: null };
    if (!request.boxId) {
      return {
        status: {
          ...base,
          state: "failed",
          reason: "already_has_workspace",
          nextSteps: `This email already has an AgentDash workspace, so no new one was created. The person can find theirs at ${site}/find.`,
        },
        box: null,
      };
    }
    const [box] = await db.select().from(boxes).where(eq(boxes.id, request.boxId));
    if (!box) return { status: expired(), box: null };
    const where = { slug: box.slug, url: boxUrl(box.slug) };
    switch (box.state) {
      case "requested":
      case "waitlisted": {
        const [entry] = await db
          .select({ state: waitlist.state })
          .from(waitlist)
          .where(and(eq(waitlist.accountId, request.accountId), eq(waitlist.requestedSlug, box.slug)))
          .orderBy(desc(waitlist.createdAt))
          .limit(1);
        const [event] = await db
          .select({ detail: boxEvents.detail })
          .from(boxEvents)
          .where(and(eq(boxEvents.boxId, box.id), eq(boxEvents.kind, "provision_waitlisted")))
          .orderBy(desc(boxEvents.createdAt))
          .limit(1);
        const gate = typeof event?.detail?.reason === "string" ? event.detail.reason : null;
        const approved = entry?.state === "approved";
        return {
          status: {
            ...base,
            ...where,
            state: "waitlisted",
            approved,
            reason: approved ? "approved_waiting_for_capacity" : "awaiting_approval",
            gate,
            nextSteps: approved
              ? "The workspace is approved and waits for capacity (provisioning is paused or today's limit is reached). It starts by itself; check back in a while."
              : "The person's email is verified and the workspace is on the waitlist until AgentDash approves it (no admission code was used). The person is emailed when it is approved. Check back rarely.",
          },
          box,
        };
      }
      case "provisioning": {
        const [job] = await db
          .select({ step: jobs.step, startedAt: jobs.startedAt, createdAt: jobs.createdAt })
          .from(jobs)
          .where(and(eq(jobs.boxId, box.id), eq(jobs.kind, "provision")))
          .orderBy(sql`${jobs.createdAt} desc`)
          .limit(1);
        const index = job?.step ? (STEP_INDEX[job.step] ?? 0) : 0;
        const since = job?.startedAt ?? job?.createdAt ?? box.updatedAt;
        const slow = now().getTime() - since.getTime() > SLOW_AFTER_MS;
        return {
          status: {
            ...base,
            ...where,
            state: "provisioning",
            step: { index, of: PROGRESS_STEPS.length, label: PROGRESS_STEPS[index] },
            slow,
            nextSteps: slow
              ? "Provisioning is taking longer than usual. It continues by itself and the person is emailed when it is ready. Check again in a minute."
              : "The workspace is being created (about 2 to 3 minutes). Check again in 15 to 30 seconds.",
          },
          box,
        };
      }
      case "awaiting_claim":
        return {
          status: {
            ...base,
            ...where,
            state: "awaiting_claim",
            nextSteps:
              "The workspace is ready. The person opens the claim link in the email AgentDash sent them (also on their progress page), "
              + "sets their own password and lands in the workspace. You do not get that link. Check again after they have done it.",
          },
          box,
        };
      case "active":
      case "suspended":
        return {
          status: {
            ...base,
            ...where,
            state: "active",
            ...(box.state === "suspended" ? { suspended: true } : {}),
            connected: Boolean(row.connectedAt),
            nextSteps: row.connectedAt
              ? "The workspace is claimed and this agent was connected to it."
              : "The person has claimed the workspace. Call agentdash_cloud_connect to ask them to let you onto it."
                + (box.state === "suspended" ? " It is paused after a quiet period; visiting it wakes it in about a minute." : ""),
          },
          box,
        };
      case "failed":
      case "cleanup":
        return {
          status: { ...base, ...where, state: "failed", reason: "provisioning_failed", nextSteps: "Creating the workspace failed. AgentDash has been alerted and keeps the name; the person is emailed when it is fixed. Do not start again." },
          box,
        };
      default:
        return {
          status: { ...base, ...where, state: "failed", reason: "workspace_deleted", nextSteps: "This workspace was deleted." },
          box,
        };
    }
  }

  // ---- ops -------------------------------------------------------------------

  async function checkName(body: Record<string, unknown>, visitor: Visitor): Promise<AgentAnswer> {
    if (!slugLimiter.take(visitor.ip ?? "unknown")) return fail(429, "rate_limited", "Too many checks. Slow down a little.");
    const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
    const check = await fd.checkSlug(slug);
    return { status: 200, body: check.available ? { slug, available: true, url: boxUrl(slug) } : { slug, available: false, reason: check.reason, message: check.message } };
  }

  async function start(body: Record<string, unknown>, visitor: Visitor): Promise<AgentAnswer> {
    const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
    const code = typeof body.admissionCode === "string" && body.admissionCode.trim() ? body.admissionCode.trim() : undefined;
    const result = await fd.signup(
      {
        email: body.email,
        slug,
        workspaceName: typeof body.workspaceName === "string" && body.workspaceName.trim() ? body.workspaceName : slug,
        acceptTerms: body.acceptTerms,
        ...(code !== undefined ? { invitationCode: code } : {}),
      },
      visitor,
      "agent",
    );
    if (!result.ok) {
      return fail(result.status, result.code === "invitation_unavailable" ? "admission_code_unavailable" : result.code, result.code === "invitation_unavailable"
        ? "This admission code is not available. Check it with the person, or start without one (the workspace then waits on the list)."
        : result.error);
    }
    const handle = `${AGENT_HANDLE_PREFIX}${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now().getTime() + AGENT_HANDLE_DAYS * DAY_MS);
    await db.insert(agentHandles).values({ tokenHash: sha256Hex(handle), signupRequestId: result.signupRequestId, ip: visitor.ip, expiresAt });
    log.info("agent signup started", { bound: Boolean(result.signupRequestId), admission: code ? "code" : "waitlist" });
    return {
      status: 201,
      body: {
        handle,
        handleExpiresAt: expiresAt.toISOString(),
        state: "email_pending",
        slug,
        url: boxUrl(slug),
        admission: code ? "admission_code" : "waitlist",
        nextSteps:
          "AgentDash emailed the person a verification link (it works once, for 30 minutes). Ask them to open it and click it; you never see that link. "
          + (code
            ? "Their admission code approves the workspace once the email is verified, and it is created right away (unless provisioning is paused or today's limit is reached). "
            : "Without an admission code the workspace waits on the list for AgentDash's approval after the email is verified; the person is emailed when it is approved. ")
          + "Keep the handle private: it is shown only now, and agentdash_cloud_status needs it.",
      },
    };
  }

  async function status(body: Record<string, unknown>, visitor: Visitor): Promise<AgentAnswer> {
    const found = await resolveHandle(body.handle, visitor, AGENT_LIMITS.statusPerHandle);
    if ("status" in found) return found;
    return { status: 200, body: (await statusOf(found.row)).status };
  }

  async function connect(body: Record<string, unknown>, visitor: Visitor): Promise<AgentAnswer> {
    const found = await resolveHandle(body.handle, visitor, AGENT_LIMITS.connectPerHandle);
    if ("status" in found) return found;
    const { handle } = found;
    let row = found.row;
    const { status: current, box } = await statusOf(row);
    if (!box || (box.state !== "active" && box.state !== "suspended")) {
      return fail(409, "not_claimed", "The workspace is not claimed yet: the person has to open their claim link and set a password first.", { ...current });
    }
    const slug = box.slug;
    const url = boxUrl(slug);
    if (row.connectedAt) {
      return {
        status: 200,
        body: {
          state: "connected",
          boxUrl: url,
          delivered: true,
          connectedAt: row.connectedAt.toISOString(),
          nextSteps: "This agent was already connected and its key was delivered once. A key is never sent twice; if it was lost, the person can revoke it in their workspace and connect you another way.",
        },
      };
    }

    // A live request: ask the box what the person decided.
    if (row.connectChallengeId && !row.connectChallengeId.startsWith(RESERVING) && row.connectSealed) {
      const challengeId = row.connectChallengeId;
      const secrets = unseal(deps, handle, row.id, row.connectSealed);
      let decided = await challengeStatus(slug, challengeId, secrets.token);
      if (decided === "pending" && body.restart === true) {
        // Cancel on the box first, then look again: once cancelled it cannot be
        // approved, and an approval that landed just before the cancel is kept.
        await cancelChallenge(slug, challengeId, secrets.token);
        const after = await challengeStatus(slug, challengeId, secrets.token);
        decided = after === "approved" ? "approved" : after === "unreachable" ? "unreachable" : "expired";
      }
      if (decided === "unreachable") return fail(502, "box_unreachable", "Could not reach the workspace. Try again in a minute.", { boxUrl: url });
      if (decided === "pending") {
        return {
          status: 200,
          body: {
            state: "approval_pending",
            boxUrl: url,
            approvalUrl: approvalUrl(slug, challengeId, secrets.token),
            confirmationCode: secrets.code,
            approvalExpiresAt: row.connectExpiresAt?.toISOString() ?? null,
            nextSteps: `Waiting for the person. They open approvalUrl, sign in on their workspace, check that the page shows code ${secrets.code}, and click Approve. Then call agentdash_cloud_connect again.`,
          },
        };
      }
      if (decided === "approved") {
        // Exactly once: only the call whose UPDATE flips connected_at gets the key.
        const won = await db
          .update(agentHandles)
          .set({ connectedAt: now(), connectSealed: null, connectChallengeId: null, connectExpiresAt: null, updatedAt: now() })
          .where(and(eq(agentHandles.id, row.id), isNull(agentHandles.connectedAt), eq(agentHandles.connectChallengeId, challengeId)))
          .returning({ id: agentHandles.id });
        if (!won.length) return connect({ handle }, visitor);
        await db.insert(boxEvents).values({ boxId: box.id, kind: "agent_connected", actor: "agent-handle", detail: { handleId: row.id } });
        log.info("agent connected to its box", { slug });
        return {
          status: 200,
          body: {
            state: "connected",
            boxUrl: url,
            apiUrl: `${url}/api`,
            apiKey: secrets.key,
            apiKeyKind: "board",
            apiKeyExpiresAt: new Date(now().getTime() + BOARD_KEY_DAYS * DAY_MS).toISOString(),
            nextSteps:
              "Connected. This key acts as the person on their workspace and is delivered only this once: store it as a secret. "
              + `Continue with the setup toolset against ${url} (agentdash_setup_status, then interview → plan → hire). `
              + `MCP clients that support OAuth connectors can instead add ${url}/api/mcp/assistant; the person consents there.`,
          },
        };
      }
      // This request is over. A cancel is the person's "no": the request id
      // stays as a marker with its secrets erased, and only restart: true asks
      // again. An expired request (or a restart, cancelled above) clears it and
      // asks anew below.
      const declined = decided === "cancelled";
      await db
        .update(agentHandles)
        .set({ connectSealed: null, connectChallengeId: declined ? challengeId : null, connectExpiresAt: null, updatedAt: now() })
        .where(and(eq(agentHandles.id, row.id), eq(agentHandles.connectChallengeId, challengeId)));
      if (declined) return declinedAnswer(url);
      [row] = await db.select().from(agentHandles).where(eq(agentHandles.id, row.id));
      if (!row) return fail(404, "handle_unknown", "No signup has this handle.");
    } else if (row.connectChallengeId?.startsWith(RESERVING)) {
      // Another call is making the request on the box right now.
      if (row.connectExpiresAt && row.connectExpiresAt > now()) {
        return fail(409, "connect_in_progress", "An approval request is being made on the workspace. Call agentdash_cloud_connect again in a few seconds.");
      }
      await db
        .update(agentHandles)
        .set({ connectChallengeId: null, connectExpiresAt: null, updatedAt: now() })
        .where(and(eq(agentHandles.id, row.id), eq(agentHandles.connectChallengeId, row.connectChallengeId)));
      [row] = await db.select().from(agentHandles).where(eq(agentHandles.id, row.id));
      if (!row) return fail(404, "handle_unknown", "No signup has this handle.");
    } else if (row.connectChallengeId) {
      // The person declined an earlier request.
      if (body.restart !== true) return declinedAnswer(url);
      await db
        .update(agentHandles)
        .set({ connectChallengeId: null, updatedAt: now() })
        .where(and(eq(agentHandles.id, row.id), eq(agentHandles.connectChallengeId, row.connectChallengeId)));
      [row] = await db.select().from(agentHandles).where(eq(agentHandles.id, row.id));
      if (!row) return fail(404, "handle_unknown", "No signup has this handle.");
    }

    // A new request on the box. The count is reserved first, so concurrent
    // calls cannot make more requests on the box than the handle may.
    if (row.connectRequests >= MAX_CONNECT_REQUESTS) {
      return fail(429, "connect_limit", `This handle has made ${MAX_CONNECT_REQUESTS} approval requests, the most it may. The person can connect an agent from inside their workspace.`);
    }
    const marker = `${RESERVING}${randomUUID()}`;
    const reserved = await db
      .update(agentHandles)
      .set({ connectChallengeId: marker, connectExpiresAt: new Date(now().getTime() + RESERVE_MS), connectRequests: sql`${agentHandles.connectRequests} + 1`, updatedAt: now() })
      .where(and(eq(agentHandles.id, row.id), isNull(agentHandles.connectChallengeId), isNull(agentHandles.connectedAt), sql`${agentHandles.connectRequests} < ${MAX_CONNECT_REQUESTS}`))
      .returning({ id: agentHandles.id });
    if (!reserved.length) return connect({ handle }, visitor);
    const code = confirmationCode();
    const challenge = await createChallenge(slug, code);
    if (!challenge) {
      // Nothing was made on the box: give the reservation and its count back.
      await db
        .update(agentHandles)
        .set({ connectChallengeId: null, connectExpiresAt: null, connectRequests: sql`${agentHandles.connectRequests} - 1`, updatedAt: now() })
        .where(and(eq(agentHandles.id, row.id), eq(agentHandles.connectChallengeId, marker)));
      return fail(502, "box_unreachable", "Could not ask the workspace for an approval request. Try again in a minute.", { boxUrl: url });
    }
    const recorded = await db
      .update(agentHandles)
      .set({
        connectChallengeId: challenge.id,
        connectSealed: seal(deps, handle, row.id, { token: challenge.token, key: challenge.key, code }),
        connectExpiresAt: challenge.expiresAt,
        updatedAt: now(),
      })
      .where(and(eq(agentHandles.id, row.id), eq(agentHandles.connectChallengeId, marker)))
      .returning({ id: agentHandles.id });
    if (!recorded.length) {
      // The reservation went stale and another call took over: withdraw this request.
      await cancelChallenge(slug, challenge.id, challenge.token);
      return connect({ handle }, visitor);
    }
    await db.insert(boxEvents).values({ boxId: box.id, kind: "agent_connect_requested", actor: "agent-handle", detail: { handleId: row.id, challengeId: challenge.id } });
    return {
      status: 200,
      body: {
        state: "approval_pending",
        boxUrl: url,
        approvalUrl: approvalUrl(slug, challenge.id, challenge.token),
        confirmationCode: code,
        approvalExpiresAt: challenge.expiresAt.toISOString(),
        nextSteps:
          `Give the person approvalUrl and the code ${code}. They sign in on their workspace (with the password they just set), check that the page shows code ${code}, `
          + "and click Approve; the link works for 10 minutes. If the codes differ, they must not approve. "
          + "Then call agentdash_cloud_connect again to receive the workspace key, once.",
      },
    };
  }

  return {
    async call(op: string, body: Record<string, unknown>, visitor: Visitor): Promise<AgentAnswer> {
      const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
      switch (op) {
        case "check-name":
          return await checkName(input, visitor);
        case "start":
          return await start(input, visitor);
        case "status":
          return await status(input, visitor);
        case "connect":
          return await connect(input, visitor);
        default:
          return fail(404, "unknown_operation", "not found");
      }
    },
  };
}

export type AgentDoor = ReturnType<typeof agentDoor>;
