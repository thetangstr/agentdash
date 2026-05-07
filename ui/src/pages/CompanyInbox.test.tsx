// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyInbox = vi.hoisted(() => vi.fn());
const mockUseCompany = vi.hoisted(() => vi.fn());
const mockChatPanel = vi.hoisted(() => vi.fn(({ conversationId, companyId, headerProps }) => (
  <div className="chat-panel" data-conversation-id={conversationId} data-company-id={companyId}>
    <h1>{headerProps?.agentName}</h1>
    <p>{headerProps?.agentRole}</p>
  </div>
)));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryFn, enabled }: { queryFn: () => unknown; enabled?: boolean }) => {
    if (enabled === false) {
      return { data: null, isLoading: false, error: null };
    }
    const data = queryFn();
    return { data, isLoading: false, error: null };
  },
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  (globalThis as any).React = actual;
  return actual;
});

vi.mock("../api/conversations", () => ({
  conversationsApi: {
    companyInbox: mockCompanyInbox,
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: mockUseCompany,
}));

vi.mock("./ChatPanel", () => ({
  default: mockChatPanel,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompanyInbox", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockUseCompany.mockReturnValue({ selectedCompany: { id: "company-1", name: "Acme" } });
    mockCompanyInbox.mockReturnValue({ id: "conversation-1", companyId: "company-1", title: "Company Inbox", status: "active" });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("loads the selected company's inbox conversation and renders chat", async () => {
    await act(async () => {
      const { CompanyInbox } = await import("./CompanyInbox");
      root.render(<CompanyInbox />);
    });
    await act(async () => {});

    expect(mockCompanyInbox).toHaveBeenCalledWith("company-1");
    expect(container.querySelector(".chat-panel")?.getAttribute("data-conversation-id")).toBe("conversation-1");
    expect(container.textContent).toContain("Company Inbox");
    expect(container.textContent).toContain("Chat with Acme's CoS and route work into Paperclip objects.");
  });

  it("asks the user to select a company when none is selected", async () => {
    mockUseCompany.mockReturnValue({ selectedCompany: null });

    await act(async () => {
      const { CompanyInbox } = await import("./CompanyInbox");
      root.render(<CompanyInbox />);
    });

    expect(container.textContent).toContain("Select a company to open Company Chat.");
    expect(mockCompanyInbox).not.toHaveBeenCalled();
  });
});
