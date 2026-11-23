import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { models as opencodeFallbackModels } from "@paperclipai/adapter-opencode-local";
import { resetOpenCodeModelsCacheForTests } from "@paperclipai/adapter-opencode-local/server";
import { listAdapterModels, refreshAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";

describe("adapter model listing", () => {
  // Every test gets its own empty Codex home, so the catalog the developer's
  // own Codex CLI keeps in ~/.codex never leaks into an assertion.
  let codexHome: string;
  let paperclipHome: string;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  function writeCodexCatalog(models: unknown[]) {
    writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({ client_version: "0.171.0", models }));
  }

  function restoreEnv(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(paperclipHome, { recursive: true, force: true });
    restoreEnv("CODEX_HOME", originalCodexHome);
    restoreEnv("PAPERCLIP_HOME", originalPaperclipHome);
    restoreEnv("PAPERCLIP_INSTANCE_ID", originalInstanceId);
  });

  beforeEach(() => {
    codexHome = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    paperclipHome = mkdtempSync(path.join(tmpdir(), "paperclip-home-"));
    process.env.CODEX_HOME = codexHome;
    process.env.PAPERCLIP_HOME = paperclipHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetCodexModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("returns codex fallback models when no OpenAI key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * A ChatGPT-login install has no OpenAI API key, so the picker used to show
   * only the built-in list and a new model was unreachable until a release
   * added it. The Codex CLI keeps its own catalog, refreshed from OpenAI on
   * every run; reading it keeps the picker current with no release.
   */
  it("lists the Codex CLI's own catalog first, without its hidden models", async () => {
    writeCodexCatalog([
      { slug: "gpt-7-nova", display_name: "GPT-7-Nova", description: "Brand new.", visibility: "list", priority: 1 },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 2 },
      { slug: "gpt-6.2-sol", display_name: "GPT-6.2-Sol", description: "Fast, go-to model.", visibility: "list", priority: 3 },
    ]);

    const models = await listAdapterModels("codex_local");

    expect(models.slice(0, 2)).toEqual([
      { id: "gpt-7-nova", label: "GPT-7-Nova — Brand new" },
      { id: "gpt-6.2-sol", label: "GPT-6.2-Sol — Fast, go-to model" },
    ]);
    expect(models.some((model) => model.id === "codex-auto-review")).toBe(false);
    // The built-in list still follows, for models the catalog does not name.
    expect(models.some((model) => model.id === "codex-mini-latest")).toBe(true);
    expect(models.filter((model) => model.id === "gpt-6.2-sol")).toHaveLength(1);
  });

  it("picks up a refreshed catalog without a restart", async () => {
    writeCodexCatalog([{ slug: "gpt-7-nova", display_name: "GPT-7-Nova", visibility: "list" }]);
    expect((await listAdapterModels("codex_local"))[0]?.id).toBe("gpt-7-nova");

    writeCodexCatalog([{ slug: "gpt-7.1-nova", display_name: "GPT-7.1-Nova", visibility: "list" }]);
    const later = new Date(Date.now() + 5_000);
    utimesSync(path.join(codexHome, "models_cache.json"), later, later);

    expect((await listAdapterModels("codex_local"))[0]?.id).toBe("gpt-7.1-nova");
  });

  /**
   * Agents run Codex from a per-company home seeded from the shared one, so an
   * agent run refreshes that copy and the shared copy can sit stale for weeks.
   * The newest copy is also the truest: Codex fetches the catalog for its own
   * version, so it names what the agents' CLI can actually run.
   */
  function companyCodexHome(companyId: string, options: { sharedAuth: boolean }) {
    const home = path.join(paperclipHome, "instances", "default", "companies", companyId, "codex-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(codexHome, "auth.json"), "{}");
    if (options.sharedAuth) symlinkSync(path.join(codexHome, "auth.json"), path.join(home, "auth.json"));
    else writeFileSync(path.join(home, "auth.json"), "{}");
    return home;
  }

  function writeCatalogAt(home: string, clientVersion: string, fetchedAt: string, slugs: string[]) {
    writeFileSync(
      path.join(home, "models_cache.json"),
      JSON.stringify({
        client_version: clientVersion,
        fetched_at: fetchedAt,
        models: slugs.map((slug) => ({ slug, display_name: slug, visibility: "list" })),
      }),
    );
  }

  it("reads an agent's catalog when it was fetched by a newer Codex than the shared one", async () => {
    writeCatalogAt(codexHome, "0.166.0", "2026-11-20T00:00:00Z", ["gpt-6.1-sol"]);
    const company = companyCodexHome("company-1", { sharedAuth: true });
    writeCatalogAt(company, "0.171.0", "2026-11-23T00:00:00Z", ["gpt-7-nova"]);

    expect((await listAdapterModels("codex_local"))[0]?.id).toBe("gpt-7-nova");
  });

  /**
   * Codex fetches the catalog for its own version, so a run by an outdated CLI
   * writes a SHORTER list. Being the most recent write must not let it shrink
   * everyone's picker.
   */
  it("prefers the catalog from the newest Codex version over the most recent write", async () => {
    writeCatalogAt(codexHome, "0.171.0", "2026-11-23T10:00:00Z", ["gpt-7-nova", "gpt-6.2-sol"]);
    const company = companyCodexHome("company-1", { sharedAuth: true });
    writeCatalogAt(company, "0.148.0", "2026-11-23T11:00:00Z", ["gpt-5.6-terra"]);
    const later = new Date(Date.now() + 5_000);
    utimesSync(path.join(company, "models_cache.json"), later, later);

    expect((await listAdapterModels("codex_local"))[0]?.id).toBe("gpt-7-nova");
  });

  it("ignores a company's catalog when that company's Codex is signed in to another account", async () => {
    writeCatalogAt(codexHome, "0.166.0", "2026-11-20T00:00:00Z", ["gpt-6.1-sol"]);
    const company = companyCodexHome("company-2", { sharedAuth: false });
    writeCatalogAt(company, "0.171.0", "2026-11-23T00:00:00Z", ["enterprise-only-model"]);

    const models = await listAdapterModels("codex_local");
    expect(models[0]?.id).toBe("gpt-6.1-sol");
    expect(models.some((model) => model.id === "enterprise-only-model")).toBe(false);
  });

  it("falls back to the built-in codex list when the catalog is unreadable", async () => {
    writeFileSync(path.join(codexHome, "models_cache.json"), "{ not json");
    expect(await listAdapterModels("codex_local")).toEqual(codexFallbackModels);
  });

  it("loads codex models dynamically and merges fallback options", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5-pro")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
  });

  it("refreshes cached codex models on demand", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5" }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5.5" }],
        }),
      } as Response);

    const initial = await listAdapterModels("codex_local");
    const refreshed = await refreshAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(initial.some((model) => model.id === "gpt-5")).toBe(true);
    expect(refreshed.some((model) => model.id === "gpt-5.5")).toBe(true);
  });

  it("falls back to static codex models when OpenAI model discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });


  it("returns cursor fallback models when CLI discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));

    const models = await listAdapterModels("cursor");
    expect(models).toEqual(cursorFallbackModels);
  });

  it("returns opencode fallback models including gpt-5.4", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAdapterModels("opencode_local");

    expect(models).toEqual(opencodeFallbackModels);
  });

  it("loads cursor models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: auto, composer-1.5, gpt-5.3-codex-high, sonnet-4.6",
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const first = await listAdapterModels("cursor");
    const second = await listAdapterModels("cursor");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "auto")).toBe(true);
    expect(first.some((model) => model.id === "gpt-5.3-codex-high")).toBe(true);
    expect(first.some((model) => model.id === "composer-1")).toBe(true);
  });

});
