/**
 * Detect that the server is serving a newer frontend than this tab is running.
 *
 * The problem this solves cost a steward real time: after a deploy, an open tab
 * keeps its old JavaScript. The old bundle carried an old capability fallback,
 * so the instructions tab rendered "only available for local adapters" — a dead
 * end that looked exactly like the bug that deploy had just fixed. Nothing in
 * the app noticed, so the only way out was knowing to hard-refresh.
 *
 * No server change and no build-time injection: the built entry script already
 * has a content hash in its filename, so comparing this tab's script URL with
 * the one the server is currently advertising in `index.html` is a complete
 * answer. A changed hash means a different build; an unchanged one means there
 * is nothing to tell anybody.
 *
 * **It never reloads on its own.** A steward may be halfway through writing a
 * mandate, and an unsaved draft lives only in this tab — reloading to fix a
 * cosmetic staleness problem would destroy the exact work this product most
 * wants people to do. So this reports, and a person decides.
 */

/** How often to look. Rare on purpose: a deploy is not a per-second event. */
export const FRESHNESS_POLL_MS = 5 * 60 * 1000;

const MODULE_SCRIPT = /<script[^>]+type=["']module["'][^>]*src=["']([^"']+)["']/i;
const MODULE_SCRIPT_SRC_FIRST = /<script[^>]+src=["']([^"']+)["'][^>]*type=["']module["']/i;

/** The entry script URL this tab is actually running, or null if unknowable. */
export function runningEntryScript(doc: Document = document): string | null {
  const scripts = [...doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')];
  // The entry is the hashed asset; ignore anything injected later by tooling.
  const entry = scripts.find((script) => /\/assets\/index-[^/]+\.js/.test(script.src));
  const chosen = entry ?? scripts[0];
  if (!chosen) return null;
  try {
    return new URL(chosen.src, doc.baseURI).pathname;
  } catch {
    return null;
  }
}

/** The entry script URL the server is advertising right now, or null. */
export function parseEntryScript(html: string): string | null {
  const match = MODULE_SCRIPT.exec(html) ?? MODULE_SCRIPT_SRC_FIRST.exec(html);
  if (!match?.[1]) return null;
  try {
    return new URL(match[1], "http://placeholder.invalid").pathname;
  } catch {
    return match[1];
  }
}

export interface FreshnessDeps {
  fetchImpl?: typeof fetch;
  doc?: Document;
}

/**
 * True when the server is serving a different build than this tab is running.
 *
 * Every uncertainty answers false. A failed fetch, an unparseable document, a
 * dev server with no hashed entry — none of those are evidence of a new deploy,
 * and telling somebody to reload on a network blip is worse than staying quiet.
 */
export async function isStale(deps: FreshnessDeps = {}): Promise<boolean> {
  const doc = deps.doc ?? document;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const running = runningEntryScript(doc);
  if (!running) return false;

  try {
    const res = await fetchImpl(`${doc.baseURI.replace(/\/+$/, "")}/index.html`, {
      cache: "no-store",
      headers: { accept: "text/html" },
    });
    if (!res.ok) return false;
    const deployed = parseEntryScript(await res.text());
    if (!deployed) return false;
    return deployed !== running;
  } catch {
    return false;
  }
}
