// AgentDash: the per-run lifecycle API surface (spike R4). Owns the wire
// contract (zod), company scoping, idempotency, ordering and audit;
// delegates everything guest-facing to the SandboxDriver.
//
// Company scoping: the service resolves the sandbox per request companyId
// through `resolveDriver`; an unknown company is refused before any guest
// call. One sandbox per company (R1) means a request can only ever reach
// that company's own VM.
//
// Idempotency: every mutating call except `clear` carries idempotencyKey.
// The first result (success only — a retry may legitimately succeed later)
// is stored under (operation, companyId, key); a retry with the SAME body
// replays the stored response, a retry with a DIFFERENT body is a conflict.
// Concurrent same-key calls join the in-flight promise instead of running
// the guest op twice. `clear` is deliberately NOT cached: it must always
// execute, because a wedged or half-torn-down sandbox must be re-cleanable.
// The store is a Map in the spike — Phase 1 puts it in the control-plane DB
// so a restart can't double-apply.
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

/** Best-effort companyId for auditing requests too malformed to parse. */
function auditCompanyId(raw: unknown): string {
  const c = raw && typeof raw === "object" ? (raw as { companyId?: unknown }).companyId : undefined;
  return typeof c === "string" && c.length > 0 ? c.slice(0, 128) : "unknown";
}

function errorCode(err: unknown): string {
  return err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "internal";
}

export function createSandboxLifecycleService(opts: {
  /** Resolve the sandbox for a company; null = no sandbox registered. */
  resolveDriver: (companyId: string) => SandboxDriver | null;
  audit?: (rec: SandboxAuditRecord) => void;
  now?: () => Date;
}): SandboxLifecycleService {
  const idem = new Map<string, IdemEntry>();
  const inflight = new Map<string, { requestSha256: string; promise: Promise<unknown> }>();
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

  function conflict(
    operation: SandboxAuditRecord["operation"],
    req: { companyId: string; idempotencyKey: string },
  ): never {
    audit(operation, req.companyId, req.idempotencyKey, req, "error", {
      errorCode: "idempotency_conflict",
    });
    throw new LifecycleError(
      "idempotency_conflict",
      `idempotencyKey already used for ${operation} with a different body`,
      409,
    );
  }

  /**
   * Dispatch: schema-parse (audited on failure) -> company resolution ->
   * replay/in-flight check -> run -> store. Every path emits exactly one
   * audit record, including requests rejected before reaching a guest.
   */
  async function dispatch<I, O>(
    operation: SandboxAuditRecord["operation"],
    schema: z.ZodType<I>,
    responseSchema: z.ZodType<O>,
    rawReq: unknown,
    run: (req: I & { companyId: string; idempotencyKey: string }, driver: SandboxDriver) => Promise<O>,
    { idempotent = true }: { idempotent?: boolean } = {},
  ): Promise<O> {
    const parsed = schema.safeParse(rawReq);
    if (!parsed.success) {
      audit(operation, auditCompanyId(rawReq), null, rawReq, "error", {
        errorCode: "invalid_request",
      });
      throw new LifecycleError("invalid_request", parsed.error.issues.map((i) => i.message).join("; "), 400);
    }
    const req = parsed.data as I & { companyId: string; idempotencyKey: string };
    const driver = opts.resolveDriver(req.companyId);
    if (!driver) {
      audit(operation, req.companyId, req.idempotencyKey ?? null, req, "error", {
        errorCode: "unknown_company",
      });
      throw new LifecycleError("unknown_company", `no sandbox registered for company ${req.companyId}`, 404);
    }
    const digest = requestDigest(req);
    const key = `${operation}:${req.companyId}:${req.idempotencyKey}`;

    if (!idempotent) {
      // `clear`: always execute, always audit — never replayed or cached.
      try {
        const response = responseSchema.parse(await run(req, driver));
        audit(operation, req.companyId, req.idempotencyKey, req, "ok");
        return response;
      } catch (err) {
        audit(operation, req.companyId, req.idempotencyKey, req, "error", { errorCode: errorCode(err) });
        throw err;
      }
    }

    const prior = idem.get(key);
    if (prior) {
      if (prior.requestSha256 !== digest) return conflict(operation, req);
      audit(operation, req.companyId, req.idempotencyKey, req, "replayed");
      return prior.response as O;
    }
    const flight = inflight.get(key);
    if (flight) {
      if (flight.requestSha256 !== digest) return conflict(operation, req);
      try {
        const response = (await flight.promise) as O;
        audit(operation, req.companyId, req.idempotencyKey, req, "replayed");
        return response;
      } catch (err) {
        audit(operation, req.companyId, req.idempotencyKey, req, "error", { errorCode: errorCode(err) });
        throw err;
      }
    }
    const promise = (async () => responseSchema.parse(await run(req, driver)))();
    inflight.set(key, { requestSha256: digest, promise });
    try {
      const response = await promise;
      idem.set(key, { requestSha256: digest, response });
      audit(operation, req.companyId, req.idempotencyKey, req, "ok");
      return response;
    } catch (err) {
      audit(operation, req.companyId, req.idempotencyKey, req, "error", { errorCode: errorCode(err) });
      throw err;
    } finally {
      inflight.delete(key);
    }
  }

  return {
    openHandshake: (req) =>
      dispatch("openHandshake", openHandshakeRequest, openHandshakeResponse, req, (r, driver) =>
        driver.openHandshake({ side: r.side, sessionId: r.sessionId }),
      ),

    async listHandshakeSessions(req) {
      const parsed = listHandshakesRequest.safeParse(req);
      if (!parsed.success) {
        audit("listHandshakeSessions", auditCompanyId(req), null, req, "error", {
          errorCode: "invalid_request",
        });
        throw new LifecycleError("invalid_request", parsed.error.issues.map((i) => i.message).join("; "), 400);
      }
      const driver = opts.resolveDriver(parsed.data.companyId);
      if (!driver) {
        audit("listHandshakeSessions", parsed.data.companyId, null, parsed.data, "error", {
          errorCode: "unknown_company",
        });
        throw new LifecycleError(
          "unknown_company",
          `no sandbox registered for company ${parsed.data.companyId}`,
          404,
        );
      }
      const response = listHandshakesResponse.parse(await driver.listHandshakes());
      audit("listHandshakeSessions", parsed.data.companyId, null, parsed.data, "ok");
      return response;
    },

    applyRunConfig: (req) =>
      dispatch("applyRunConfig", applyRunConfigRequest, applyRunConfigResponse, req, (r, driver) =>
        driver.applyRunConfig({
          runId: r.runId,
          sessionId: r.sessionId,
          agentConfigRevision: r.agentConfigRevision,
        }),
      ),

    installSinkToken: (req) =>
      dispatch("installSinkToken", installSinkTokenRequest, installSinkTokenResponse, req, async (r, driver) => {
        const { tokenDigest } = await driver.installSinkToken({
          runId: r.runId,
          sealedTokenB64: r.sealedTokenB64,
        });
        return { runId: r.runId, installed: true as const, tokenDigest };
      }),

    clear: (req) =>
      // `clear` is always callable — including on a wedged or fully-torn-down
      // sandbox — so it never consults the idempotency store: every call
      // executes against the guest and every call is audited.
      dispatch("clear", clearRequest, clearResponse, req, (r, driver) => driver.clear({ runId: r.runId }), {
        idempotent: false,
      }),

    auditLog: () => [...audits],
  };
}
