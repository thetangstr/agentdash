// AgentDash (SC-8, GH #769): one sending-only Resend API key per box,
// restricted to the verified box mail domain (spec §3.7), revoked when the
// box is deleted (§6.5). The control plane holds a full-access key only to
// create and revoke these; it keeps each box key's ID, never the key.
//
// Each box key is named `agentdash-box-<slug>`, so a key whose ID was never
// recorded (a crash between Resend's answer and our write) is still found
// and revoked by name before a new one is made.
import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes } from "../db/schema.js";
import type { BoxRow } from "../jobs/runner.js";
import type { Secret } from "../secret.js";

export const RESEND_API = "https://api.resend.com";

export interface ResendKeysClient {
  create(input: { name: string; domainId: string }, signal?: AbortSignal): Promise<{ id: string; token: string }>;
  list(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>>;
  /** "not_found" when the key is already gone. */
  remove(id: string, signal?: AbortSignal): Promise<"deleted" | "not_found">;
}

export class ResendApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    // Never the response body: it may echo what was sent.
    super(`Resend ${operation} failed: HTTP ${status}`);
    this.name = "ResendApiError";
  }
}

const KEY_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** The real client: Resend's REST API with the full-access key, which is revealed only into the header. */
export function resendKeysClient(opts: { apiKey: Secret; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }): ResendKeysClient {
  const f = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? RESEND_API).replace(/\/+$/, "");
  const call = async (operation: string, method: string, path: string, body?: unknown, signal?: AbortSignal) => {
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 15_000)];
    if (signal) signals.push(signal);
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${opts.apiKey.reveal()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch {
      throw new ResendApiError(operation, 0);
    }
    return res;
  };
  return {
    async create(input, signal) {
      const res = await call("api-keys create", "POST", "/api-keys", { name: input.name, permission: "sending_access", domain_id: input.domainId }, signal);
      if (!res.ok) throw new ResendApiError("api-keys create", res.status);
      const j = (await res.json().catch(() => null)) as { id?: unknown; token?: unknown } | null;
      if (!j || typeof j.id !== "string" || typeof j.token !== "string" || !j.token.startsWith("re_")) throw new ResendApiError("api-keys create (unexpected answer)", res.status);
      return { id: j.id, token: j.token };
    },
    async list(signal) {
      const res = await call("api-keys list", "GET", "/api-keys", undefined, signal);
      if (!res.ok) throw new ResendApiError("api-keys list", res.status);
      const j = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown; name?: unknown }> } | null;
      return (j?.data ?? []).filter((k) => typeof k.id === "string" && typeof k.name === "string").map((k) => ({ id: k.id as string, name: k.name as string }));
    },
    async remove(id, signal) {
      if (!KEY_ID_RE.test(id)) throw new Error("not a Resend API key id");
      const res = await call("api-keys delete", "DELETE", `/api-keys/${encodeURIComponent(id)}`, undefined, signal);
      if (res.status === 404) return "not_found";
      if (!res.ok) throw new ResendApiError("api-keys delete", res.status);
      return "deleted";
    },
  };
}

export function boxResendKeyName(slug: string): string {
  return `agentdash-box-${slug}`;
}

/** Revoke every key carrying the box's name, plus the recorded one. Returns how many were revoked. */
async function revokeAllFor(client: ResendKeysClient, box: Pick<BoxRow, "slug" | "resendKeyId">, signal?: AbortSignal): Promise<number> {
  const name = boxResendKeyName(box.slug);
  const ids = new Set((await client.list(signal)).filter((k) => k.name === name).map((k) => k.id));
  if (box.resendKeyId) ids.add(box.resendKeyId);
  let n = 0;
  for (const id of ids) if ((await client.remove(id, signal)) === "deleted") n += 1;
  return n;
}

/**
 * Make the box a new sending-only key (revoking any earlier one first) and
 * record its ID. Returns the key for the box's RESEND_API_KEY; the caller
 * puts it into Railway and nowhere else.
 */
export async function provisionBoxResendKey(
  db: CloudDb,
  client: ResendKeysClient,
  box: Pick<BoxRow, "id" | "slug" | "resendKeyId">,
  domainId: string,
  signal?: AbortSignal,
): Promise<string> {
  const revoked = await revokeAllFor(client, box, signal);
  const key = await client.create({ name: boxResendKeyName(box.slug), domainId }, signal);
  await db.update(boxes).set({ resendKeyId: key.id, updatedAt: new Date() }).where(eq(boxes.id, box.id));
  await db.insert(boxEvents).values({ boxId: box.id, kind: "resend_key_created", actor: "provisioner", detail: { keyId: key.id, revokedEarlier: revoked } });
  return key.token;
}

/** Revoke the box's Resend key(s) and forget the ID (spec §6.5). Safe to repeat. */
export async function revokeBoxResendKey(
  db: CloudDb,
  client: ResendKeysClient,
  box: Pick<BoxRow, "id" | "slug" | "resendKeyId">,
  actor: string,
  signal?: AbortSignal,
): Promise<number> {
  const revoked = await revokeAllFor(client, box, signal);
  if (box.resendKeyId) {
    await db.update(boxes).set({ resendKeyId: null, updatedAt: new Date() }).where(and(eq(boxes.id, box.id), eq(boxes.resendKeyId, box.resendKeyId)));
  }
  await db.insert(boxEvents).values({ boxId: box.id, kind: "resend_key_revoked", actor, detail: { keyId: box.resendKeyId, revoked } });
  return revoked;
}
