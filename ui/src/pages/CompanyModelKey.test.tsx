// @vitest-environment jsdom
// AgentDash (GH #794, UX-13): Settings > Model key.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAdapterStatus = vi.hoisted(() => vi.fn());
const mockSetup = vi.hoisted(() => vi.fn());
const mockAdmins = vi.hoisted(() => vi.fn());
const mockRequest = vi.hoisted(() => vi.fn());
const mockCompany = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: { id: "company-1", name: "Paperclip", productProfile: "default" },
}));

vi.mock("@/api/onboarding", () => ({
  onboardingApi: {
    adapterStatus: mockAdapterStatus,
    setupHermesProvider: mockSetup,
    modelKeyAdmins: mockAdmins,
    requestModelKey: mockRequest,
  },
}));

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => mockCompany }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    Link: actual.Link,
    useLocation: actual.useLocation,
    useNavigate: actual.useNavigate,
  };
});

import { CompanyModelKey } from "./CompanyModelKey";
import { MemoryRouter } from "react-router-dom";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { provider: "zai" as const, label: "Z.AI (GLM)", defaultModel: "glm-5.3-flash", keyHint: "API key from z.ai" },
  { provider: "anthropic" as const, label: "Anthropic", defaultModel: "claude-sonnet-5", keyHint: "sk-ant-…" },
];

function hermesProvider(overrides: Record<string, unknown> = {}) {
  return {
    required: true,
    configured: true,
    provider: "zai",
    model: "glm-5.3-flash",
    configuredAt: "2026-10-01T09:00:00.000Z",
    canConfigure: true,
    options: OPTIONS,
    ...overrides,
  };
}

async function flush(ticks = 4) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("CompanyModelKey", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const mock of [mockAdapterStatus, mockSetup, mockAdmins, mockRequest]) mock.mockReset();
    mockAdapterStatus.mockResolvedValue({ hermesProvider: hermesProvider() });
    mockAdmins.mockResolvedValue({ admins: [] });
    mockCompany.selectedCompanyId = "company-1";
    mockCompany.selectedCompany = { id: "company-1", name: "Paperclip", productProfile: "default" };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <CompanyModelKey />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("shows the provider, model and when the key was last checked — never the key", async () => {
    await render();
    expect(container.textContent).toContain("Model key");
    expect(container.textContent).toContain("Z.AI (GLM)");
    expect(container.textContent).toContain("glm-5.3-flash");
    expect(container.querySelector('[data-testid="model-key-checked"]')?.textContent).toContain(
      "last checked",
    );
  });

  it("lets an admin replace the key and confirms without echoing it", async () => {
    mockSetup.mockResolvedValue({
      hermesProvider: { configured: true, provider: "zai", label: "Z.AI (GLM)", model: "glm-5.3-flash" },
      profilesUpdated: 2,
    });
    await render();
    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(keyInput, "new-secret-key");
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(mockSetup).toHaveBeenCalledWith({ companyId: "company-1", provider: "zai", apiKey: "new-secret-key" });
    expect(container.querySelector('[data-testid="model-key-saved"]')).not.toBeNull();
    expect(container.textContent).not.toContain("new-secret-key");
  });

  it("surfaces a rejected key without losing the page", async () => {
    mockSetup.mockRejectedValue(new Error("Anthropic rejected this API key (HTTP 401)"));
    await render();
    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(keyInput, "bad-key");
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("rejected this API key");
  });

  it("shows a non-admin the status plus who can fix it", async () => {
    mockAdapterStatus.mockResolvedValue({ hermesProvider: hermesProvider({ canConfigure: false }) });
    mockAdmins.mockResolvedValue({
      admins: [{ userId: "u1", name: "Asha Instance", email: "asha@x.test", membershipRole: "admin", canFix: true }],
    });
    await render();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('[data-testid="model-key-readonly"]')).not.toBeNull();
    expect(container.textContent).toContain("Only an administrator can change the model key");
    expect(container.textContent).toContain("Asha Instance");
  });

  it("explains when the workspace does not use a hosted provider", async () => {
    mockAdapterStatus.mockResolvedValue({
      hermesProvider: hermesProvider({ required: false, configured: false, provider: null, model: null, configuredAt: null }),
    });
    await render();
    expect(container.querySelector('[data-testid="model-key-not-required"]')?.textContent).toContain(
      "does not use a hosted model provider",
    );
  });

  it("renders the not-found page on the MK profile", async () => {
    mockCompany.selectedCompany = { id: "company-1", name: "Paperclip MK", productProfile: "agentdash_mk" };
    await render();
    expect(container.querySelector('[data-testid="company-model-key"]')).toBeNull();
    expect(mockAdapterStatus).not.toHaveBeenCalled();
  });
});
