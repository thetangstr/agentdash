// @vitest-environment jsdom
// AgentDash (scan 3, lane G): "Create this task?" — only the requester confirms.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockConfirm = vi.hoisted(() => vi.fn());
const mockDismiss = vi.hoisted(() => vi.fn());

vi.mock("../../api/auth", () => ({ authApi: { getSession: mockGetSession } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("../../api/conversations", () => ({
  conversationsApi: { confirmTaskProposal: mockConfirm, dismissTaskProposal: mockDismiss },
}));

import { IssueProposalCard, issueProposalActions, type IssueProposalCardPayload } from "./IssueProposalCard";
import { issueCreatedNextStep } from "./IssueCreatedCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const payload = {
  status: "pending" as const,
  title: "Draft the Acme proposal",
  description: "Two pages.",
  assigneeName: "Ellie",
  requesterUserId: "user-a",
};

describe("issueCreatedNextStep", () => {
  it("follows the issue's starting status", () => {
    expect(issueCreatedNextStep("Ellie", "backlog")).toBe("Added to Ellie's backlog.");
    expect(issueCreatedNextStep("Ellie", "todo")).toBe("Assigned to Ellie. They'll start on it now.");
    expect(issueCreatedNextStep(null, "todo")).toBeNull();
  });
});

describe("IssueProposalCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockConfirm.mockReset();
    mockDismiss.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  let client: QueryClient;
  async function render(userId: string, cardPayload: IssueProposalCardPayload = payload) {
    mockGetSession.mockResolvedValue({ user: { id: userId } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <IssueProposalCard payload={cardPayload} conversationId="conv1" messageId="card1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {});
  }

  function button(label: string) {
    return Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label) ?? null;
  }

  it("lets the requester create the task, then links it", async () => {
    mockConfirm.mockResolvedValue({
      issue: { issueId: "i1", identifier: "ACM-7", title: "Draft the Acme proposal", assigneeName: "Ellie", status: "backlog" },
    });
    await render("user-a");
    expect(container.textContent).toContain("Create this task?");
    await act(async () => button("Create task")!.click());
    expect(mockConfirm).toHaveBeenCalledWith("conv1", "card1", { start: false });
    expect(container.textContent).toContain("ACM-7 · Draft the Acme proposal");
    expect(container.textContent).toContain("Added to Ellie's backlog.");
  });

  it("shows someone else the card without the buttons", async () => {
    await render("user-b");
    // The buttons show until the session is known; wait for it.
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Waiting for the person who asked to confirm it.");
    });
    expect(button("Create task")).toBeNull();
  });

  it("shows the server's polite refusal", async () => {
    mockConfirm.mockRejectedValue(new Error("You don't have permission to hand out work in this workspace."));
    await render("user-a");
    await act(async () => button("Create task")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("permission");
  });

  // Scan 4, lane N: with a backlog default, "Create" parks the task and
  // "Create and start" starts it now; the primary action matches the default.
  it("offers Create (primary) and Create and start when new work parks in the backlog", async () => {
    mockConfirm.mockResolvedValue({
      issue: { issueId: "i1", identifier: "ACM-7", title: "Draft the Acme proposal", assigneeName: "Ellie", status: "todo" },
    });
    await render("user-a", { ...payload, defaultStatus: "backlog" });
    expect(button("Create task")).toBeNull();
    expect(button("Create")!.className).toContain("bg-accent-500");
    expect(button("Create and start")!.className).not.toContain("bg-accent-500");
    await act(async () => button("Create and start")!.click());
    expect(mockConfirm).toHaveBeenCalledWith("conv1", "card1", { start: true });
    expect(container.textContent).toContain("They'll start on it now.");
  });

  it("keeps a single Create task when new work starts by default", () => {
    expect(issueProposalActions("todo")).toEqual([{ kind: "create", label: "Create task", primary: true }]);
    expect(issueProposalActions(undefined)).toEqual([{ kind: "create", label: "Create task", primary: true }]);
    expect(issueProposalActions("backlog").map((a) => [a.label, a.primary])).toEqual([
      ["Create", true],
      ["Create and start", false],
    ]);
  });

  // A state pushed live (message.updated) re-renders the card for every viewer.
  it("follows a created or declined state pushed from the server", async () => {
    await render("user-b");
    await render("user-b", { ...payload, status: "created", issueId: "i9", identifier: "ACM-9", issueStatus: "todo" });
    expect(container.querySelector('[data-testid="issue-created-card"]')).not.toBeNull();
    expect(container.textContent).toContain("ACM-9 · Draft the Acme proposal");
    expect(container.querySelector('[data-testid="issue-proposal-card"]')).toBeNull();
  });

  it("can be declined", async () => {
    mockDismiss.mockResolvedValue({ proposal: { status: "dismissed" } });
    await render("user-a");
    await act(async () => button("Not now")!.click());
    expect(container.textContent).toContain("Task not created");
    expect(button("Create task")).toBeNull();
  });
});
