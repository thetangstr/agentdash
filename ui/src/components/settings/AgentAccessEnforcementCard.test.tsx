// @vitest-environment jsdom
//
// Agent Performance Management gate 2: the company's access-rule mode.
// Admins pick among the modes the server offers; anything else is visible
// but disabled; members see the mode read-only. Refusals are shown.
// Gate 3: enforce is offered, and choosing it opens a confirmation that says
// plainly what changes; nothing is sent until the admin confirms.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";

const mockAccessApi = vi.hoisted(() => ({ listMembers: vi.fn() }));
const mockEnforcementApi = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));

vi.mock("../../api/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/access")>();
  return { ...actual, accessApi: mockAccessApi };
});
vi.mock("../../api/agent-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-profiles")>();
  return { ...actual, agentAccessEnforcementApi: mockEnforcementApi };
});

const { AgentAccessEnforcementCard, ENFORCE_UNAVAILABLE_TEXT, ENFORCE_CHANGES, ENFORCE_CONFIRM_TITLE } = await import(
  "./AgentAccessEnforcementCard"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function members(canManageAgents: boolean) {
  return {
    members: [],
    access: {
      currentUserRole: canManageAgents ? "owner" : "member",
      canManageMembers: canManageAgents,
      canInviteUsers: canManageAgents,
      canApproveJoinRequests: canManageAgents,
      canManageAgents,
    },
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AgentAccessEnforcementCard companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  return container;
}

/** The real response shape (routes/agent-access-enforcement.ts). */
function view(mode: string, selectableModes: string[] = ["off", "shadow"]) {
  return { companyId: "company-1", mode, selectableModes };
}

function radio(node: HTMLElement, mode: string): HTMLInputElement {
  return node.querySelector<HTMLInputElement>(`[data-testid='access-enforcement-${mode}']`)!;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("AgentAccessEnforcementCard", () => {
  it("lets an admin choose off or shadow, with enforce shown disabled when the server doesn't offer it", async () => {
    mockAccessApi.listMembers.mockResolvedValue(members(true));
    mockEnforcementApi.get.mockResolvedValue(view("off"));
    mockEnforcementApi.set.mockResolvedValue({ ...view("shadow"), changed: true, previousMode: "off" });
    const node = await render();

    expect(mockEnforcementApi.get).toHaveBeenCalledWith("company-1");
    expect(node.querySelector("legend")?.textContent).toBe("Mode");
    expect(radio(node, "off").checked).toBe(true);
    expect(radio(node, "shadow").disabled).toBe(false);
    expect(radio(node, "enforce").disabled).toBe(true);
    const enforceDescription = document.getElementById(radio(node, "enforce").getAttribute("aria-describedby")!);
    expect(enforceDescription?.textContent).toContain(ENFORCE_UNAVAILABLE_TEXT);
    expect(ENFORCE_UNAVAILABLE_TEXT).toBe("Not available on this server yet");
    // Labels are wired to their radios.
    const shadowLabel = Array.from(node.querySelectorAll("label")).find((label) => label.htmlFor === radio(node, "shadow").id);
    expect(shadowLabel?.textContent).toBe("Shadow");

    await act(async () => {
      radio(node, "shadow").click();
    });
    await flush();
    expect(mockEnforcementApi.set).toHaveBeenCalledWith("company-1", "shadow");
    expect(radio(node, "shadow").checked).toBe(true);
    const status = node.querySelector("[data-testid='access-enforcement-status']");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toBe("Access rule checking is now shadow.");
  });

  it("never sends enforce when the server doesn't offer it", async () => {
    mockAccessApi.listMembers.mockResolvedValue(members(true));
    mockEnforcementApi.get.mockResolvedValue(view("shadow"));
    const node = await render();
    await act(async () => {
      radio(node, "enforce").click();
    });
    await flush();
    expect(mockEnforcementApi.set).not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-testid='access-enforcement-confirm']")).toBeNull();
  });

  it("asks before turning on enforcement, says what changes, and sends nothing on cancel", async () => {
    mockAccessApi.listMembers.mockResolvedValue(members(true));
    mockEnforcementApi.get.mockResolvedValue(view("shadow", ["off", "shadow", "enforce"]));
    mockEnforcementApi.set.mockResolvedValue({ ...view("enforce", ["off", "shadow", "enforce"]), changed: true, previousMode: "shadow" });
    const node = await render();
    expect(radio(node, "enforce").disabled).toBe(false);

    await act(async () => {
      radio(node, "enforce").click();
    });
    await flush();
    const dialog = document.body.querySelector<HTMLElement>("[data-testid='access-enforcement-confirm']")!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.textContent).toContain(ENFORCE_CONFIRM_TITLE);
    for (const line of ENFORCE_CHANGES) expect(dialog.textContent).toContain(line);
    expect(dialog.textContent).toContain("Agents are refused anything outside the access their operating profile defines");
    expect(dialog.textContent).toContain("accountable person, steward and company admins always stay reachable");
    expect(dialog.textContent).toContain("You can switch back to Shadow or Off at any time.");
    // Nothing is sent yet, and the stored mode is still the checked one.
    expect(mockEnforcementApi.set).not.toHaveBeenCalled();
    expect(radio(node, "shadow").checked).toBe(true);

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>("[data-testid='access-enforcement-confirm-cancel']")!.click();
    });
    await flush();
    expect(document.body.querySelector("[data-testid='access-enforcement-confirm']")).toBeNull();
    expect(mockEnforcementApi.set).not.toHaveBeenCalled();
    expect(radio(node, "shadow").checked).toBe(true);

    await act(async () => {
      radio(node, "enforce").click();
    });
    await flush();
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>("[data-testid='access-enforcement-confirm-enforce']")!.click();
    });
    await flush();
    expect(mockEnforcementApi.set).toHaveBeenCalledWith("company-1", "enforce");
    expect(radio(node, "enforce").checked).toBe(true);
    expect(node.querySelector("[data-testid='access-enforcement-status']")?.textContent).toBe("Access rule checking is now enforce.");
  });

  it("leaves enforce without a confirmation", async () => {
    mockAccessApi.listMembers.mockResolvedValue(members(true));
    mockEnforcementApi.get.mockResolvedValue(view("enforce", ["off", "shadow", "enforce"]));
    mockEnforcementApi.set.mockResolvedValue({ ...view("shadow", ["off", "shadow", "enforce"]), changed: true, previousMode: "enforce" });
    const node = await render();
    await act(async () => {
      radio(node, "shadow").click();
    });
    await flush();
    expect(document.body.querySelector("[data-testid='access-enforcement-confirm']")).toBeNull();
    expect(mockEnforcementApi.set).toHaveBeenCalledWith("company-1", "shadow");
  });

  it("enables exactly the modes the server says are selectable", async () => {
    mockAccessApi.listMembers.mockResolvedValue(members(true));
    mockEnforcementApi.get.mockResolvedValue(view("off", ["off"]));
    let node = await render();
    expect(radio(node, "off").disabled).toBe(false);
    expect(radio(node, "shadow").disabled).toBe(true);
    expect(radio(node, "enforce").disabled).toBe(true);
    await act(async () => {
      radio(node, "shadow").click();
    });
    await flush();
    expect(mockEnforcementApi.set).not.toHaveBeenCalled();
    act(() => root!.unmount());
    container!.remove();
    root = null;
    container = null;

    // A server that offers enforce (gate 3) gets it enabled, with no "after gate 3" note.
    mockEnforcementApi.get.mockResolvedValue(view("shadow", ["off", "shadow", "enforce"]));
    node = await render();
    expect(radio(node, "enforce").disabled).toBe(false);
    expect(document.getElementById(radio(node, "enforce").getAttribute("aria-describedby")!)?.textContent).not.toContain(
      ENFORCE_UNAVAILABLE_TEXT,
    );
  });

  it("shows a server refusal and keeps the stored mode", async () => {
    mockAccessApi.listMembers.mockResolvedValue(members(true));
    mockEnforcementApi.get.mockResolvedValue(view("off"));
    mockEnforcementApi.set.mockRejectedValue(new ApiError("Company admin required", 403, { error: "Company admin required" }));
    const node = await render();
    await act(async () => {
      radio(node, "shadow").click();
    });
    await flush();
    const alert = node.querySelector("[data-testid='access-enforcement-error']");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe("The mode was not changed: Company admin required");
    expect(radio(node, "off").checked).toBe(true);
  });

  it("shows members the current mode read-only", async () => {
    mockAccessApi.listMembers.mockResolvedValue(members(false));
    mockEnforcementApi.get.mockResolvedValue(view("shadow"));
    const node = await render();
    expect(node.querySelectorAll("input[type='radio']")).toHaveLength(0);
    const readonly = node.querySelector("[data-testid='access-enforcement-readonly']")?.textContent ?? "";
    expect(readonly).toContain("Current mode: Shadow");
    expect(readonly).toContain("Nothing is refused");
    expect(readonly).toContain("Only company admins can change this.");
  });

  it("says when the mode can't be read", async () => {
    mockAccessApi.listMembers.mockResolvedValue(members(true));
    mockEnforcementApi.get.mockRejectedValue(new ApiError("Not found", 404, { error: "Not found" }));
    const node = await render();
    expect(node.querySelector("[role='alert']")?.textContent).toBe("Couldn't read the current mode: Not found");
  });
});
