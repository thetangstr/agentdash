// @vitest-environment jsdom
//
// Agent Performance Management gate 4 (P4.2): which agent is the company's
// performance manager. Admins (the server's `viewer.canChange`) pick an agent
// or "Chief of Staff (default)" and save; members read the designation and
// are told only admins can change it. Every viewer is told plainly that the
// manager only recommends and proposes — never approves or applies. The
// server's refusals are shown as written.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerformanceManagerView } from "@paperclipai/shared";
import { ApiError } from "../../api/client";

const mockManagerApi = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../api/performance-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/performance-manager")>();
  return { ...actual, performanceManagerApi: mockManagerApi };
});
vi.mock("../../api/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agents")>();
  return { ...actual, agentsApi: mockAgentsApi };
});
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { PerformanceManagerCard, CHIEF_OF_STAFF_DEFAULT_LABEL, MEMBER_READ_ONLY_TEXT } = await import("./PerformanceManagerCard");
const { PERFORMANCE_MANAGER_ADVISORY_TEXT } = await import("../agent-performance/manager-shared");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COS = { agentId: "agent-cos", name: "Clara", role: "chief_of_staff", status: "active" };
const REX = { agentId: "agent-rex", name: "Rex", role: "general", status: "active" };

function view(overrides: Partial<PerformanceManagerView> = {}): PerformanceManagerView {
  return {
    kind: "performance_manager",
    companyId: "company-1",
    designatedAgentId: null,
    designated: null,
    effective: COS,
    source: "chief_of_staff",
    viewer: { canChange: true },
    ...overrides,
  };
}

