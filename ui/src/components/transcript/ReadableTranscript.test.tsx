// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizeToolCall } from "../../lib/readableTranscript";
import { ThemeProvider } from "../../context/ThemeContext";
import {
  ReadableFooter,
  ReadableToolGroup,
  ReadableTranscriptView,
  type ReadableToolGroupItem,
} from "./ReadableTranscript";

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

// AgentDash (scan 4 lane O1, PR #990 review): neither the collapsed row nor
// the expanded row may show a credential.
describe("ReadableToolGroup redaction", () => {
  const SECRET = "SUPERSECRETvalue123";
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

  it("redacts the collapsed label and outcome, and the expanded input and output", () => {
    const command = `curl -s -H "Authorization: Bearer ${SECRET}" "https://x.test/a?token=${SECRET}"`;
    const output = `OPENAI_API_KEY=sk-${SECRET}\n{"apiKey":"${SECRET}"}`;
    act(() => root.render(<ReadableToolGroup items={[item("a", "Bash", { command }, "completed", output)]} />));
    // Collapsed: label and the first output line.
    expect(container.querySelector("[data-readable-tool] [role=button]")?.getAttribute("title")).toBe("Ran curl");
    expect(container.textContent).toContain("OPENAI_API_KEY=•••• hidden");
    expect(container.innerHTML).not.toContain(SECRET);

    act(() => container.querySelector<HTMLElement>("[data-readable-tool] [role=button]")!.click());
    expect(container.textContent).toContain("Authorization: Bearer •••• hidden");
    expect(container.textContent).toContain('"apiKey":"•••• hidden"');
    expect(container.innerHTML).not.toContain(SECRET);
  });

  it("redacts an expanded input that has no script (a non-command tool)", () => {
    const input = { url: `https://x.test/a?api_key=${SECRET}`, headers: { "X-Api-Key": SECRET } };
    act(() => root.render(<ReadableToolGroup items={[item("a", "WebFetch", input, "completed", "ok")]} />));
    act(() => container.querySelector<HTMLElement>("[data-readable-tool] [role=button]")!.click());
    expect(container.innerHTML).not.toContain(SECRET);
  });
});

describe("readable transcript secrets behind instance paths", () => {
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

  // AgentDash (review #1016): shortening must run after redaction — a secret
  // that happens to be a path basename must never render as the file name.
  const SECRET_PATH = `API_KEY=/paperclip/instances/default/secrets/plainsecretvalue123456`;

  it("the footer text never shows a secret that is a path basename", () => {
    act(() =>
      root.render(
        <ThemeProvider>
          <ReadableFooter
            footer={{
              ts: "",
              isError: false,
              outcome: "Done",
              text: `wrote the key to ${SECRET_PATH}`,
              errors: [],
              durationMs: null,
              inputTokens: 0,
              outputTokens: 0,
              cachedTokens: 0,
              costUsd: 0,
            }}
          />
        </ThemeProvider>,
      ),
    );
    expect(container.textContent).not.toContain("plainsecretvalue123456");
    expect(container.textContent).toContain("API_KEY=•••• hidden");
  });

  it("a message block never shows a secret that is a path basename", () => {
    act(() =>
      root.render(
        <ThemeProvider>
          <ReadableTranscriptView
            entries={[{ kind: "assistant", ts: "", text: `saved it under ${SECRET_PATH}` }]}
          />
        </ThemeProvider>,
      ),
    );
    expect(container.textContent).not.toContain("plainsecretvalue123456");
    expect(container.textContent).toContain("API_KEY=•••• hidden");
  });
});
