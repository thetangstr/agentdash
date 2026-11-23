import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { AdapterModel } from "./types.js";
import { models as builtInCodexModels } from "@paperclipai/adapter-codex-local";
import { resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "@paperclipai/adapter-codex-local/server";
import { readConfigFile } from "../config-file.js";

const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const OPENAI_MODELS_TIMEOUT_MS = 5000;
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;

let cached: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;

function fingerprint(apiKey: string): string {
  return `${apiKey.length}:${apiKey.slice(-6)}`;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

/**
 * The Codex CLI's own model catalog: `$CODEX_HOME/models_cache.json`, which the
 * CLI refreshes from OpenAI on every run, for whatever account it is signed in
 * with. On a ChatGPT-login install, the usual one, there is no OpenAI API key
 * to ask, and this file is the only place that knows a model shipped last
 * week. Reading it keeps the picker current without a release.
 *
 * Only `visibility: "list"` entries are offered; the catalog also holds
 * internal models (`codex-auto-review`) that Codex itself never shows. Any
 * problem reading it means "no catalog", never an error: the built-in list
 * still answers. Re-read only when the file changes.
 *
 * Agents run Codex from a per-company home seeded from the shared one, so it
 * is their runs that refresh those copies while the shared copy can go stale.
 * So every copy is a candidate, and the one written by the newest Codex
 * version wins, then the most recently fetched. Not simply the newest file:
 * Codex fetches the catalog for its own version, and one run by an outdated
 * CLI writes a shorter list that must not shrink everyone's picker.
 *
 * A company home counts only while its `auth.json` is the shared sign-in (the
 * symlink `codex-home.ts` creates). A company whose Codex was signed in to a
 * different account has that account's catalog, which is not the others'.
 */
const CATALOG_FILE = "models_cache.json";

type ParsedCatalog = { clientVersion: number[]; fetchedAt: number; models: AdapterModel[] };

const parsedCatalogs = new Map<string, { mtimeMs: number; catalog: ParsedCatalog | null }>();

function realpathOrNull(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

function catalogHomes(): string[] {
  const shared = resolveSharedCodexHomeDir();
  const sharedAuth = realpathOrNull(path.join(shared, "auth.json"));
  const managed = resolveManagedCodexHomeDir(process.env);
  const candidates = [managed];
  const companiesDir = path.join(path.dirname(managed), "companies");
  try {
    for (const company of readdirSync(companiesDir)) candidates.push(path.join(companiesDir, company, "codex-home"));
  } catch {
    // No managed company homes yet.
  }
  const signedInAsShared = (home: string) => {
    const auth = path.join(home, "auth.json");
    try {
      return sharedAuth !== null && lstatSync(auth).isSymbolicLink() && realpathOrNull(auth) === sharedAuth;
    } catch {
      return false;
    }
  };
  return [shared, ...candidates.filter(signedInAsShared)];
}

function parseVersion(value: unknown): number[] {
  if (typeof value !== "string") return [];
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : [];
}

function compareCatalogs(a: ParsedCatalog, b: ParsedCatalog): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a.clientVersion[i] ?? -1) - (b.clientVersion[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return a.fetchedAt - b.fetchedAt;
}

function parseCatalogFile(file: string): ParsedCatalog | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const memo = parsedCatalogs.get(file);
  if (memo && memo.mtimeMs === mtimeMs) return memo.catalog;
  let catalog: ParsedCatalog | null = null;
  try {
    const payload = JSON.parse(readFileSync(file, "utf8")) as {
      models?: unknown;
      client_version?: unknown;
      fetched_at?: unknown;
    };
    const entries = Array.isArray(payload.models) ? payload.models : [];
    const listed = entries
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .filter((entry) => entry.visibility === "list" && typeof entry.slug === "string" && entry.slug.trim())
      .map((entry, index) => ({
        priority: typeof entry.priority === "number" ? entry.priority : Number.MAX_SAFE_INTEGER,
        index,
        model: { id: (entry.slug as string).trim(), label: catalogLabel(entry) },
      }))
      .sort((a, b) => a.priority - b.priority || a.index - b.index)
      .map((entry) => entry.model);
    const fetchedAt = typeof payload.fetched_at === "string" ? Date.parse(payload.fetched_at) : Number.NaN;
    catalog = {
      clientVersion: parseVersion(payload.client_version),
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : mtimeMs,
      models: dedupeModels(listed),
    };
  } catch {
    catalog = null;
  }
  parsedCatalogs.set(file, { mtimeMs, catalog });
  return catalog;
}

function readCodexCliCatalog(): AdapterModel[] {
  let best: ParsedCatalog | null = null;
  for (const home of catalogHomes()) {
    const catalog = parseCatalogFile(path.join(home, CATALOG_FILE));
    if (catalog && catalog.models.length > 0 && (!best || compareCatalogs(catalog, best) > 0)) best = catalog;
  }
  return best?.models ?? [];
}

function catalogLabel(entry: Record<string, unknown>): string {
  const name = typeof entry.display_name === "string" && entry.display_name.trim()
    ? entry.display_name.trim()
    : String(entry.slug).trim();
  const description = typeof entry.description === "string" ? entry.description.trim().replace(/\.$/, "") : "";
  return description ? `${name} — ${description}` : name;
}

/** The catalog first, in the CLI's own order, then the built-in list. */
function codexFallbackModels(): AdapterModel[] {
  return dedupeModels([...readCodexCliCatalog(), ...builtInCodexModels]);
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([
    ...models,
    ...codexFallbackModels(),
  ]).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

function resolveOpenAiApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  const config = readConfigFile();
  if (config?.llm?.provider !== "openai") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

async function fetchOpenAiModels(apiKey: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      models.push({ id, label: id });
    }
    return dedupeModels(models);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCodexModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const forceRefresh = options?.forceRefresh === true;
  const apiKey = resolveOpenAiApiKey();
  const fallback = codexFallbackModels();
  if (!apiKey) return fallback;

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (!forceRefresh && cached && cached.keyFingerprint === keyFingerprint && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchOpenAiModels(apiKey);
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
    cached = {
      keyFingerprint,
      expiresAt: now + OPENAI_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

export async function listCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels();
}

export async function refreshCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels({ forceRefresh: true });
}

export function resetCodexModelsCacheForTests() {
  cached = null;
  parsedCatalogs.clear();
}

// AgentDash (#1122): chat and system hires share this fallback. Keeping it in
// one place prevents a new worker from disagreeing with the interview model.
// The default retains chat's existing account-compatible selection.
export function resolveCodexChatModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTDASH_CODEX_CHAT_MODEL?.trim() || "gpt-5.6-terra";
}
