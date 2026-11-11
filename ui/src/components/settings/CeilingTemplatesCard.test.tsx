// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** AgentDash admin powers: the Ceiling templates card. */

const dialog = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("../batch/BatchPreviewDialog", () => ({
  BatchPreviewDialog: (props: Record<string, unknown>) => {
    dialog.last = props;
    return <div data-testid="dialog-open" />;
  },
}));
const mockTemplatesApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("../../api/ceilingTemplates", () => ({ ceilingTemplatesApi: mockTemplatesApi }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../api/agents", () => ({ agentsApi: mockAgentsApi }));

const { CeilingTemplatesCard } = await import("./CeilingTemplatesCard");
const { ApiError } = await import("../../api/client");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TEMPLATE = {
  id: "t1", companyId: "company-1", name: "Contractors", revision: 2,
  ceiling: { permissions: ["tasks:assign"], monthlyBudgetCents: 50_000, destructiveActions: "blocked", dataScopes: ["*"], providers: ["slack"], minimumApproval: "steward" },
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  dialog.last = null;
  mockTemplatesApi.list.mockResolvedValue({ templates: [TEMPLATE] });
  mockTemplatesApi.create.mockResolvedValue({});
  mockTemplatesApi.remove.mockResolvedValue({});
  mockAgentsApi.list.mockResolvedValue([{ id: "a1", name: "Ada", status: "idle" }, { id: "a2", name: "Gone", status: "terminated" }]);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(canManage: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={client}><CeilingTemplatesCard companyId="company-1" canManage={canManage} /></QueryClientProvider>); });
  await flush();
}
const button = (text: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent === text || b.getAttribute("aria-label") === text) as HTMLButtonElement;
async function click(el: HTMLElement) { await act(async () => { el.click(); }); await flush(); }
async function type(label: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CeilingTemplatesCard", () => {
  it("lists templates in plain words; people who cannot manage settings get no controls", async () => {
    await render(false);
    expect(container.querySelector('[data-testid="ceiling-template-row"]')!.textContent).toContain("up to $500 a month; providers: slack");
    expect(button("New template")).toBeUndefined();
    expect(button("Apply to agents…")).toBeUndefined();
  });

  it("creates a template", async () => {
    await render(true);
    await click(button("New template"));
    await type("Name", "Interns");
    await type("Monthly budget in dollars", "25");
    await type("Providers", "slack, teams");
    await click(document.body.querySelector<HTMLButtonElement>('[data-testid="ceiling-template-save"]')!);
    expect(mockTemplatesApi.create).toHaveBeenCalledWith("company-1", {
      name: "Interns",
      ceiling: expect.objectContaining({ monthlyBudgetCents: 2500, providers: ["slack", "teams"], permissions: ["*"] }),
    });
  });

  it("applies a template to picked agents through the preview dialog with gains and losses", async () => {
    await render(true);
    await click(button("Apply to agents…"));
    const picker = document.body.querySelector('[data-testid="ceiling-apply-picker"]')!;
    expect(picker.textContent).toContain("Ada");
    expect(picker.textContent).not.toContain("Gone");
    await click(picker.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(document.body.querySelector<HTMLButtonElement>('[data-testid="ceiling-apply-preview"]')!);
    expect(dialog.last).toMatchObject({ kind: "agent.apply_ceiling", ids: ["a1"], change: { templateId: "t1" } });
    expect(typeof dialog.last!.describeItem).toBe("function");
  });

  it("shows the server's reason when a delete is refused", async () => {
    mockTemplatesApi.remove.mockRejectedValue(new ApiError("This template is the ceiling for new agents. Choose another one, or none, in Admin powers before deleting it.", 409, null));
    await render(true);
    await click(button("Delete Contractors"));
    expect(container.textContent).toContain("This template is the ceiling for new agents.");
  });

  it("says agent ceilings are available on request where the server has none", async () => {
    mockTemplatesApi.list.mockRejectedValue(new ApiError("Company not found", 404, null));
    await render(true);
    expect(container.querySelector('[data-testid="ceiling-templates-unavailable"]')!.textContent).toBe("Agent ceilings are available on request.");
    expect(button("New template")).toBeUndefined();
  });
});
