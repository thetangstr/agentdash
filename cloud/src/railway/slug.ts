// AgentDash: box slug rules, ported from scripts/hosted/lib.sh
// (validate_slug, validate_new_slug) plus the reserved list of spec §3.3.
export const BOX_SLUG_MAX = 16;

/** Names a customer can never take: our own hosts, brand and abuse terms. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www", "app", "api", "hq", "mcp", "cloud", "admin", "status", "mail", "support", "docs", "edge", "staging",
  "agentdash", "paperclip", "billing", "auth", "login", "signin", "signup", "start", "find", "claim", "dashboard",
  "account", "accounts", "root", "system", "security", "abuse", "postmaster", "hostmaster", "webmaster", "noreply",
  "no-reply", "help", "blog", "dev", "test", "demo", "internal", "ops", "cdn", "static", "assets", "ftp", "smtp",
  "imap", "pop", "ns1", "ns2", "railway", "vercel", "stripe", "resend", "official", "verify",
]);

export class SlugRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlugRefused";
  }
}

/** lib.sh validate_slug: 3-32 chars of a-z, 0-9 and '-', starting with a letter, not ending with '-'. */
export function validateSlug(slug: string): void {
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) || slug.length > 32) {
    throw new SlugRefused("slug must be 3-32 chars of a-z, 0-9 and '-', starting with a letter");
  }
}

/**
 * lib.sh validate_new_slug: new box slugs are at most 16 characters so the
 * restore project "<slug>-restore" is itself a valid slug; plus the reserved
 * list (spec §3.3 step 1).
 */
export function validateNewSlug(slug: string): void {
  validateSlug(slug);
  if (slug.endsWith("-restore")) {
    if (slug.length > BOX_SLUG_MAX + 8) {
      throw new SlugRefused(`restore slugs are '<box slug>-restore' with a box slug of at most ${BOX_SLUG_MAX} chars`);
    }
  } else if (slug.length > BOX_SLUG_MAX) {
    throw new SlugRefused(`new box slugs are at most ${BOX_SLUG_MAX} chars (so '<slug>-restore' can always be created)`);
  }
  if (RESERVED_SLUGS.has(slug) || RESERVED_SLUGS.has(slug.replace(/-restore$/, ""))) {
    throw new SlugRefused(`'${slug}' is reserved`);
  }
}
