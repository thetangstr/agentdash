import { readdirSync, readFileSync, statSync } from "node:fs";
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
 * The newest copy wins. It is also the truest one, because Codex fetches the
 * catalog for its own version: an old CLI gets a shorter list.
 */
let catalogCache: { file: string; mtimeMs: number; models: AdapterModel[] } | null = null;

const CATALOG_FILE = "models_cache.json";

function newestCodexCatalogFile(): { file: string; mtimeMs: number } | null {
  const homes = [resolveSharedCodexHomeDir(), resolveManagedCodexHomeDir(process.env)];
  const companiesDir = path.join(path.dirname(resolveManagedCodexHomeDir(process.env)), "companies");
  try {
    for (const company of readdirSync(companiesDir)) homes.push(path.join(companiesDir, company, "codex-home"));
  } catch {
    // No managed company homes yet.
  }
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const home of homes) {
    const file = path.join(home, CATALOG_FILE);
    try {
      const { mtimeMs } = statSync(file);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
    } catch {
      // Not there; try the next home.
    }
  }
  return newest;
}

function readCodexCliCatalog(): AdapterModel[] {
  const newest = newestCodexCatalogFile();
  if (!newest) return [];
  const { file, mtimeMs } = newest;
  try {
    if (catalogCache && catalogCache.file === file && catalogCache.mtimeMs === mtimeMs) {
      return catalogCache.models;
    }
    const payload = JSON.parse(readFileSync(file, "utf8")) as { models?: unknown };
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
    const models = dedupeModels(listed);
    catalogCache = { file, mtimeMs, models };
    return models;
  } catch {
    return [];
  }
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
  catalogCache = null;
}

// AgentDash (#1122): chat and system hires share this fallback. Keeping it in
// one place prevents a new worker from disagreeing with the interview model.
// The default retains chat's existing account-compatible selection.
export function resolveCodexChatModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTDASH_CODEX_CHAT_MODEL?.trim() || "gpt-5.6-terra";
}
