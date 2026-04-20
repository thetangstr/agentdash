import { describe, expect, it } from "vitest";
import { isEnabledAdapterType, listAdapterOptions } from "./metadata";
import type { UIAdapterModule } from "./types";

const externalAdapter: UIAdapterModule = {
  type: "external_test",
  label: "External Test",
  parseStdoutLine: () => [],
  ConfigFields: () => null,
  buildAdapterConfig: () => ({}),
};

describe("adapter metadata", () => {
  it("treats registered external adapters as enabled by default", () => {
    expect(isEnabledAdapterType("external_test")).toBe(true);

    expect(
      listAdapterOptions((type) => type, [externalAdapter]),
    ).toEqual([
      {
        value: "external_test",
        label: "external_test",
        comingSoon: false,
        hidden: false,
      },
    ]);
  });

  it("ships process and http as enabled (no longer withheld)", () => {
    expect(isEnabledAdapterType("process")).toBe(true);
    expect(isEnabledAdapterType("http")).toBe(true);
  });
});