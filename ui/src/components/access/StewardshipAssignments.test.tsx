// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockStewardshipsApi = vi.hoisted(() => ({
  getAgentStewardship: vi.fn(),
  getAgentStewardshipHistory: vi.fn(),
  assign: vi.fn(),
  transfer: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/stewardships", () => ({ stewardshipsApi: mockStewardshipsApi }));

const { StewardshipAssignments } = await import("./StewardshipAssignments");

const MEMBERS = [
  { id: "m-1", principalId: "user-1", status: "active", user: { name: "Ada" } },
  { id: "m-2", principalId: "user-2", status: "active", user: { name: "Grace" } },
  { id: "m-3", principalId: "user-3", status: "archived", user: { name: "Archived" } },
] as never[];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(canManage = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <StewardshipAssignments companyId="company-1" members={MEMBERS} canManage={canManage} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function selectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function typeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function byLabel(label: string) {
  return container.querySelector(`[aria-label="${label}"]`);
}

describe("StewardshipAssignments", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "Marketing Agent" }]);
    mockStewardshipsApi.getAgentStewardship.mockResolvedValue({ stewardship: null });
    mockStewardshipsApi.getAgentStewardshipHistory.mockResolvedValue({ stewardships: [] });
    mockStewardshipsApi.assign.mockResolvedValue({ stewardship: {} });
    mockStewardshipsApi.transfer.mockResolvedValue({ stewardship: {} });
    mockStewardshipsApi.release.mockResolvedValue({ stewardship: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("assigns an agent to an active member", async () => {
    await render();

    await act(async () => selectValue(byLabel("Agent") as HTMLSelectElement, "agent-1"));
    await act(async () => selectValue(byLabel("Steward") as HTMLSelectElement, "user-1"));

    const assign = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Assign agent"),
    )!;
    await act(async () => assign.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(mockStewardshipsApi.assign).toHaveBeenCalledWith("company-1", {
      agentId: "agent-1",
      userId: "user-1",
    });
  });

  it("only offers active members as stewards", async () => {
    await render();

    const options = Array.from((byLabel("Steward") as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toContain("user-1");
    expect(options).not.toContain("user-3");
  });

  it("requires a reason before an agent can be transferred", async () => {
    mockStewardshipsApi.getAgentStewardship.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-1" },
    });

    await render();
    await act(async () => selectValue(byLabel("Agent") as HTMLSelectElement, "agent-1"));
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    await act(async () => selectValue(byLabel("New steward") as HTMLSelectElement, "user-2"));

    const confirm = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Confirm transfer"),
    )!;
    // Stewardship history is the audit trail for decision authority; a transfer
    // with no reason makes it unreadable later.
    expect(confirm.disabled).toBe(true);

    await act(async () => typeValue(byLabel("Reason") as HTMLInputElement, "Role change"));
    expect(confirm.disabled).toBe(false);

    await act(async () => confirm.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(mockStewardshipsApi.transfer).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      expect.objectContaining({ userId: "user-2", transferReason: "Role change" }),
    );
  });

  it("releases an agent with a reason and without naming anyone new", async () => {
    // The case assign and transfer cannot express: this agent should stand
    // alone. Until this button existed the only way to get there was to archive
    // the person, and making an agent autonomous is refused while its pairing
    // is live.
    mockStewardshipsApi.getAgentStewardship.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-1" },
    });

    await render();
    await act(async () => selectValue(byLabel("Agent") as HTMLSelectElement, "agent-1"));
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const release = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Release"),
    )!;
    expect(release.disabled).toBe(true);

    await act(async () => typeValue(byLabel("Reason") as HTMLInputElement, "Joining the autonomous team"));
    // No new steward selected, deliberately: that is the whole point of release.
    expect(release.disabled).toBe(false);

    await act(async () => release.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(mockStewardshipsApi.release).toHaveBeenCalledWith("company-1", "agent-1", {
      releaseReason: "Joining the autonomous team",
    });
    expect(mockStewardshipsApi.transfer).not.toHaveBeenCalled();
  });

  it("disables mutations for a member who cannot manage access", async () => {
    await render(false);

    await act(async () => selectValue(byLabel("Agent") as HTMLSelectElement, "agent-1"));
    await act(async () => selectValue(byLabel("Steward") as HTMLSelectElement, "user-1"));

    const assign = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Assign agent"),
    )!;
    expect(assign.disabled).toBe(true);
    expect(container.textContent).toContain("Only a company owner or administrator");
  });
});
