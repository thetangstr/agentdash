// AgentDash (SC-7, GH #768): which email addresses may sign up (spec §5.1).
//   - disposable domains are refused: the maintained disposable-email-domains
//     list (through disposable-email-domains-js, CC0) plus operator overrides;
//   - the domain must have MX records (checked live, with a timeout);
//   - freemail domains are exempt from the per-domain daily cap, which exists
//     to stop one company domain from taking many boxes.
import { resolveMx } from "node:dns/promises";
import { disposableEmailBlocklistSet } from "disposable-email-domains-js";

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

/** Lower-cased and trimmed, or null when it is not an address we accept. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Large consumer mail providers: many unrelated people share each domain. */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.co.jp", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com", "zoho.com",
  "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com", "126.com", "naver.com", "hey.com", "fastmail.com",
  "tutanota.com", "tuta.io",
]);

export function isFreemail(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain);
}

let blocklist: Set<string> | null = null;
function disposableSet(): Set<string> {
  blocklist ??= disposableEmailBlocklistSet();
  return blocklist;
}

/** True for a listed domain or any subdomain of one, unless the operator allowed it. */
export function isDisposableDomain(domain: string, opts: { extra?: string[]; allow?: string[] } = {}): boolean {
  const allow = new Set(opts.allow ?? []);
  const extra = new Set(opts.extra ?? []);
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    if (allow.has(candidate)) return false;
    if (extra.has(candidate) || disposableSet().has(candidate)) return true;
  }
  return false;
}

export type MxResolver = (domain: string) => Promise<Array<{ exchange: string }>>;

/**
 * True when the domain publishes at least one usable MX record. A lookup that
 * fails or times out counts as no MX: the signup is refused with a message
 * that asks the person to check the address (fail closed).
 */
export async function hasMx(domain: string, opts: { resolve?: MxResolver; timeoutMs?: number } = {}): Promise<boolean> {
  const resolve = opts.resolve ?? resolveMx;
  let timer: NodeJS.Timeout | undefined;
  try {
    const records = await Promise.race([
      resolve(domain),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("mx lookup timed out")), opts.timeoutMs ?? 4000);
        timer.unref();
      }),
    ]);
    // A "null MX" (RFC 7505: a single record with exchange ".") means the domain takes no mail.
    return records.some((r) => r.exchange && r.exchange !== ".");
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
