import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { UIAdapterModule } from "./types";

const dynamicLoaderMocks = vi.hoisted(() => ({
  loadDynamicParser: vi.fn(),
  invalidateDynamicParser: vi.fn(),
  setDynamicParserResultNotifier: vi.fn(),
}));

vi.mock("./dynamic-loader", () => dynamicLoaderMocks);

import {
  findUIAdapter,
  getUIAdapter,
  invalidateUIAdapterParser,
  listUIAdapters,
  registerUIAdapter,
  syncExternalAdapters,
  unregisterUIAdapter,
} from "./registry";
import { processUIAdapter } from "./process";
import { SchemaConfigFields } from "./schema-config-fields";

const externalUIAdapter: UIAdapterModule = {
  type: "external_test",
  label: "External Test",
  parseStdoutLine: () => [],
  ConfigFields: () => null,
  buildAdapterConfig: () => ({}),
};

describe("ui adapter registry", () => {
  beforeEach(() => {
    dynamicLoaderMocks.loadDynamicParser.mockReset();
    dynamicLoaderMocks.invalidateDynamicParser.mockReset();
    unregisterUIAdapter("external_test");
  });

  afterEach(() => {
    unregisterUIAdapter("external_test");
  });

  it("registers adapters for lookup and listing", () => {
    registerUIAdapter(externalUIAdapter);

    expect(findUIAdapter("external_test")).toBe(externalUIAdapter);
    expect(getUIAdapter("external_test")).toBe(externalUIAdapter);
    expect(listUIAdapters().some((adapter) => adapter.type === "external_test")).toBe(true);
  });

  it("falls back to the process parser for unknown types after unregistering", () => {
    registerUIAdapter(externalUIAdapter);

    unregisterUIAdapter("external_test");

    expect(findUIAdapter("external_test")).toBeNull();
    const fallback = getUIAdapter("external_test");
    // Unknown types return a lazy-loading wrapper (for external adapters),
    // not the process adapter directly. The type is preserved.
    expect(fallback.type).toBe("external_test");
    // But it uses the schema-based config fields for external adapter forms.
    expect(fallback.ConfigFields).toBe(SchemaConfigFields);
  });

  it("removes stale non-builtin external adapters when the server no longer lists them", () => {
    syncExternalAdapters([{ type: "external_test", label: "External Test" }]);

    expect(findUIAdapter("external_test")).not.toBeNull();

    syncExternalAdapters([]);

    expect(findUIAdapter("external_test")).toBeNull();
  });

  it("rebuilds a non-builtin bridge after explicit parser invalidation", () => {
    syncExternalAdapters([{ type: "external_test", label: "External Test" }]);
    const first = findUIAdapter("external_test");

    invalidateUIAdapterParser("external_test");
    expect(findUIAdapter("external_test")).toBeNull();

    syncExternalAdapters([{ type: "external_test", label: "External Test" }]);
    const second = findUIAdapter("external_test");

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(dynamicLoaderMocks.invalidateDynamicParser).toHaveBeenCalledWith("external_test");
  });

  it("does not re-register a removed adapter when a dynamic parser load resolves late", async () => {
    let resolveParser!: (parser: { parseStdoutLine: UIAdapterModule["parseStdoutLine"] } | null) => void;
    dynamicLoaderMocks.loadDynamicParser.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveParser = resolve;
      }),
    );

    syncExternalAdapters([{ type: "external_test", label: "External Test" }]);
    getUIAdapter("external_test").parseStdoutLine("ready", new Date(0).toISOString());

    syncExternalAdapters([]);
    expect(findUIAdapter("external_test")).toBeNull();

    resolveParser({
      parseStdoutLine: () => [],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(findUIAdapter("external_test")).toBeNull();
  });
});
