// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStewardshipsApi = vi.hoisted(() => ({ getOverrideInbox: vi.fn() }));
const mockApprovalsApi = vi.hoisted(() => ({ override: vi.fn() }));
const mockCompany = vi.hoisted(() => ({
  value: { selectedCompanyId: "company-1", selectedCompany: { id: "company-1" } },
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("../api/stewardships", () => ({ stewardshipsApi: mockStewardshipsApi }));
vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => mockCompany.value }));

const { default: OverrideInbox } = await import("./OverrideInbox");
const { ApiError } = await import("../api/client");

function item(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-1",
    type: "request_board_approval",
    status: "pending",
    revision: 4,
    payload: {},
    createdAt: new Date().toISOString(),
    decidedAt: null,
    expiresAt: null,
    requestingAgent: { id: "agent-1", name: "Marketing Agent", role: "marketing" },
    sourceIssues: [],
    risk: { level: "high", reason: "Governed action" },
    effectiveAuthority: { steward: { userId: "user-2", since: "" }, minimumApproval: "steward" },
    decisionHistory: {
      decidedAt: null,
      decidedByUserId: null,
      decisionChannel: null,
      decisionActorRole: null,
      overrideReason: null,
      supersededAt: null,
    },
    requiresOverride: true,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <OverrideInbox />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("OverrideInbox", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mockCompany.value = {
      selectedCompanyId: "company-1",
      selectedCompany: { id: "company-1" },
    };
    mockApprovalsApi.override.mockResolvedValue({});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("refuses to submit an override without a written reason", async () => {
    mockStewardshipsApi.getOverrideInbox.mockResolvedValue({ items: [item()] });

    await render();

    const buttons = Array.from(container.querySelectorAll("button"));
    const approve = buttons.find((b) => b.textContent?.includes("approve"));
    expect(approve).toBeDefined();
    // A reason is mandatory: bypassing a steward must always be explained.
    expect(approve!.disabled).toBe(true);
    expect(mockApprovalsApi.override).not.toHaveBeenCalled();
  });

  it("submits the reason and the revision it rendered", async () => {
    mockStewardshipsApi.getOverrideInbox.mockResolvedValue({ items: [item()] });

    await render();

    const input = container.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "Steward on leave");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const approve = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("approve"),
    )!;
    expect(approve.disabled).toBe(false);
    await act(async () => {
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockApprovalsApi.override).toHaveBeenCalledWith("approval-1", {
      decision: "approved",
      overrideReason: "Steward on leave",
      revision: 4,
    });
  });

  it("labels the surface as exceptional rather than an ordinary approval control", async () => {
    mockStewardshipsApi.getOverrideInbox.mockResolvedValue({ items: [item()] });

    await render();

    expect(container.textContent).toContain("Emergency override");
    expect(container.textContent).toContain("Overriding is exceptional");
    expect(container.textContent).toContain("Override & approve");
    // Never a bare "Approve" that could be mistaken for the steward action.
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons.every((label) => label.includes("Override"))).toBe(true);
  });

  it("shows approvals that have no requesting agent", async () => {
    mockStewardshipsApi.getOverrideInbox.mockResolvedValue({
      items: [item({ requestingAgent: null, effectiveAuthority: { steward: null, minimumApproval: null } })],
    });

    await render();

    expect(container.textContent).toContain("no requesting agent");
    expect(container.textContent).toContain("administrators decide");
  });

  it("warns, and will not reject, when a hire approval's agent is already active", async () => {
    // Rejecting a hire terminates its agent. When the agent was already
    // approved from its own page, that is a working agent — the page must say
    // so before an administrator types a reason and presses reject.
    mockStewardshipsApi.getOverrideInbox.mockResolvedValue({
      items: [
        item({
          type: "hire_agent",
          hireAgent: { id: "agent-9", name: "Helper", status: "idle" },
        }),
      ],
    });

    await render();

    const input = container.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "cleaning up");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.textContent).toContain("Helper is already active");
    expect(container.textContent).toContain("would terminate a working agent");
    const buttons = Array.from(container.querySelectorAll("button"));
    const reject = buttons.find((b) => b.textContent?.includes("reject"))!;
    const approve = buttons.find((b) => b.textContent?.includes("approve"))!;
    expect(reject.disabled).toBe(true);
    // Approving still records the decision the agent page already made.
    expect(approve.disabled).toBe(false);
  });

  it("does not warn for a hire whose agent is still waiting on the approval", async () => {
    mockStewardshipsApi.getOverrideInbox.mockResolvedValue({
      items: [
        item({
          type: "hire_agent",
          hireAgent: { id: "agent-9", name: "Helper", status: "pending_approval" },
        }),
      ],
    });

    await render();

    expect(container.textContent).not.toContain("already active");
  });

  it("shows the available-on-request state when stewardship is off for the company", async () => {
    mockStewardshipsApi.getOverrideInbox.mockRejectedValue(
      new ApiError("Company not found", 404, null),
    );

    await render();

    expect(mockStewardshipsApi.getOverrideInbox).toHaveBeenCalledWith("company-1");
    expect(container.querySelector('[data-testid="available-on-request"]')).not.toBeNull();
    expect(container.textContent).toContain("Emergency override");
    expect(container.textContent).toContain(
      "Available on request — ask us to turn on stewardship for your workspace.",
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a 403 (not an admin) as an error rather than available-on-request", async () => {
    mockStewardshipsApi.getOverrideInbox.mockRejectedValue(
      new ApiError("The override view requires company owner or administrator access", 403, null),
    );

    await render();

    expect(container.querySelector('[data-testid="available-on-request"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("administrator access");
  });
});
