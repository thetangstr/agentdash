import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { approvalCardDeliveryService } from "../services/approval-card-delivery.js";
import { stewardInboxService } from "../services/steward-inbox.js";
import { stewardInboxDecisionService } from "../services/steward-inbox-decisions.js";
import { stewardInboxActionsService } from "../services/steward-inbox-actions.js";
import { stewardInboxAnswerService } from "../services/steward-inbox-answers.js";
import { stewardWorkService } from "../services/steward-work.js";
import { stewardWorkReplyService } from "../services/steward-work-reply.js";
import { stewardRequestsService } from "../services/steward-requests.js";
import { BRIDGE_HANDLE_HEADER, bridgeStagedFilesService } from "../services/bridge-staged-files.js";
import { bridgeEndpointSelfService } from "../services/bridge-endpoint-self.js";
import type { StorageService } from "../storage/types.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { BRIDGE_TASK_CLASSES, bridgeService } from "../services/bridge.js";
import { requireProductProfile } from "../services/companies.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

// Ids reach uuid columns. Checked here so a malformed one is the caller's 400,
// not a Postgres cast error (22P02) surfacing as a 500 with the SQL and body
// in the server log.
const uuidSchema = z.string().uuid();

function requireUuid(value: unknown, field: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw badRequest(`${field} must be a uuid`);
  return parsed.data;
}

const createBridgeTaskSchema = z.object({
  endpointId: z
    .string({ required_error: "endpointId is required" })
    .uuid("endpointId must be a uuid"),
  taskClass: z.enum(BRIDGE_TASK_CLASSES).default("read"),
  // Emptiness is the service's refusal ("An instruction is required").
  instruction: z.string().default(""),
});

/**
 * AgentDash-MK: the local agent bridge.
 *
 * Two audiences, deliberately separated.
 *
 * The **endpoint-facing** routes (`/bridge/poll`, `/bridge/result`,
 * `/bridge/decline`) are the ONLY paths a `bridge_endpoint` actor may reach.
 * That allowlist lives in `middleware/auth.ts`, next to where the actor is
 * minted, because a control enforced far from the credential it governs is one
 * that gets forgotten. These routes take no companyId — the endpoint's identity
 * supplies it, so a credential cannot reach across companies by changing a path
 * segment.
 *
 * The **human- and agent-facing** routes are ordinary company-scoped API
 * surface with the usual profile gate and authorization.
 */
/**
 * @param options Threaded to the shared post-decision effects, so an approval
 * resolved from a steward inbox wakes its requesting agent under the same
 * configuration as the same decision taken on the board. Without this the two
 * surfaces would differ for plugin-hosted agents.
 */
