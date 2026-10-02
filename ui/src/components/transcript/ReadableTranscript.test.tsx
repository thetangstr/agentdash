// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizeToolCall } from "../../lib/readableTranscript";
import { ReadableToolGroup, type ReadableToolGroupItem } from "./ReadableTranscript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function item(key: string, name: string, input: unknown, status: ReadableToolGroupItem["status"], result?: string): ReadableToolGroupItem {
  return { key, name, input, summary: summarizeToolCall(name, input), status, result };
}

describe("ReadableToolGroup", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const rowLabels = () =>
    Array.from(container.querySelectorAll<HTMLElement>("[data-readable-tool] > [role=button]")).map((el) => el.title);

  it("keeps failed and running calls visible while the group is folded, and shows all when opened", () => {
    const items = [
      item("a", "Read", { file_path: "a.ts" }, "completed", "a body"),
      item("b", "Bash", { command: "pnpm test" }, "error", "FAIL x"),
      item("c", "Grep", { pattern: "foo" }, "completed", "hit"),
      item("d", "Bash", { command: "pnpm build" }, "running"),
    ];
    act(() => root.render(<ReadableToolGroup items={items} />));

    expect(container.textContent).toContain("Running 4 tools");
    expect(container.textContent).toContain("1 failed");
    expect(rowLabels()).toEqual(["Ran pnpm test", "Ran pnpm build"]);
    expect(container.querySelector('[data-readable-tool="error"]')).not.toBeNull();
    expect(container.querySelector('[data-readable-tool="running"]')).not.toBeNull();

    const header = container.querySelector<HTMLElement>("[data-readable-tool-group] > [role=button]")!;
    act(() => header.click());
    expect(rowLabels()).toEqual(["Read a.ts", "Ran pnpm test", "Searched foo", "Ran pnpm build"]);
  });

  it("does not show a no_result call as a success", () => {
    act(() => root.render(<ReadableToolGroup items={[item("a", "Read", { file_path: "a.ts" }, "no_result")]} />));
    expect(container.querySelector('[data-readable-tool="no_result"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Succeeded"]')).toBeNull();
    expect(container.querySelector('[aria-label="No result"]')).not.toBeNull();
    expect(container.textContent).toContain("No result");
  });

  it("keeps the first row expanded (and visible) when a second call joins it", () => {
    const first = item("a", "Read", { file_path: "a.ts" }, "completed", "first file body");
    act(() => root.render(<ReadableToolGroup items={[first]} />));
    const row = container.querySelector<HTMLElement>("[data-readable-tool] > [role=button]")!;
    act(() => row.click());
    expect(container.textContent).toContain("first file body");

    act(() =>
      root.render(<ReadableToolGroup items={[first, item("b", "Grep", { pattern: "x" }, "running")]} />),
    );
    expect(container.textContent).toContain("Running 2 tools");
    expect(container.textContent).toContain("first file body");
    expect(rowLabels()).toEqual(["Read a.ts", "Searched x"]);
  });
});
