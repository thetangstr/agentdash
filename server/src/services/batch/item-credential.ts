import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { BATCH_ITEM_CREDENTIAL_TTL_MS, BATCH_ITEM_TOKEN_PREFIX, type BatchOrigin } from "@paperclipai/shared";

/**
 * AgentDash admin powers, part 2: the credential one batch item is sent with.
 *
 * Each item of a confirmed batch is one internal HTTP request to the record's
 * existing single-record route over this server's own listener, so the route's
 * validator, visibility hook, guards, service, activity rows and wakeups all
 * run exactly as they do for a person clicking in the product. That request
 * carries a `pcbx_` token minted here, a copy of the `pcin_` precedent
 * (assistant-loopback.ts), narrowed further:
 *
 * - bound to exactly one (method, normalized path, sha256 of the canonical
 *   JSON body); the middleware refuses any mismatch with 403;
 * - single use: the first resolve deletes it, whatever happens next;
 * - lives 30 seconds at most;
 * - in-process only: never persisted, never sent to a client, never logged.
 *
 * The actor it resolves to is a frozen copy of the confirming person (their
 * own session, membership role and instance-admin flag, read fresh by the
 * runner before each item), never a service identity. So a batch item can do
 * exactly what that person could do through the single route, and nothing else.
 */

/** The proof the confirming request was authenticated with, re-validated by the routes that check it. */
export type BatchItemCredentialOrigin =
  | { kind: "session"; sessionId: string; userId: string }
  | { kind: "local_implicit" };

export interface BatchItemBinding {
  method: string;
  path: string;
  bodyDigest: string;
}

export interface BatchItemIdentity {
  batchId: string;
  itemId: string;
  companyId: string;
  origin: BatchOrigin;
  credential: BatchItemCredentialOrigin;
  actor: Request["actor"];
  binding: BatchItemBinding;
}

interface Entry extends BatchItemIdentity {
  expiresAt: number;
}

const MAX_ENTRIES = 10_000;
const entries = new Map<string, Entry>();

/** JSON with object keys sorted at every depth, so equal values give equal digests. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function batchItemBodyDigest(body: unknown): string {
  return sha256Hex(canonicalJson(body ?? null));
}

/** Path without query string or trailing slash, the same normalization the auth middleware applies. */
export function normalizeBatchItemPath(path: string): string {
  const raw = path.split("?")[0] ?? "";
  return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function sweepExpired(now: number) {
  for (const [token, entry] of entries) if (entry.expiresAt <= now) entries.delete(token);
}

function frozenActor(actor: Request["actor"]): Request["actor"] {
  return Object.freeze({
    ...actor,
    ...(actor.companyIds ? { companyIds: Object.freeze([...actor.companyIds]) as string[] } : {}),
    ...(actor.memberships
      ? { memberships: Object.freeze(actor.memberships.map((membership) => Object.freeze({ ...membership }))) as Request["actor"]["memberships"] }
      : {}),
  });
}

export function mintBatchItemCredential(identity: BatchItemIdentity): string {
  const now = Date.now();
  if (entries.size >= MAX_ENTRIES) sweepExpired(now);
  if (entries.size >= MAX_ENTRIES) throw new Error("Too many batch item credentials in flight");
  const token = `${BATCH_ITEM_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  entries.set(token, {
    ...identity,
    credential: { ...identity.credential },
    actor: frozenActor(identity.actor),
    binding: { ...identity.binding, method: identity.binding.method.toUpperCase(), path: normalizeBatchItemPath(identity.binding.path) },
    expiresAt: now + BATCH_ITEM_CREDENTIAL_TTL_MS,
  });
  return token;
}

/** Resolves and spends the credential. A second call with the same token returns null. */
export function consumeBatchItemCredential(token: string): BatchItemIdentity | null {
  const entry = entries.get(token);
  if (!entry) return null;
  entries.delete(token);
  if (entry.expiresAt <= Date.now()) return null;
  const { expiresAt: _expiresAt, ...identity } = entry;
  return identity;
}

/** Drops a credential that was minted but never sent (for example, the request could not be started). */
export function revokeBatchItemCredential(token: string): void {
  entries.delete(token);
}

/** Test isolation: the registry is module-level state. */
export function resetBatchItemCredentials(): void {
  entries.clear();
}

export function batchItemCredentialCount(): number {
  return entries.size;
}
