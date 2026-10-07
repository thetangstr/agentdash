import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { sortAgentsByDefaultSidebarOrder } from "./agent-order";

const agent = (id: string, name: string, reportsTo: string | null = null) =>
  ({ id, name, reportsTo }) as unknown as Agent;

describe("sortAgentsByDefaultSidebarOrder", () => {
  it("lists top level by name, then reports by name", () => {
    const sorted = sortAgentsByDefaultSidebarOrder([
      agent("b", "Zed"),
      agent("a", "Amy"),
      agent("c", "Cal", "a"),
      agent("d", "Bo", "a"),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["a", "b", "d", "c"]);
  });

  it("keeps agents on a reporting cycle instead of dropping them", () => {
    const sorted = sortAgentsByDefaultSidebarOrder([
      agent("p", "Pat", "q"),
      agent("q", "Quinn", "p"),
      agent("s", "Sol"),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["s", "p", "q"]);
  });
});