function agent(id: string, name: string, role: string, status = "active") {
  return { id, companyId: "company-1", name, role, status, urlKey: name.toLowerCase(), title: null };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <PerformanceManagerCard companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

function byTestId<T extends HTMLElement = HTMLElement>(node: ParentNode, id: string): T | null {
  return node.querySelector<T>(`[data-testid='${id}']`);
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submit(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
  await flush();
}

beforeEach(() => {
  mockAgentsApi.list.mockResolvedValue([
    agent("agent-rex", "Rex", "general"),
    agent("agent-cos", "Clara", "chief_of_staff"),
    agent("agent-old", "Olde", "general", "terminated"),
  ]);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("PerformanceManagerCard — admin", () => {
  it("offers the Chief of Staff default first, then the company's agents (never a terminated one)", async () => {
    mockManagerApi.get.mockResolvedValue(view());
    const node = await render();
    const select = byTestId<HTMLSelectElement>(node, "performance-manager-select")!;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toEqual([CHIEF_OF_STAFF_DEFAULT_LABEL, "Clara — Chief of Staff", "Rex — General"]);
    expect(select.value).toBe("");
    // Labelled and described for assistive tech.
    expect(node.querySelector(`label[for='${select.id}']`)?.textContent).toBe("Choose the performance manager");
    expect(select.getAttribute("aria-describedby")).toBeTruthy();
    expect(byTestId(node, "performance-manager-acting")?.textContent).toBe("Acting now: Clara, the company's Chief of Staff (the default).");
    expect(byTestId(node, "performance-manager-advisory")?.textContent).toBe(PERFORMANCE_MANAGER_ADVISORY_TEXT);
    expect(byTestId(node, "performance-manager-readonly")).toBeNull();
  });

  it("saves the chosen agent only on Save, and announces the result", async () => {
    mockManagerApi.get.mockResolvedValue(view());
    mockManagerApi.set.mockResolvedValue({
      ...view({ designatedAgentId: "agent-rex", designated: REX, effective: REX, source: "designated" }),
      changed: true,
      previousDesignatedAgentId: null,
    });
    const node = await render();
    const save = byTestId<HTMLButtonElement>(node, "performance-manager-save")!;
    expect(save.disabled).toBe(true);
    await choose(byTestId<HTMLSelectElement>(node, "performance-manager-select")!, "agent-rex");
    expect(mockManagerApi.set).not.toHaveBeenCalled();
    expect(save.disabled).toBe(false);
    await submit(save);
    expect(mockManagerApi.set).toHaveBeenCalledWith("company-1", "agent-rex");
    const status = byTestId(node, "performance-manager-status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("The performance manager is now Rex.");
    expect(byTestId(node, "performance-manager-acting")?.textContent).toBe("Acting now: Rex (General), chosen by an admin.");
  });

  it("returns to the Chief of Staff default by sending null", async () => {
    mockManagerApi.get.mockResolvedValue(view({ designatedAgentId: "agent-rex", designated: REX, effective: REX, source: "designated" }));
    mockManagerApi.set.mockResolvedValue({ ...view(), changed: true, previousDesignatedAgentId: "agent-rex" });
    const node = await render();
    const select = byTestId<HTMLSelectElement>(node, "performance-manager-select")!;
    expect(select.value).toBe("agent-rex");
    await choose(select, "");
    await submit(byTestId<HTMLButtonElement>(node, "performance-manager-save")!);
    expect(mockManagerApi.set).toHaveBeenCalledWith("company-1", null);
    expect(byTestId(node, "performance-manager-status")?.textContent).toBe(
      "The performance manager is back to the default: Clara, the Chief of Staff.",
    );
  });

  it("shows the server's refusal in an alert and keeps the saved choice", async () => {
    mockManagerApi.get.mockResolvedValue(view());
    mockManagerApi.set.mockRejectedValue(
      new ApiError("The evaluator principal cannot be the performance manager", 422, {
        error: "The evaluator principal cannot be the performance manager",
        details: { code: "PERFORMANCE_MANAGER_INELIGIBLE" },
      }),
    );
    const node = await render();
    await choose(byTestId<HTMLSelectElement>(node, "performance-manager-select")!, "agent-rex");
    await submit(byTestId<HTMLButtonElement>(node, "performance-manager-save")!);
    const alert = byTestId(node, "performance-manager-error")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe(
      "The performance manager was not changed: The evaluator principal cannot be the performance manager",
    );
    expect(byTestId(node, "performance-manager-status")?.textContent).toBe("");
    expect(byTestId(node, "performance-manager-acting")?.textContent).toContain("Clara");
  });

  it("says plainly when the chosen agent is terminated and nobody acts", async () => {
    mockManagerApi.get.mockResolvedValue(
      view({ designatedAgentId: "agent-old", designated: { agentId: "agent-old", name: "Olde", role: "general", status: "terminated" }, effective: null, source: "none" }),
    );
    const node = await render();
    expect(byTestId(node, "performance-manager-acting")?.textContent).toContain(
      "No agent. Olde was chosen but is terminated, so nobody acts as performance manager",
    );
    expect(byTestId(node, "performance-manager-record-link")).toBeNull();
    // The choice still reads true: the terminated agent is listed but can't be picked again.
    const select = byTestId<HTMLSelectElement>(node, "performance-manager-select")!;
    expect(select.value).toBe("agent-old");
    expect(Array.from(select.options).find((o) => o.value === "agent-old")?.disabled).toBe(true);
  });

  it("links the acting manager's record", async () => {
    mockManagerApi.get.mockResolvedValue(view());
    const node = await render();
    expect(byTestId(node, "performance-manager-record-link")?.getAttribute("href")).toBe("/agents/agent-cos/manager-record");
  });
});

describe("PerformanceManagerCard — member", () => {
  it("shows the designation read-only, says only admins can change it, and lists no agents", async () => {
    mockManagerApi.get.mockResolvedValue(view({ viewer: { canChange: false } }));
    const node = await render();
    expect(byTestId(node, "performance-manager-select")).toBeNull();
    expect(byTestId(node, "performance-manager-save")).toBeNull();
    expect(byTestId(node, "performance-manager-readonly")?.textContent).toBe(MEMBER_READ_ONLY_TEXT);
    expect(byTestId(node, "performance-manager-acting")?.textContent).toContain("Clara, the company's Chief of Staff");
    expect(byTestId(node, "performance-manager-advisory")?.textContent).toBe(PERFORMANCE_MANAGER_ADVISORY_TEXT);
    expect(mockAgentsApi.list).not.toHaveBeenCalled();
  });

  it("says so when the company has no Chief of Staff and nobody is chosen", async () => {
    mockManagerApi.get.mockResolvedValue(view({ effective: null, source: "none", viewer: { canChange: false } }));
    const node = await render();
    expect(byTestId(node, "performance-manager-acting")?.textContent).toBe(
      "Acting now: No agent. The company has no Chief of Staff, so nobody acts as performance manager until an admin chooses an agent.",
    );
  });

  it("explains a failed read instead of showing a blank control", async () => {
    mockManagerApi.get.mockRejectedValue(new ApiError("Company not found", 404, { error: "Company not found" }));
    const node = await render();
    const alert = node.querySelector("[role='alert']");
    expect(alert?.textContent).toBe("Couldn't read the performance manager: Company not found");
  });
});
