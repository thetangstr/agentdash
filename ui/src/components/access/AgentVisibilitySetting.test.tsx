// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCompaniesApi = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@/api/companies", () => ({ companiesApi: mockCompaniesApi }));

const { AgentVisibilitySetting } = await import("./AgentVisibilitySetting");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(props: { value: "company" | "owner"; canManage: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <AgentVisibilitySetting companyId="company-1" {...props} />
      </QueryClientProvider>,
    );
  });
}

describe("AgentVisibilitySetting", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockCompaniesApi.update.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the two choices to an administrator, with the current one selected", () => {
    render({ value: "owner", canManage: true });
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[name="agent-visibility-default"]'));
    expect(radios.map((r) => r.value)).toEqual(["company", "owner"]);
    expect(radios.find((r) => r.checked)?.value).toBe("owner");
    expect(container.textContent).toContain("People see the agents they answer for");
  });

  it("writes the company default when an administrator picks the other choice", async () => {
    mockCompaniesApi.update.mockResolvedValue({ id: "company-1", agentVisibilityDefault: "owner" });
    render({ value: "company", canManage: true });
    const owner = container.querySelector<HTMLInputElement>('input[value="owner"]')!;
    await act(async () => {
      owner.click();
      await Promise.resolve();
    });
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { agentVisibilityDefault: "owner" });
  });

  it("shows a member the current value and no controls", () => {
    render({ value: "owner", canManage: false });
    expect(container.querySelector('input[name="agent-visibility-default"]')).toBeNull();
    expect(container.textContent).toContain("People see the agents they answer for.");
    expect(container.textContent).toContain("Only a company administrator can change this.");
  });

  it("reports a refused write in the server's words", async () => {
    mockCompaniesApi.update.mockRejectedValue(new Error("Instance admin access required"));
    render({ value: "company", canManage: true });
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="owner"]')!.click();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Instance admin access required");
  });
});
