// AgentDash: the per-run lifecycle API surface (spike R4). Owns the wire
// contract (zod), idempotency, ordering and audit; delegates everything
// guest-facing to the SandboxDriver.
//
// Idempotency: every mutating call carries idempotencyKey. The first result
// (success or error) is stored under (operation, companyId, key); a retry
// with the SAME body replays the stored response, a retry with a DIFFERENT
// body is a conflict. The store is a Map in the spike — Phase 1 puts it in
// the control-plane DB so a restart can't double-apply.
//
// Ordering is enforced twice: here (cheap rejection, better errors) and in
// the guest (sandbox-ctl.mjs re-checks, so a replayed/out-of-order control
// plane can't corrupt guest state).
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SandboxDriver } from "./driver.js";
import {
  applyRunConfigRequest,
  applyRunConfigResponse,
  clearRequest,
  clearResponse,
  installSinkTokenRequest,
  installSinkTokenResponse,
  listHandshakesRequest,
  listHandshakesResponse,
  openHandshakeRequest,
  openHandshakeResponse,
  sandboxAuditRecord,
  type ListHandshakesResponse,
  type SandboxAuditRecord,
} from "./schemas.js";

export class LifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

/** Canonical JSON (sorted keys) so request digests are stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function requestDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface SandboxLifecycleService {
  openHandshake(req: unknown): Promise<ReturnType<typeof openHandshakeResponse.parse>>;
  listHandshakeSessions(req: unknown): Promise<ListHandshakesResponse>;
  applyRunConfig(req: unknown): Promise<ReturnType<typeof applyRunConfigResponse.parse>>;
  installSinkToken(req: unknown): Promise<ReturnType<typeof installSinkTokenResponse.parse>>;
  clear(req: unknown): Promise<ReturnType<typeof clearResponse.parse>>;
  auditLog(): SandboxAuditRecord[];
}

interface IdemEntry {
  requestSha256: string;
  response: unknown;
}

export function createSandboxLifecycleService(opts: {
  driver: SandboxDriver;
  audit?: (rec: SandboxAuditRecord) => void;
  now?: () => Date;
}): SandboxLifecycleService {
  const idem = new Map<string, IdemEntry>();
  const audits: SandboxAuditRecord[] = [];
  const now = opts.now ?? (() => new Date());
  const emit =
    opts.audit ??
    ((rec: SandboxAuditRecord) => {
      audits.push(rec);
    });

  function audit(
    operation: SandboxAuditRecord["operation"],
    companyId: string,
    idempotencyKey: string | null,
    request: unknown,
    outcome: SandboxAuditRecord["outcome"],
    extra: { errorCode?: string; detail?: string } = {},
  ) {
    emit(
      sandboxAuditRecord.parse({
        auditId: randomUUID(),
        at: now().toISOString(),
        companyId,
        operation,
        idempotencyKey,
        requestSha256: requestDigest(request),
        outcome,
        ...extra,
      }),
    );
  }

  /**
   * Idempotent dispatch: parse -> replay-check -> run -> store. Errors during
   * the run are audited and rethrown (a retry may legitimately succeed later,
   * e.g. the session arriving after the config call is NOT idempotent-safe
   * to replay, so errors are never cached).
   */
  async function dispatch<I, O>(
    operation: SandboxAuditRecord["operation"],
    schema: z.ZodType<I>,
    responseSchema: z.ZodType<O>,
    rawReq: unknown,
    run: (req: I & { companyId: string; idempotencyKey: string }) => Promise<O>,
  ): Promise<O> {
    const parsed = schema.safeParse(rawReq);
    if (!parsed.success) {
      throw new LifecycleError("invalid_request", parsed.error.issues.map((i) => i.message).join("; "), 400);
    }
    const req = parsed.data as I & { companyId: string; idempotencyKey: string };
    const digest = requestDigest(req);
    const key = `${operation}:${req.companyId}:${req.idempotencyKey}`;
    const prior = idem.get(key);
    if (prior) {
      if (prior.requestSha256 !== digest) {
        audit(operation, req.companyId, req.idempotencyKey, req, "error", {
          errorCode: "idempotency_conflict",
        });
        throw new LifecycleError(
          "idempotency_conflict",
          `idempotencyKey already used for ${operation} with a different body`,
          409,
        );
      }
      audit(operation, req.companyId, req.idempotencyKey, req, "replayed");
      return prior.response as O;
    }
    try {
      const response = responseSchema.parse(await run(req));
      idem.set(key, { requestSha256: digest, response });
      audit(operation, req.companyId, req.idempotencyKey, req, "ok");
      return response;
    } catch (err) {
      const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "internal";
      audit(operation, req.companyId, req.idempotencyKey, req, "error", { errorCode: code });
      throw err;
    }
  }

  return {
    openHandshake: (req) =>
      dispatch("openHandshake", openHandshakeRequest, openHandshakeResponse, req, (r) =>
        opts.driver.openHandshake({ side: r.side, sessionId: r.sessionId }),
      ),

    async listHandshakeSessions(req) {
      const parsed = listHandshakesRequest.safeParse(req);
      if (!parsed.success) {
        throw new LifecycleError("invalid_request", parsed.error.issues.map((i) => i.message).join("; "), 400);
      }
      const response = listHandshakesResponse.parse(await opts.driver.listHandshakes());
      audit("listHandshakeSessions", parsed.data.companyId, null, parsed.data, "ok");
      return response;
    },

    applyRunConfig: (req) =>
      dispatch("applyRunConfig", applyRunConfigRequest, applyRunConfigResponse, req, (r) =>
        opts.driver.applyRunConfig({
          runId: r.runId,
          sessionId: r.sessionId,
          agentConfigRevision: r.agentConfigRevision,
        }),
      ),

    installSinkToken: (req) =>
      dispatch("installSinkToken", installSinkTokenRequest, installSinkTokenResponse, req, async (r) => {
        const { tokenDigest } = await opts.driver.installSinkToken({
          runId: r.runId,
          sealedTokenB64: r.sealedTokenB64,
        });
        return { runId: r.runId, installed: true as const, tokenDigest };
      }),

    clear: (req) =>
      // `clear` is always callable — including on a fully-torn-down sandbox —
      // so it is deliberately the one op with no precondition beyond schema.
      dispatch("clear", clearRequest, clearResponse, req, (r) => opts.driver.clear({ runId: r.runId })),

    auditLog: () => [...audits],
  };
}
