// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Admin powers: the company switches. Owners and admins change them; members
 * see them disabled with one plain line. Each power starts off. Every control
 * is a draft until "Save changes", which sends only the changed fields.
 */

const mockCompaniesApi = vi.hoisted(() => ({ update: vi.fn() }));
// AgentDash admin powers: the ceiling-template list behind "Ceiling for new agents".
const mockCeilingTemplatesApi = vi.hoisted(() => ({ list: vi.fn(async () => ({ templates: [] })) }));
vi.mock("../../api/ceilingTemplates", () => ({ ceilingTemplatesApi: mockCeilingTemplatesApi }));
vi.mock("../../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => <a href={to} {...props}>{children}</a>,
  };
});

const { AdminPowersSection } = await import("./AdminPowersSection");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockCompaniesApi.update.mockResolvedValue({});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function company(overrides: Partial<Company> = {}): Company {
  return {
    id: "company-1",
    name: "Meridian",
    adminDirectiveReadEnabled: false,
    adminTranscriptReadEnabled: false,
    assistantAdminBatchesEnabled: false,
    assistantBatchMaxRecords: 50,
    ...overrides,
  } as Company;
}

async function render(props: { company: Company; canManage: boolean; showReadOnlyNotice: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <AdminPowersSection {...props} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
}

const byTestId = <T extends Element>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
const TOGGLES = ["admin-powers-directive-read-toggle", "admin-powers-transcript-read-toggle", "admin-powers-assistant-batches-toggle"];

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function setValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AdminPowersSection", () => {
  it("shows a member every switch, off and disabled, with one plain line", async () => {
    await render({ company: company(), canManage: false, showReadOnlyNotice: true });
    expect(container.textContent).toContain("Admin powers");
    expect(byTestId("admin-powers-read-only")?.textContent).toBe("Only owners and admins can change these.");
    for (const id of TOGGLES) {
      const el = byTestId<HTMLButtonElement>(id)!;
      expect(el.disabled, id).toBe(true);
      expect(el.getAttribute("aria-checked"), id).toBe("false");
    }
    expect(byTestId<HTMLInputElement>("admin-powers-assistant-batch-max")!.disabled).toBe(true);
    await click(byTestId(TOGGLES[0]!)!);
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();
    // Plain wording: no internal names on the page.
    expect(container.textContent).not.toMatch(/assistant_admin|admin_directive|company:manage/);
  });

  it("links owners and admins to the admin audit; members get no link", async () => {
    await render({ company: company(), canManage: true, showReadOnlyNotice: false });
    expect(byTestId<HTMLAnchorElement>("admin-powers-audit-link")?.getAttribute("href")).toBe("/company/settings/audit");
    act(() => root.unmount());
    root = createRoot(container);
    await render({ company: company(), canManage: false, showReadOnlyNotice: true });
    expect(byTestId("admin-powers-audit-link")).toBeNull();
  });

  it("flipping a switch sends nothing until Save, and Save sends only the changed fields in one request", async () => {
    await render({ company: company(), canManage: true, showReadOnlyNotice: false });
    expect(byTestId("admin-powers-read-only")).toBeNull();
    const save = byTestId<HTMLButtonElement>("admin-powers-save")!;
    expect(save.textContent).toBe("Save changes");
    expect(save.disabled).toBe(true);
    expect(byTestId("admin-powers-state")!.textContent).toBe("");

    await click(byTestId("admin-powers-directive-read-toggle")!);
    await click(byTestId("admin-powers-assistant-batches-toggle")!);
    // Nothing is sent until "Save changes".
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();
    expect(byTestId("admin-powers-directive-read-toggle")!.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("admin-powers-state")!.textContent).toBe("Unsaved changes");
    expect(save.disabled).toBe(false);
    // The record limit opens as soon as Claude batches are on in the draft.
    expect(byTestId<HTMLInputElement>("admin-powers-assistant-batch-max")!.disabled).toBe(false);

    await click(save);
    await flush();
    expect(mockCompaniesApi.update).toHaveBeenCalledTimes(1);
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", {
      adminDirectiveReadEnabled: true,
      assistantAdminBatchesEnabled: true,
    });
    expect(byTestId("admin-powers-state")!.textContent).toBe("Saved");
  });

  it("flipping a switch back to the saved value leaves nothing to save", async () => {
    await render({ company: company(), canManage: true, showReadOnlyNotice: false });
    await click(byTestId("admin-powers-transcript-read-toggle")!);
    expect(byTestId<HTMLButtonElement>("admin-powers-save")!.disabled).toBe(false);
    await click(byTestId("admin-powers-transcript-read-toggle")!);
    expect(byTestId<HTMLButtonElement>("admin-powers-save")!.disabled).toBe(true);
    expect(byTestId("admin-powers-state")!.textContent).toBe("");
    expect(byTestId("admin-powers-discard")).toBeNull();
  });

  it("Discard resets the draft to the saved values without sending", async () => {
    await render({ company: company({ assistantAdminBatchesEnabled: true }), canManage: true, showReadOnlyNotice: false });
    await click(byTestId("admin-powers-directive-read-toggle")!);
    await setValue(byTestId<HTMLInputElement>("admin-powers-assistant-batch-max")!, "120");
    await click(byTestId("admin-powers-discard")!);
    expect(byTestId("admin-powers-directive-read-toggle")!.getAttribute("aria-checked")).toBe("false");
    expect(byTestId<HTMLInputElement>("admin-powers-assistant-batch-max")!.value).toBe("50");
    expect(byTestId<HTMLButtonElement>("admin-powers-save")!.disabled).toBe(true);
    expect(byTestId("admin-powers-discard")).toBeNull();
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();
  });

  it("a failed save shows the error and keeps the draft", async () => {
    mockCompaniesApi.update.mockRejectedValueOnce(new Error("Only owners and admins can change this."));
    await render({ company: company(), canManage: true, showReadOnlyNotice: false });
    await click(byTestId("admin-powers-transcript-read-toggle")!);
    await click(byTestId("admin-powers-save")!);
    await flush();
    const alert = byTestId("admin-powers-error")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe("Only owners and admins can change this.");
    expect(byTestId("admin-powers-transcript-read-toggle")!.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("admin-powers-state")!.textContent).toBe("Unsaved changes");
    expect(byTestId<HTMLButtonElement>("admin-powers-save")!.disabled).toBe(false);

    // Trying again sends the same draft, and a success clears the error.
    await click(byTestId("admin-powers-save")!);
    await flush();
    expect(mockCompaniesApi.update).toHaveBeenCalledTimes(2);
    expect(mockCompaniesApi.update).toHaveBeenLastCalledWith("company-1", { adminTranscriptReadEnabled: true });
    expect(byTestId("admin-powers-error")).toBeNull();
  });

  it("a save error goes away when the switch is flipped back by hand", async () => {
    mockCompaniesApi.update.mockRejectedValueOnce(new Error("Only owners and admins can change this."));
    await render({ company: company(), canManage: true, showReadOnlyNotice: false });
    await click(byTestId("admin-powers-directive-read-toggle")!);
    await click(byTestId("admin-powers-save")!);
    await flush();
    expect(byTestId("admin-powers-error")).not.toBeNull();
    await click(byTestId("admin-powers-directive-read-toggle")!);
    expect(byTestId<HTMLButtonElement>("admin-powers-save")!.disabled).toBe(true);
    expect(byTestId("admin-powers-discard")).toBeNull();
    expect(byTestId("admin-powers-error")).toBeNull();
  });

  it("the record limit (1 to 200) is part of the draft and blocks Save while it is not valid", async () => {
    await render({ company: company({ assistantAdminBatchesEnabled: true }), canManage: true, showReadOnlyNotice: false });
    const input = byTestId<HTMLInputElement>("admin-powers-assistant-batch-max")!;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("50");
    await setValue(input, "250");
    expect(container.textContent).toContain("Enter a whole number from 1 to 200.");
    expect(byTestId<HTMLButtonElement>("admin-powers-save")!.disabled).toBe(true);
    await setValue(input, "120");
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();
    await click(byTestId("admin-powers-save")!);
    await flush();
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { assistantBatchMaxRecords: 120 });
  });

  it("Ceiling for new agents: lists the templates, saves the choice on Save, and is disabled for people who cannot manage settings", async () => {
    mockCeilingTemplatesApi.list.mockResolvedValue({ templates: [{ id: "t1", name: "Contractors" }] } as never);
    await render({ company: company({ defaultCeilingTemplateId: "t1" }), canManage: true, showReadOnlyNotice: false });
    await flush();
    const select = byTestId<HTMLSelectElement>("admin-powers-default-ceiling")!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["None", "Contractors"]);
    expect(select.value).toBe("t1");
    expect(container.textContent).toContain("Applies to agents created from now on; existing agents keep their ceilings.");
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();
    await click(byTestId("admin-powers-save")!);
    await flush();
    // "None" is sent as no ceiling.
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { defaultCeilingTemplateId: null });
    act(() => root.unmount());
    root = createRoot(container);
    await render({ company: company(), canManage: false, showReadOnlyNotice: true });
    await flush();
    expect(byTestId<HTMLSelectElement>("admin-powers-default-ceiling")!.disabled).toBe(true);
    // People who cannot manage settings get no save row.
    expect(byTestId("admin-powers-save")).toBeNull();
  });

  it("Ceiling for new agents is disabled while the templates load, and says 'available on request' where there are no ceilings", async () => {
    mockCeilingTemplatesApi.list.mockReturnValue(new Promise(() => undefined) as never);
    await render({ company: company(), canManage: true, showReadOnlyNotice: false });
    expect(byTestId<HTMLSelectElement>("admin-powers-default-ceiling")!.disabled).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    const { ApiError } = await import("../../api/client");
    mockCeilingTemplatesApi.list.mockRejectedValue(new ApiError("Company not found", 404, null) as never);
    await render({ company: company(), canManage: true, showReadOnlyNotice: false });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(byTestId("admin-powers-default-ceiling-unavailable")!.textContent).toBe("Agent ceilings are available on request.");
    mockCeilingTemplatesApi.list.mockImplementation(async () => ({ templates: [] }));
  });
});
