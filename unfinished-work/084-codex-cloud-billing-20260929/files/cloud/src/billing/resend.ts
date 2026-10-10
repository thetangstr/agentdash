// AgentDash (SC-8): management API only. Box keys are sending-only and domain-restricted.
import type { Secret } from "../secret.js";

export interface ResendKey { id: string; name: string }
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
export function resendClient(key: Secret, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}) {
  async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    try {
      const response = await (opts.fetch ?? fetch)(`https://api.resend.com/${path}`, { method, redirect: "error", signal: opts.signal ?? AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${key.reveal()}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (method === "DELETE" && response.status === 404) return { deleted: true } as T;
      if (!response.ok) throw new Error();
      return await response.json() as T;
    } catch { throw new Error("Resend request failed"); }
  }
  return {
    async verifyDomain(id: string) {
      if (!SAFE_ID.test(id)) throw new Error("Resend domain ID invalid");
      const domain = await call<{ id: string; name: string; status: string }>(`domains/${id}`);
      if (domain.id !== id || domain.name !== "mail.agentdash.cloud" || domain.status !== "verified") throw new Error("Resend domain must be verified mail.agentdash.cloud");
    },
    async list(): Promise<ResendKey[]> {
      const keys: ResendKey[] = []; let after: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const result = await call<{ data: ResendKey[]; has_more: boolean }>(`api-keys?limit=100${after ? `&after=${after}` : ""}`);
        if (!Array.isArray(result.data) || result.data.some((k) => !SAFE_ID.test(k.id) || typeof k.name !== "string")) throw new Error("Resend key listing invalid");
        keys.push(...result.data);
        if (!result.has_more) return keys;
        const next = result.data.at(-1)?.id;
        if (!next || next === after) throw new Error("Resend key pagination invalid");
        after = next;
      }
      throw new Error("Resend key pagination exceeded");
    },
    async create(name: string, domainId: string) {
      if (!SAFE_ID.test(domainId) || name.length > 50) throw new Error("Resend key request invalid");
      const created = await call<{ id: string; token: string }>("api-keys", "POST", { name, permission: "sending_access", domain_id: domainId });
      if (!SAFE_ID.test(created.id) || !/^re_[A-Za-z0-9_-]+$/.test(created.token)) throw new Error("Resend key response invalid");
      return created;
    },
    async revoke(id: string) {
      if (!SAFE_ID.test(id)) throw new Error("Resend key ID invalid");
      const result = await call<{ deleted: boolean }>(`api-keys/${id}`, "DELETE");
      if (result.deleted !== true) throw new Error("Resend revocation unconfirmed");
    },
  };
}
