// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewAgentDialog } from "./NewAgentDialog";

const dialogState = vi.hoisted(() => ({
  newAgentOpen: true,
  closeNewAgent: vi.fn(),
  openNewIssue: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Meridian Goods",
    status: "active",
    issuePrefix: "MER",
  } as { id: string; name: string; status: string; issuePrefix: string; productProfile?: string },
}));

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockConversationsApi = vi.hoisted(() => ({
  companyInbox: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => routerState.navigate,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

vi.mock("../api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("../api/conversations", () => ({
  conversationsApi: mockConversationsApi,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogTitle: ({ children, ...props }: ComponentProps<"h2">) => <h2 {...props}>{children}</h2>,
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    ...props
  }: ComponentProps<"div"> & { showCloseButton?: boolean }) => (
    <div {...props}>{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", disabled, ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} disabled={disabled} {...props}>{children}</button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

async function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function renderDialog(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewAgentDialog />
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

function rerenderDialog({ root, queryClient }: ReturnType<typeof renderDialog>) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewAgentDialog />
      </QueryClientProvider>,
    );
  });
}

describe("NewAgentDialog on a hosted box", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useRealTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.newAgentOpen = true;
    companyState.selectedCompanyId = "company-1";
    dialogState.closeNewAgent.mockReset();
    dialogState.openNewIssue.mockReset();
    routerState.navigate.mockReset();
    mockAgentsApi.list.mockResolvedValue([
      { id: "cos-1", role: "chief_of_staff" },
    ]);
    mockAdaptersApi.list.mockResolvedValue([]);
    mockHealthApi.get.mockResolvedValue({ status: "ok", hostedBox: true });
    mockConversationsApi.companyInbox.mockResolvedValue({ id: "conv-1" });
    mockConversationsApi.post.mockResolvedValue({ id: "msg-1" });
    companyState.selectedCompany = {
      id: "company-1",
      name: "Meridian Goods",
      status: "active",
      issuePrefix: "MER",
    };
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it("shows the CoS hire form and no adapter choice", async () => {
    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Ask your Chief of Staff");
    });
    expect(container.textContent).not.toContain("advanced configuration");
    expect(container.textContent).not.toContain("CEO");
    expect(container.querySelector('input[placeholder*="Role"]')).not.toBeNull();
    expect(container.querySelector('textarea[placeholder*="work on"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("can submit another hire after a successful hire and reopening", async () => {
    const view = renderDialog(container);
    await waitForAssertion(() => expect(container.textContent).toContain("Ask your Chief of Staff"));
    await setInputValue(container.querySelector('input[placeholder*="Role"]') as HTMLInputElement, "Engineer");
    const submit = () => Array.from(container.querySelectorAll("button"))
      .find((button) => /Ask your Chief of Staff|Asking/.test(button.textContent ?? ""))!;
    await act(async () => submit().click());
    await waitForAssertion(() => expect(mockConversationsApi.post).toHaveBeenCalled());
    dialogState.newAgentOpen = false;
    rerenderDialog(view);
    dialogState.newAgentOpen = true;
    rerenderDialog(view);
    await setInputValue(container.querySelector('input[placeholder*="Role"]') as HTMLInputElement, "Designer");
    expect(submit().disabled).toBe(false);
    expect(submit().textContent).toContain("Ask your Chief of Staff");
    await act(async () => submit().click());
    expect(mockConversationsApi.post).toHaveBeenLastCalledWith("conv-1", "Please hire Designer.", "company-1");
    act(() => view.root.unmount());
  });

  it("does not post or close a new dialog session when an old inbox lookup finishes", async () => {
    let resolveInbox!: (value: { id: string }) => void;
    mockConversationsApi.companyInbox.mockImplementationOnce(() => new Promise((resolve) => { resolveInbox = resolve; }));
    mockConversationsApi.post.mockClear();
    const view = renderDialog(container);
    await waitForAssertion(() => expect(container.textContent).toContain("Ask your Chief of Staff"));
    await setInputValue(container.querySelector('input[placeholder*="Role"]') as HTMLInputElement, "Engineer");
    await act(async () => Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Ask your Chief of Staff"))!.click());
    dialogState.newAgentOpen = false;
    rerenderDialog(view);
    dialogState.newAgentOpen = true;
    rerenderDialog(view);
    await setInputValue(container.querySelector('input[placeholder*="Role"]') as HTMLInputElement, "New request");
    await act(async () => resolveInbox({ id: "old-conversation" }));
    expect(mockConversationsApi.post).not.toHaveBeenCalled();
    expect(dialogState.closeNewAgent).not.toHaveBeenCalled();
    expect((container.querySelector('input[placeholder*="Role"]') as HTMLInputElement).value).toBe("New request");
    act(() => view.root.unmount());
  });

  it("does not navigate or clear the new company's draft after an earlier company's post completes", async () => {
    let resolvePost!: (value: { id: string }) => void;
    mockConversationsApi.post.mockImplementationOnce(() => new Promise((resolve) => { resolvePost = resolve; }));
    const view = renderDialog(container);
    await waitForAssertion(() => expect(container.textContent).toContain("Ask your Chief of Staff"));
    await setInputValue(container.querySelector('input[placeholder*="Role"]') as HTMLInputElement, "Engineer");
    await act(async () => Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Ask your Chief of Staff"))!.click());
    companyState.selectedCompanyId = "company-2";
    companyState.selectedCompany = { ...companyState.selectedCompany, id: "company-2", name: "Second company" };
    rerenderDialog(view);
    await setInputValue(container.querySelector('input[placeholder*="Role"]') as HTMLInputElement, "Second company draft");
    await act(async () => resolvePost({ id: "old-message" }));
    expect(dialogState.closeNewAgent).not.toHaveBeenCalled();
    expect(routerState.navigate).not.toHaveBeenCalled();
    expect((container.querySelector('input[placeholder*="Role"]') as HTMLInputElement).value).toBe("Second company draft");
    act(() => view.root.unmount());
  });

  it("renders a placeholder instead of the adapter path while health loads", async () => {
    mockHealthApi.get.mockReturnValue(new Promise(() => undefined));
    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).not.toContain("Ask your Chief of Staff");
    expect(container.textContent).not.toContain("advanced configuration");
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("shows the same hosted hire form to an MK company (one UX)", async () => {
    companyState.selectedCompany = {
      id: "company-1",
      name: "MK Think",
      status: "active",
      issuePrefix: "MKT",
      productProfile: "agentdash_mk",
    };
    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Ask your Chief of Staff");
    });
    expect(container.querySelector('input[placeholder*="Role"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Ask the CEO");

    act(() => root.unmount());
  });

  it("files the hire into the company inbox and lands on the CoS chat", async () => {
    const { root } = renderDialog(container);
    await flush();
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Ask your Chief of Staff");
    });

    const roleInput = container.querySelector('input[placeholder*="Role"]') as HTMLInputElement;
    const workInput = container.querySelector('textarea[placeholder*="work on"]') as HTMLTextAreaElement;
    await setInputValue(roleInput, "Frontend engineer");
    await setInputValue(workInput, "The landing page rebuild");

    const submit = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Ask your Chief of Staff"));
    expect(submit).not.toBeUndefined();
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockConversationsApi.companyInbox).toHaveBeenCalledWith("company-1");
    expect(mockConversationsApi.post).toHaveBeenCalledWith(
      "conv-1",
      "Please hire Frontend engineer. It should work on: The landing page rebuild.",
      "company-1",
    );
    expect(dialogState.closeNewAgent).toHaveBeenCalled();
    expect(routerState.navigate).toHaveBeenCalledWith("/cos");

    act(() => root.unmount());
  });
});

