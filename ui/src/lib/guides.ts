/**
 * In-app guides, bundled from `docs/guides` at build time.
 *
 * One source for two readers: the public docs site lists these same files in
 * `docs/docs.json`, and the app renders them here. That is the point — a guide
 * that lives in the product cannot drift from the product, and a guide that
 * lives only in the product cannot be read before you have an account.
 *
 * Only the steward set and the two admin pages that pair with it are bundled.
 * The wider board-operator set assumes the docs site's link structure and
 * images; pulling it in wholesale would ship broken links.
 *
 * Instance-specific facts never appear in the markdown. The one that matters —
 * the address a person should use — is a token, `{{instanceUrl}}`, that the
 * page substitutes with what this instance publishes, so the same file is right
 * on every instance and no address is ever hard-coded in a guide.
 */

export const INSTANCE_URL_TOKEN = "{{instanceUrl}}";

export type GuideAudience = "steward" | "admin" | "all";

export interface Guide {
  /** Directory under docs/guides, e.g. `steward`. */
  group: string;
  /** File name without extension, e.g. `connect-your-terminal`. */
  slug: string;
  title: string;
  summary: string;
  audience: GuideAudience;
  order: number;
  /** Markdown body with the front matter removed, tokens NOT yet substituted. */
  body: string;
}

const guideModules = import.meta.glob(
  [
    "../../../docs/guides/steward/*.md",
    "../../../docs/guides/board-operator/onboard-a-steward.md",
    "../../../docs/guides/board-operator/agent-kinds-and-stewardship.md",
  ],
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontMatter(markdown: string): { fields: Record<string, string>; body: string } {
  const match = FRONT_MATTER.exec(markdown);
  if (!match) return { fields: {}, body: markdown };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body: markdown.slice(match[0].length) };
}

function audienceFrom(value: string | undefined): GuideAudience {
  return value === "steward" || value === "admin" ? value : "all";
}

/** `../../../docs/guides/steward/your-inbox.md` → { group: "steward", slug: "your-inbox" }. */
export function guideLocation(path: string): { group: string; slug: string } {
  const parts = path.split("/");
  const file = parts[parts.length - 1] ?? "";
  const group = parts[parts.length - 2] ?? "";
  return { group, slug: file.replace(/\.md$/, "") };
}

export function parseGuideMarkdown(path: string, markdown: string): Guide {
  const { fields, body } = parseFrontMatter(markdown);
  const { group, slug } = guideLocation(path);
  const order = Number.parseInt(fields.order ?? "", 10);
  return {
    group,
    slug,
    title: fields.title ?? slug,
    summary: fields.summary ?? "",
    audience: audienceFrom(fields.audience),
    order: Number.isNaN(order) ? Number.MAX_SAFE_INTEGER : order,
    body: body.trim(),
  };
}

export function listGuides(): Guide[] {
  return Object.entries(guideModules)
    .map(([path, markdown]) => parseGuideMarkdown(path, markdown))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export function getGuide(group: string, slug: string): Guide | null {
  return listGuides().find((guide) => guide.group === group && guide.slug === slug) ?? null;
}

/**
 * Put this instance's address into a guide body.
 *
 * `instanceUrl` is what the instance publishes (`publicBaseUrl` from
 * `/api/health`), falling back to the browser's own origin when nothing is
 * published — the same rule the connect command uses.
 */
export function renderGuide(body: string, context: { instanceUrl: string }): string {
  const instanceUrl = context.instanceUrl.trim().replace(/\/+$/, "");
  return body.split(INSTANCE_URL_TOKEN).join(instanceUrl);
}

/** Every `{{…}}` token in a body. Used by tests to refuse unknown tokens. */
export function tokensIn(body: string): string[] {
  return Array.from(body.matchAll(/\{\{[^}]*\}\}/g), (match) => match[0]);
}

/** Relative links between guides (`./slug`, `../group/slug`), resolved against the guide's group. */
export function guideLinks(guide: Guide): Array<{ group: string; slug: string; raw: string }> {
  const links: Array<{ group: string; slug: string; raw: string }> = [];
  for (const match of guide.body.matchAll(/\]\((\.{1,2}\/[^)#\s]+)(?:#[^)\s]*)?\)/g)) {
    const raw = match[1]!;
    if (raw.startsWith("./")) {
      links.push({ group: guide.group, slug: raw.slice(2), raw });
    } else {
      const [, group, slug] = raw.split("/");
      if (group && slug) links.push({ group, slug, raw });
    }
  }
  return links;
}
