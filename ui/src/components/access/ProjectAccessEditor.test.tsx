// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectsApi = vi.hoisted(() => ({ getAccess: vi.fn(), replaceAccess: vi.fn(), update: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listMembers: vi.fn() }));
vi.mock("@/api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));

const { ProjectAccessEditor } = await import("./ProjectAccessEditor");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function member(principalId: string, name: string, role: "admin" | "member" = "member") {
  return {
    id: `m-${principalId}`,
    companyId: "company-1",
    principalType: "user" as const,
    principalId,
    status: "active" as const,
    membershipRole: role,
    createdAt: "",
    updatedAt: "",
    user: { id: principalId, email: `${principalId}@example.com`, name, image: null },
    grants: [],
    archive: { canArchive: true, reason: null },
  };
}

async function render(props: { visibility: "company" | "restricted"; canManage: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProjectAccessEditor projectId="project-1" companyId="company-1" {...props} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

describe("ProjectAccessEditor", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockProjectsApi.getAccess.mockReset();
    mockProjectsApi.replaceAccess.mockReset();
    mockProjectsApi.update.mockReset();
    mockAccessApi.listMembers.mockReset();
    mockAccessApi.listMembers.mockResolvedValue({
      members: [member("titus", "Titus"), member("sam", "Sam"), member("yang", "Yang", "admin")],
      access: { currentUserRole: "admin", canManageMembers: true },
    });
    mockProjectsApi.getAccess.mockResolvedValue({
      visibility: "restricted",
      access: [
        { principalType: "agent", principalId: "agent-lead", grantedByUserId: "yang" },
        { principalType: "user", principalId: "titus", grantedByUserId: "yang" },
      ],
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing for someone who cannot manage the project", async () => {
    await render({ visibility: "restricted", canManage: false });
    expect(container.textContent).toBe("");
    expect(mockProjectsApi.getAccess).not.toHaveBeenCalled();
  });

  it("lists active humans with the listed ones checked, and names administrators as seeing everything anyway", async () => {
    await render({ visibility: "restricted", canManage: true });
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes).toHaveLength(3);
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false]);
    expect(container.textContent).toContain("administrator — sees everything anyway");
  });

  it("saves the humans chosen while keeping the agents the server listed", async () => {
    mockProjectsApi.replaceAccess.mockResolvedValue({ visibility: "restricted", access: [] });
    await render({ visibility: "restricted", canManage: true });
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    await act(async () => {
      boxes[1]!.click();
    });
    const button = Array.from(container.querySelectorAll("button")).find((b) => /Save access list/.test(b.textContent ?? ""))!;
    expect(button.disabled).toBe(false);
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(mockProjectsApi.replaceAccess).toHaveBeenCalledWith(
      "project-1",
      {
        access: [
          { principalType: "agent", principalId: "agent-lead" },
          { principalType: "user", principalId: "titus" },
          { principalType: "user", principalId: "sam" },
        ],
      },
      "company-1",
    );
  });

  it("switches the project between open and restricted", async () => {
    mockProjectsApi.update.mockResolvedValue({});
    await render({ visibility: "company", canManage: true });
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Project visibility"]')!;
    await act(async () => {
      select.value = "restricted";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(mockProjectsApi.update).toHaveBeenCalledWith("project-1", { visibility: "restricted" }, "company-1");
  });
});