describe("NewAgentDialog self-hosted", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useRealTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.newAgentOpen = true;
    dialogState.closeNewAgent.mockReset();
    dialogState.openNewIssue.mockReset();
    mockAgentsApi.list.mockResolvedValue([
      { id: "cos-1", role: "chief_of_staff" },
    ]);
    mockAdaptersApi.list.mockResolvedValue([]);
    mockHealthApi.get.mockResolvedValue({ status: "ok", hostedBox: false });
    companyState.selectedCompany = {
      id: "company-1",
      name: "Meridian Goods",
      status: "active",
      issuePrefix: "MER",
    };
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it("keeps the delegation default with the CoS label and the advanced link", async () => {
    const { root } = renderDialog(container);
    await flush();
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Ask your Chief of Staff to create a new agent");
    });
    expect(container.textContent).toContain("advanced configuration");
    expect(container.textContent).not.toContain("CEO");
    act(() => root.unmount());
  });

  it("delegates to the Chief of Staff for an MK company too (one UX)", async () => {
    companyState.selectedCompany = {
      id: "company-1",
      name: "MK Think",
      status: "active",
      issuePrefix: "MKT",
      productProfile: "agentdash_mk",
    };
    mockAgentsApi.list.mockResolvedValue([
      { id: "cos-1", role: "chief_of_staff" },
      { id: "ceo-1", role: "ceo" },
    ]);
    const { root } = renderDialog(container);
    await flush();
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Ask your Chief of Staff to create a new agent");
    });

    const askButton = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Ask your Chief of Staff to create a new agent"));
    expect(askButton).not.toBeUndefined();
    await act(async () => {
      askButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(dialogState.openNewIssue).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeAgentId: "cos-1" }),
    );
    act(() => root.unmount());
  });

  it("falls through to the normal dialog when the health check fails", async () => {
    mockHealthApi.get.mockRejectedValue(new Error("health unavailable"));
    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Ask your Chief of Staff to create a new agent");
    });
    expect(container.textContent).toContain("advanced configuration");
    act(() => root.unmount());
  });
  it('sends the selected pinned workforce role to CoS and clears selection on reopening', async () => {
    mockHealthApi.get.mockResolvedValue({ status: 'ok', hostedBox: true });
    mockConversationsApi.companyInbox.mockResolvedValue({ id: 'conv-1' });
    mockConversationsApi.post.mockResolvedValue({ id: 'msg-1' });
    const mounted = renderDialog(container); await flush(); await flush();
    const select = container.querySelector('select[aria-label="Workforce role"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'marketing-content'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.textContent).toContain('What good work looks like');
    const submit = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Ask your Chief of Staff'))!;
    await act(async () => submit.click()); await flush();
    expect(mockConversationsApi.post).toHaveBeenCalledWith('conv-1', expect.stringContaining('workforceTemplateId: marketing-content'), 'company-1');
    dialogState.newAgentOpen = false; rerenderDialog(mounted); dialogState.newAgentOpen = true; rerenderDialog(mounted); await flush();
    expect((container.querySelector('select[aria-label="Workforce role"]') as HTMLSelectElement).value).toBe('');
    act(() => mounted.root.unmount());
  });

});
