// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AgentDash admin powers: the Agents action bar. Pause, resume, change model
 * (from the runtimes' own model lists) and hand over to another steward (a
 * person and a reason) each open the shared preview dialog.
 */

const dialog = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("./BatchPreviewDialog", () => ({
  BatchPreviewDialog: (props: Record<string, unknown>) => {
    dialog.last = props;
    return <div data-testid="dialog-open" />;
  },
}));
const mockAgentsApi = vi.hoisted(() => ({ adapterModels: vi.fn() }));
vi.mock("../../api/agents", () => ({ agentsApi: mockAgentsApi }));

const { AgentsBulkBar } = await import("./AgentsBulkBar");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dialog.last = null;
  mockAgentsApi.adapterModels.mockImplementation(async (_company: string, type: string) =>
    type === "claude_local" ? [{ id: "sonnet", label: "Sonnet" }] : [{ id: "gpt", label: "GPT" }, { id: "sonnet", label: "Sonnet" }]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AgentsBulkBar
          companyId="company-1"
          selected={[{ id: "a1", name: "Alpha", adapterType: "claude_local" }, { id: "a2", name: "Beta", adapterType: "codex_local" }]}
          people={[{ id: "u1", name: "Sam" }]}
          onClear={vi.fn()}
          onFinished={vi.fn()}
        />
      </QueryClientProvider>,
    );
  });
  await flush();
}

const q = <T extends Element>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
async function click(el: Element | null) { await act(async () => { (el as HTMLElement).click(); }); await flush(); }
async function choose(select: HTMLSelectElement | HTMLInputElement, value: string) {
  await act(async () => {
    const proto = select instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event(select instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

describe("AgentsBulkBar", () => {
  it("pause and resume open the preview; resume says the agents may start work", async () => {
    await render();
    expect(q("agents-bulk-count")!.textContent).toBe("2 selected");
    await click(q("agents-bulk-resume"));
    expect(dialog.last).toMatchObject({ kind: "agent.resume", ids: ["a1", "a2"], change: {} });
    expect((dialog.last!.summary as (n: number) => string)(2)).toBe("2 agents will resume and may start work.");
    await click(q("agents-bulk-pause"));
    expect(dialog.last).toMatchObject({ kind: "agent.pause" });
  });

  it("change model lists the models of the selected agents' runtimes and previews the choice", async () => {
    await render();
    await click(q("agents-bulk-model"));
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="New model"]')!;
    expect([...select.options].map((option) => option.value)).toEqual(["", "gpt", "sonnet"]);
    expect(mockAgentsApi.adapterModels).toHaveBeenCalledWith("company-1", "claude_local");
    expect(mockAgentsApi.adapterModels).toHaveBeenCalledWith("company-1", "codex_local");
    await choose(select, "sonnet");
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Preview")!);
    expect(dialog.last).toMatchObject({ kind: "agent.set_model", change: { model: "sonnet" } });
    const format = dialog.last!.formatField as (field: string, value: unknown) => unknown;
    expect(format("model", null)).toEqual({ label: "Model", value: "Runtime default" });
  });

  it("transfer steward needs a person and a reason", async () => {
    await render();
    await click(q("agents-bulk-steward"));
    const preview = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Preview") as HTMLButtonElement;
    expect(preview().disabled).toBe(true);
    await choose(container.querySelector<HTMLSelectElement>('select[aria-label="New steward"]')!, "u1");
    expect(preview().disabled).toBe(true);
    await choose(container.querySelector<HTMLInputElement>('input[aria-label="Why the steward changes"]')!, "Team change");
    expect(preview().disabled).toBe(false);
    await click(preview());
    expect(dialog.last).toMatchObject({ kind: "agent.transfer_steward", change: { userId: "u1", transferReason: "Team change" } });
    const format = dialog.last!.formatField as (field: string, value: unknown) => unknown;
    expect(format("stewardUserId", "u1")).toEqual({ label: "Steward", value: "Sam" });
  });
});
