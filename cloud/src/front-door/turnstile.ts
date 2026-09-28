// AgentDash (SC-7, GH #768): Cloudflare Turnstile on /start and /find
// (spec §5.1). The widget's token is checked server-side with the secret key.
// Any transport error or unexpected answer counts as a failed check.
import type { Secret } from "../secret.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(
  secret: Secret,
  token: unknown,
  remoteIp: string | null,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const f = opts.fetch ?? fetch;
  const form = new URLSearchParams({ secret: secret.reveal(), response: token });
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const res = await f(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { success?: unknown };
    return body.success === true;
  } catch {
    return false;
  }
}
