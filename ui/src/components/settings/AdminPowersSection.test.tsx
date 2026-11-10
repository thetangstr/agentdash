// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Admin powers: the company switches. Owners and admins change them; members
 * see them disabled with one plain line. Each power starts off.
 */

const mockCompaniesApi = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../../api/companies", () => ({ companiesApi: mockCompaniesApi }));

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

  it("lets an admin turn each power on through the company settings PATCH", async () => {
    await render({ company: company(), canManage: true, showReadOnlyNotice: false });
    expect(byTestId("admin-powers-read-only")).toBeNull();
    await click(byTestId("admin-powers-directive-read-toggle")!);
    expect(mockCompaniesApi.update).toHaveBeenLastCalledWith("company-1", { adminDirectiveReadEnabled: true });
    await click(byTestId("admin-powers-transcript-read-toggle")!);
    expect(mockCompaniesApi.update).toHaveBeenLastCalledWith("company-1", { adminTranscriptReadEnabled: true });
    await click(byTestId("admin-powers-assistant-batches-toggle")!);
    expect(mockCompaniesApi.update).toHaveBeenLastCalledWith("company-1", { assistantAdminBatchesEnabled: true });
    // The record limit only applies once Claude batches are allowed.
    expect(byTestId<HTMLInputElement>("admin-powers-assistant-batch-max")!.disabled).toBe(true);
  });

  it("saves the record limit (1 to 200) when Claude batches are allowed", async () => {
    await render({ company: company({ assistantAdminBatchesEnabled: true }), canManage: true, showReadOnlyNotice: false });
    const input = byTestId<HTMLInputElement>("admin-powers-assistant-batch-max")!;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("50");
    const setValue = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await setValue("250");
    expect(container.textContent).toContain("Enter a whole number from 1 to 200.");
    expect(byTestId("admin-powers-assistant-batch-max-save")).toBeNull();
    await setValue("120");
    await click(byTestId("admin-powers-assistant-batch-max-save")!);
    expect(mockCompaniesApi.update).toHaveBeenLastCalledWith("company-1", { assistantBatchMaxRecords: 120 });
  });
});