export function bridgeRoutes(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    autoDispatchQueuedRuns?: boolean;
    /** Substituted in tests to observe the wake an answer queues. */
    heartbeat?: Pick<ReturnType<typeof heartbeatService>, "wakeup">;
    /** Where attachment bytes live; `/bridge/work/file` reads through it. */
    storage?: StorageService;
    /**
     * Substituted in tests to observe the wakes and run effects of a request
     * created or closed out from the bridge (steward-requests.ts).
     */
    issueRuntime?: Pick<ReturnType<typeof heartbeatService>, "wakeup" | "cancelRun" | "reportRunActivity">;
  } = {},
) {
  const router = Router();
  const bridge = bridgeService(db);
  const access = accessService(db);
  const cardDelivery = approvalCardDeliveryService(db);
  const inbox = stewardInboxService(db);
  const inboxDecisions = stewardInboxDecisionService(db, options);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
    autoDispatchQueuedRuns: options.autoDispatchQueuedRuns,
  });
  const inboxActions = stewardInboxActionsService(db, { heartbeat });
  const inboxAnswers = stewardInboxAnswerService(db, { heartbeat: options.heartbeat ?? heartbeat });
  const work = stewardWorkService(db, {
    storage: options.storage,
    readRunLog: (run, opts) => heartbeat.readLog(run, opts),
  });
  const workReply = stewardWorkReplyService(db, {
    heartbeat: options.heartbeat ?? heartbeat,
    storage: options.storage,
    pluginWorkerManager: options.pluginWorkerManager,
    autoDispatchQueuedRuns: options.autoDispatchQueuedRuns,
  });
  const requests = stewardRequestsService(db, { runtime: options.issueRuntime ?? heartbeat });
  const stagedFiles = bridgeStagedFilesService(db, { storage: options.storage });
  const endpointSelf = bridgeEndpointSelfService(db);

  /** One multipart file into memory, at most `limit` bytes; the existing upload path's shape. */
  async function singleFile(req: Request, res: Response, limit: number) {
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: limit, files: 1, fields: 4 } });
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => (err ? reject(err) : resolve()));
    });
    return (req as Request & { file?: { buffer: Buffer } }).file ?? null;
  }

  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  function requireBoardUser(req: Request) {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user access required");
    return req.actor.userId;
  }

  async function isAdministrator(req: Request, companyId: string) {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return access.canUser(companyId, req.actor.userId, "agents:create");
  }

  /** The endpoint identity, or a refusal. Never trusts a body-supplied id. */
  function requireEndpoint(req: Request) {
    if (req.actor.source !== "bridge_endpoint" || !req.actor.bridgeEndpointId) {
      throw forbidden("Bridge endpoint authentication required");
    }
    return { endpointId: req.actor.bridgeEndpointId, companyId: req.actor.companyId! };
  }

  // -------------------------------------------------------------------------
  // Endpoint-facing (bridge_endpoint actor only)
  // -------------------------------------------------------------------------

  /**
   * Pull the next task.
   *
   * Returns `{ task: null }` rather than 204 when idle, so a polling client has
   * one response shape to parse. This is a plain poll, not a held long-poll —
   * see the deferred-work note in the API doc.
   */
  router.post("/bridge/poll", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);

    const claimed = await bridge.claimNextTask(endpointId);
    if (!claimed) {
      res.json({ task: null });
      return;
    }
    res.json({
      task: {
        id: claimed.task.id,
        taskClass: claimed.task.taskClass,
        instruction: claimed.task.instruction,
        leaseExpiresAt: claimed.task.leaseExpiresAt,
      },
      resultToken: claimed.resultToken,
    });
  });

  /**
   * This machine, described to itself: whose inbox it reads, its label and
   * capabilities, and whether the company has co-worker review on. What
   * `agentdash-connect check` asks. Moves no cursor and mints no handle,
   * unlike a sync, so a check never changes anything.
   */
  router.post("/bridge/whoami", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    res.json(await endpointSelf.describe(endpointId));
  });

  /**
   * Read everything this machine has not acknowledged.
   *
   * Separate from `/bridge/poll` on purpose. A poll CLAIMS one task and hands
   * back a single-use token to answer it; a sync claims nothing, mutates
   * nothing, and can be repeated safely. Folding the inbox into the poll would
   * have made an idempotent read share a route with a leased write.
   *
   * Pass `includeDigest: true` for the ordered standing summary -- urgent
   * approvals, then questions the person's agents asked them (each with an
   * answer handle), then blockers, then completions. That is a projection of how
   * things stand rather than a replay of the events above, so it answers "what
   * is waiting" while the event list answers "what changed".
   */
  router.post("/bridge/inbox/sync", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);

    const rawLimit = req.body?.limit;
    const limit = typeof rawLimit === "number" ? rawLimit : undefined;
    // Asked for on startup and on reconnect, not on every poll. The digest is
    // several queries and its answer barely moves while a steward is idle, so
    // making it the default would spend most of its cost on nobody looking.
    const includeDigest = req.body?.includeDigest === true;
    const result = await inbox.syncForEndpoint(endpointId, { limit, includeDigest });
    // The person's requests of others, as counts and pointers: only for an
    // endpoint with `bridge:work` in a company with the co-worker flag on.
    if (result.digest) {
      const yourRequests = await requests.digestSection(endpointId);
      if (yourRequests) {
        res.json({ ...result, digest: { ...result.digest, requests: yourRequests } });
        return;
      }
    }
    res.json(result);
  });

  /**
   * Move this machine's position forward.
   *
   * The client says what it applied; the server does not infer it from the
   * fact that a sync happened. That is what makes delivery at-least-once
   * rather than at-most-once: a machine that dies mid-apply gets the same
   * events again instead of losing them.
   */
  router.post("/bridge/inbox/ack", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const seq = req.body?.seq;
    if (typeof seq !== "number") throw badRequest("seq is required and must be a number");
    const result = await inbox.acknowledge(endpointId, seq);
    res.json(result);
  });

  /**
   * Resolve an approval from the inbox.
   *
   * The endpoint credential is not the authority here; the handle is, and only
   * for the one approval and revision it was minted against. Authority is then
   * re-resolved against the endpoint's owner, so a steward whose permission
   * changed since the sync is refused even holding a valid handle.
   *
   * Answers 200 with `ok: false` for the refusals a steward can actually hit —
   * a spent handle, a superseded revision, a decision someone else already
   * made. Those are outcomes to show them, not server faults.
   */
  router.post("/bridge/inbox/decide", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const token = typeof req.body?.token === "string" ? req.body.token : null;
    if (!token) throw badRequest("token is required");
    res.json(await inboxDecisions.decide(endpointId, token));
  });

  /**
   * The company's agents, name and role only.
   *
   * Enough to turn "Casper" into an id, and nothing more. An endpoint
   * credential has no business seeing adapter configuration, budgets or policy,
   * so this projection is deliberately narrow rather than the agents listing.
   */
  router.post("/bridge/inbox/agents", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    res.json(await inboxActions.listAgents(endpointId));
  });

  /**
   * Read back what was understood, and mint a single-use handle for it.
   *
   * Nothing happens here. An unresolved or ambiguous name mints no handle and
   * comes back as a question, because a wrong name silently assigned to the
   * wrong agent is worse than asking.
   */
  router.post("/bridge/inbox/propose", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const kind = req.body?.kind;
    if (kind !== "assign_work" && kind !== "set_cadence") {
      throw badRequest('kind must be "assign_work" or "set_cadence"');
    }
    res.json(await inboxActions.propose(endpointId, req.body));
  });

  /**
   * Spend the handle and do the thing.
   *
   * The credential does not authorise this; the handle does, and only for the
   * resolved action it was minted over. Permission is re-checked here rather
   * than at propose time, so authority that changed in between is honoured.
   */
  router.post("/bridge/inbox/confirm", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const token = typeof req.body?.token === "string" ? req.body.token : null;
    if (!token) throw badRequest("token is required");
    res.json(await inboxActions.confirm(endpointId, token));
  });

  /**
   * Answer an agent's question from the inbox.
   *
   * The credential does not authorise this; the handle does, for the one
   * question it was minted against, and the answer goes through the same
   * service the web page uses -- so the answer is validated, recorded as the
   * person and receipted the same way, and the asking agent is woken with it.
   * Whether the question is still this person's is re-resolved now, not
   * trusted from the sync that delivered the handle.
   *
   * Answers 200 with `ok: false` for the refusals a person can actually hit,
   * as `decide` does.
   */
  router.post("/bridge/inbox/answer", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const body = req.body ?? {};
    const token = typeof body.token === "string" ? body.token : null;
    if (!token) throw badRequest("token is required");
    const optionIds = Array.isArray(body.optionIds)
      ? body.optionIds.filter((value: unknown): value is string => typeof value === "string")
      : undefined;
    const answers = Array.isArray(body.answers)
      ? body.answers
          .filter((value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
          .map((value: Record<string, unknown>) => ({
            questionId: typeof value.questionId === "string" ? value.questionId : "",
            optionIds: Array.isArray(value.optionIds)
              ? value.optionIds.filter((id: unknown): id is string => typeof id === "string")
              : [],
            ...(typeof value.text === "string" ? { text: value.text } : {}),
          }))
      : undefined;
    res.json(
      await inboxAnswers.answer(endpointId, {
        token,
        ...(typeof body.optionId === "string" ? { optionId: body.optionId } : {}),
        ...(optionIds ? { optionIds } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        ...(answers ? { answers } : {}),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Endpoint-facing: the person's own Claude reviews their agents' work.
  // Needs `bridge:work` and the company's coworker_bridge_enabled flag; reads
  // exactly what the owner sees on the page, narrowed to their own work, with
  // every agent-written field framed. See services/steward-work.ts.
  // -------------------------------------------------------------------------

  /**
   * What the owner's agents handed them: decisions, questions, blockers,
   * reviews. Beside them, `requests`: the work the owner asked other people
   * for, delivered results first (steward-requests.ts).
   */
  router.post("/bridge/work/list", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const handoffs = await work.list(endpointId, { limit: req.body?.limit });
    if (handoffs.ok === false) {
      res.json(handoffs);
      return;
    }
    const yourRequests = await requests.list(endpointId, { limit: req.body?.limit });
    res.json(yourRequests && "ok" in yourRequests ? handoffs : { ...handoffs, requests: yourRequests });
  });

  /**
   * One hand-off: the issue, its parent and the request it came from,
   * comments, documents, attachment metadata, and child issues, each body
   * cut to its start inside one size budget. One body in full is a focused
   * read: `documentKey`, `commentId` or `section: "description"`, paged by
   * `offset`.
   */
  router.post("/bridge/work/read", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const body = req.body ?? {};
    if (typeof body.issueId !== "string" || !body.issueId.trim()) throw badRequest("issueId is required");
    res.json(
      await work.read(endpointId, {
        issueId: body.issueId,
        documentKey: body.documentKey,
        commentId: body.commentId,
        section: body.section,
        offset: body.offset,
        commentLimit: body.commentLimit,
      }),
    );
  });

  /**
   * The agent's run log for runs on that issue, newest run unless `runId` is
   * given, paged by byte `offset`. Redacted for secrets and framed: the
   * highest-volume injection surface the bridge carries.
   */
  router.post("/bridge/work/run-log", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const body = req.body ?? {};
    if (typeof body.issueId !== "string" || !body.issueId.trim()) throw badRequest("issueId is required");
    res.json(await work.runLog(endpointId, { issueId: body.issueId, runId: body.runId, offset: body.offset }));
  });

  /**
   * One attachment's bytes. Allowlisted types only, never HTML or SVG, at
   * most the company attachment cap, `nosniff`, and always as a download.
   * A refusal is JSON `{ ok: false, reason }`; the bytes carry
   * `x-agentdash-file: attachment`, which is how a client tells them apart.
   */
  router.post("/bridge/work/file", async (req, res, next) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const attachmentId = req.body?.attachmentId;
    if (typeof attachmentId !== "string" || !attachmentId.trim()) throw badRequest("attachmentId is required");
    const result = await work.file(endpointId, { attachmentId });
    if (!result.ok) {
      res.json(result);
      return;
    }
    const filename = result.filename.replace(/[\u0000-\u001f\u007f"\\/]/g, "_") || "attachment";
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Length", String(result.byteSize));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("x-agentdash-file", "attachment");
    res.setHeader("x-agentdash-attachment-id", result.attachmentId);
    res.setHeader("x-agentdash-sha256", result.sha256);
    if (result.identifier) res.setHeader("x-agentdash-issue", result.identifier);
    // Versioned files (co-worker slice 5): which version this is, and whether
    // it is the issue's current file for its name.
    if (result.version !== null) res.setHeader("x-agentdash-version", String(result.version));
    res.setHeader("x-agentdash-current", result.isCurrent ? "true" : "false");
    if (!result.isCurrent) res.setHeader("x-agentdash-current-attachment-id", result.currentAttachmentId);
    result.stream.on("error", (err) => next(err));
    result.stream.pipe(res);
  });

  /**
   * One page of an attachment's text, extracted on the server: how the
   * person's own session reads a .docx, .pptx or text deliverable. Same scope
   * and markup refusal as `/bridge/work/file`; the text is framed as untrusted
   * agent material and paged by character `offset` (pass `nextOffset` back).
   * A file whose text is not read answers `{ ok: false, code, reason, file }`
   * (`spreadsheet_not_supported`, `content_unsupported`, `file_refused`, ...).
   */
  router.post("/bridge/work/file-text", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const body = req.body ?? {};
    if (typeof body.attachmentId !== "string" || !body.attachmentId.trim()) throw badRequest("attachmentId is required");
    if (body.offset !== undefined && !(Number.isSafeInteger(body.offset) && body.offset >= 0)) {
      throw badRequest("offset must be a whole number of characters, 0 or more");
    }
    res.json(await work.fileText(endpointId, { attachmentId: body.attachmentId, offset: body.offset }));
  });

  // -------------------------------------------------------------------------
  // Endpoint-facing: the send-back. What the person approved goes back to
  // their agent as one bundle, as them. Same gates as the reads, plus a
  // single-use `reply` handle over the exact bundle. See
  // services/steward-work-reply.ts.
  // -------------------------------------------------------------------------

  /**
   * Read the bundle back and mint a handle for it. Nothing is written: the
   * answer is the read-back the person says yes to, and who will see it.
   * Refusals answer 200 `{ ok: false, code, reason }`.
   */
  router.post("/bridge/work/propose", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const body = req.body ?? {};
    if (typeof body.issueId !== "string" || !body.issueId.trim()) throw badRequest("issueId is required");
    res.json(
      await workReply.propose(endpointId, {
        issueId: body.issueId,
        answer: body.answer,
        decision: body.decision,
        document: body.document,
        comment: body.comment,
        lessons: body.lessons,
        files: body.files,
      }),
    );
  });

  /**
   * Spend the handle and apply the bundle in one transaction, as the person.
   * The handle authorises exactly the bundle it was minted over; the issue,
   * the question, the document revision and the decision authority are
   * re-checked now. Refusals answer 200 `{ ok: false, code, reason }` and
   * write nothing.
   */
  router.post("/bridge/work/confirm", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const token = typeof req.body?.token === "string" ? req.body.token : null;
    if (!token) throw badRequest("token is required");
    res.json(await workReply.confirm(endpointId, token));
  });

  /**
   * One file for a send-back or a request, after the person's yes and before
   * the confirm (co-worker slice 5). The handle from work/propose or
   * work/request goes in the `X-Bridge-Handle` header, and the multipart body
   * carries `file`. The handle is checked before any bytes are read, and the
   * body may be no larger than the largest file the handle names (never more
   * than the company attachment cap). Stored only when the handle names this
   * file's exact sha256 and size. Nothing is attached until the handle is
   * confirmed, and what is never confirmed is swept after the handle expires.
   * Refusals answer 200 `{ ok: false, code, reason }`.
   */
  router.post("/bridge/work/upload", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const token = req.get(BRIDGE_HANDLE_HEADER);
    if (!token) throw badRequest(`the ${BRIDGE_HANDLE_HEADER} header is required`);
    // The gates first (bridge:work, the flag, membership, a live handle), before any bytes are read.
    const gate = await work.resolveOwner(endpointId);
    if (work.isRefusal(gate)) {
      res.json(gate);
      return;
    }
    const limit = await stagedFiles.uploadLimit(endpointId, gate, token);
    if (!limit.ok) {
      res.json(limit);
      return;
    }
    let file: { buffer: Buffer } | null;
    try {
      file = await singleFile(req, res, limit.maxBytes);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        res.json(
          err.code !== "LIMIT_FILE_SIZE"
            ? { ok: false, code: "bad_upload", reason: `The upload could not be read (${err.code}). Nothing was stored.` }
            : limit.maxBytes < limit.cap
              ? {
                  ok: false,
                  code: "file_not_in_handle",
                  reason: `The file is larger than any file the read-back named (${limit.maxBytes.toLocaleString("en-US")} bytes at most). Only the exact files the person said yes to can be sent; if a file changed, propose again. Nothing was stored.`,
                }
              : {
                  ok: false,
                  code: "file_too_large",
                  reason: `The file is over this company's attachment cap of ${limit.cap.toLocaleString("en-US")} bytes. Nothing was stored.`,
                },
        );
        return;
      }
      throw err;
    }
    res.json(await stagedFiles.stage(endpointId, { token, file }));
  });

  // -------------------------------------------------------------------------
  // Endpoint-facing: asking someone else for work, and closing it out.
  // Same gates as the reads above. Each write is a single-use handle over
  // the exact read-back, spent by `request/confirm` with the owner's
  // authority re-checked. See services/steward-requests.ts.
  // -------------------------------------------------------------------------

  /**
   * Read back a request for another person: the brief as it will be sent,
   * who takes it (their agent, by the routing rule), and who will see it.
   * Creates nothing. An unknown or ambiguous name mints no handle.
   */
  router.post("/bridge/work/request", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    res.json(await requests.propose(endpointId, req.body ?? {}));
  });

  /**
   * Read back accepting a delivered result, or asking for changes (a comment
   * as the owner, handed straight to the deliverable owner's agent). Changes
   * nothing.
   */
  router.post("/bridge/work/request/respond", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const body = req.body ?? {};
    if (typeof body.issueId !== "string" || !body.issueId.trim()) throw badRequest("issueId is required");
    res.json(await requests.respond(endpointId, body));
  });

  /** Spend a request handle: create the request, accept the result, or send the changes. */
  router.post("/bridge/work/request/confirm", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const token = typeof req.body?.token === "string" ? req.body.token : null;
    if (!token) throw badRequest("token is required");
    res.json(await requests.confirm(endpointId, token));
  });

  router.post("/bridge/result", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId : null;
    const resultToken = typeof req.body?.resultToken === "string" ? req.body.resultToken : null;
    const result = typeof req.body?.result === "string" ? req.body.result : null;
    if (!taskId || !resultToken || result === null) {
      throw badRequest("taskId, resultToken, and result are required");
    }
    requireUuid(taskId, "taskId");
    const updated = await bridge.submitResult(endpointId, taskId, resultToken, result);
    res.json({ taskId: updated.id, outcome: updated.outcome });
  });

  router.post("/bridge/decline", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId : null;
    const resultToken = typeof req.body?.resultToken === "string" ? req.body.resultToken : null;
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    if (!taskId || !resultToken) throw badRequest("taskId and resultToken are required");
    requireUuid(taskId, "taskId");
    const updated = await bridge.declineTask(endpointId, taskId, resultToken, reason);
    res.json({ taskId: updated.id, outcome: updated.outcome });
  });

  // -------------------------------------------------------------------------
  // Human-facing: enrollment and endpoint management
  // -------------------------------------------------------------------------

  router.get("/companies/:companyId/me/bridge/endpoints", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const endpoints = await bridge.listEndpointsForUser(companyId, userId);
    res.json({
      // No token material, ever — only the hash exists and even that stays here.
      endpoints: endpoints.map((endpoint) => ({
        id: endpoint.id,
        label: endpoint.label,
        capabilities: endpoint.capabilities,
        enrolledAt: endpoint.enrolledAt,
        lastSeenAt: endpoint.lastSeenAt,
        pendingApproval: endpoint.enrolledAt === null,
      })),
    });
  });

  /**
   * Request enrollment for a machine. Inert until approved — this creates no
   * usable credential, which is the entire point of splitting the ceremony.
   */
  router.post("/companies/:companyId/me/bridge/endpoints", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    const capabilities = Array.isArray(req.body?.capabilities)
      ? req.body.capabilities.filter((value: unknown): value is string => typeof value === "string")
      : [];

    const { enrollmentId } = await bridge.requestEnrollment(companyId, {
      userId,
      label,
      capabilities,
    });
    res.status(201).json({ enrollmentId, pendingApproval: true });
  });

  /**
   * Approve an enrollment and mint the token.
   *
   * The token is in this response and nowhere else, ever. Self-approval is
   * allowed on purpose: the human enrolling their own laptop IS the human whose
   * approval matters, and requiring a second person would make the common case
   * unusable without adding a control — anyone who can reach this route for
   * their own endpoint could equally have asked a colleague to click it.
   */
  router.post("/companies/:companyId/bridge/endpoints/:endpointId/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const endpointId = requireUuid(req.params.endpointId, "endpointId");

    const endpoints = await bridge.listEndpointsForUser(companyId, userId);
    const own = endpoints.some((endpoint) => endpoint.id === endpointId);
    if (!own && !(await isAdministrator(req, companyId))) {
      throw forbidden("Only the endpoint's owner or an administrator can approve it");
    }

    const approved = await bridge.approveEnrollment(companyId, endpointId, userId);
    res.status(201).json({ endpointId: approved.endpointId, token: approved.token });
  });

  router.post("/companies/:companyId/bridge/endpoints/:endpointId/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const endpointId = requireUuid(req.params.endpointId, "endpointId");

    const endpoints = await bridge.listEndpointsForUser(companyId, userId);
    const own = endpoints.some((endpoint) => endpoint.id === endpointId);
    if (!own && !(await isAdministrator(req, companyId))) {
      throw forbidden("Only the endpoint's owner or an administrator can revoke it");
    }

    await bridge.revokeEndpoint(companyId, endpointId, userId);
    res.json({ endpointId, revoked: true });
  });

  // -------------------------------------------------------------------------
  // Agent-facing: file a task, read its outcome
  // -------------------------------------------------------------------------

  router.post("/companies/:companyId/bridge/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);

    // Agent-authenticated only. A board user filing a task would route work to
    // someone's machine without an agent's ceiling or audit trail behind it.
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    // Parsed after authorization, so a caller who may not file tasks learns
    // nothing from a validation error. An unrecognised taskClass is refused
    // rather than read as "read": a mistyped "act" must not skip its approval.
    const { endpointId, taskClass, instruction } = createBridgeTaskSchema.parse(req.body ?? {});

    const task = await bridge.createTask(companyId, {
      endpointId,
      requestedByAgentId: req.actor.agentId,
      taskClass,
      instruction,
    });

    // An `act` task IS a stalled escalation: the agent cannot proceed until a
    // human decides. Until this call existed, the approval landed in the web
    // inbox and nothing told the steward it was there — so the stall lasted
    // until they happened to look. Delivery lives in the route rather than in
    // `createTask` for the same reason it does in the approvals routes: the
    // service layer stays acyclic, and the connectors it reaches import the
    // approvals service.
    //
    // Awaited so the request does not outlive its own side effects. The
    // delivery service swallows every failure internally, so an unreachable
    // provider cannot fail this response.
    if (task.approvalId) {
      await cardDelivery.deliverForApproval(task.approvalId);
      // The same stall, recorded durably. Card delivery reaches paired chat
      // channels only; without this an `act` task's approval never enters the
      // steward inbox, so a machine syncing from its cursor would never learn
      // it was waiting -- which is the one thing the inbox exists to prevent.
      await inbox.recordApprovalEvent(task.approvalId, "approval.opened");
    }

    // 202 for an act task: nothing has been dispatched, a human must decide.
    res.status(201).json({
      taskId: task.id,
      status: task.status,
      approvalId: task.approvalId,
      // Named so an agent does not read "created" as "done".
      awaitingApproval: task.status === "awaiting_approval",
    });
  });

  router.get("/companies/:companyId/bridge/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    const tasks = await bridge.listTasksForAgent(companyId, req.actor.agentId);
    res.json({
      tasks: tasks.map((task) => ({
        id: task.id,
        taskClass: task.taskClass,
        status: task.status,
        outcome: task.outcome,
        declineReason: task.declineReason,
        // Already framed as untrusted when it was stored.
        result: task.result,
        completedAt: task.completedAt,
      })),
    });
  });

  return router;
}
