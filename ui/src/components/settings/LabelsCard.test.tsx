// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AgentDash admin powers: the Labels card in Company Settings → Work.
 * Rename and recolor through PATCH /labels/:id. Owners and admins delete one
 * or several through the shared preview dialog (which says how many tasks lose
 * each label); a member deletes one at a time through DELETE /labels/:id and
 * never sees the multi-select.
 */

const dialog = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("../batch/BatchPreviewDialog", () => ({
  BatchPreviewDialog: (props: Record<string, unknown>) => {
    dialog.last = props;
    return <div data-testid="dialog-open" />;
  },
}));
const mockIssuesApi = vi.hoisted(() => ({ listLabels: vi.fn(), updateLabel: vi.fn(), deleteLabel: vi.fn() }));
vi.mock("../../api/issues", () => ({ issuesApi: mockIssuesApi }));
const mockCapabilitiesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../api/capabilities", () => ({ capabilitiesApi: mockCapabilitiesApi }));
function viewerIs(admin: boolean) {
  mockCapabilitiesApi.get.mockResolvedValue({ companyId: "company-1", actorType: "board", membershipRole: admin ? "owner" : "member", isInstanceAdmin: false, capabilities: { "company:manage": admin } });
}

const { LabelsCard } = await import("./LabelsCard");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dialog.last = null;
  vi.clearAllMocks();
  mockIssuesApi.listLabels.mockResolvedValue([
    { id: "l1", companyId: "company-1", name: "Bug", color: "#ff0000" },
    { id: "l2", companyId: "company-1", name: "UI", color: "#00ff00" },
  ]);
  mockIssuesApi.updateLabel.mockResolvedValue({});
  mockIssuesApi.deleteLabel.mockResolvedValue({});
  viewerIs(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><LabelsCard companyId="company-1" /></QueryClientProvider>);
  });
  await flush();
}

async function setValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text || b.getAttribute("aria-label") === text) as HTMLButtonElement;

describe("LabelsCard", () => {
  it("lists the labels", async () => {
    await render();
    expect(container.querySelectorAll('[data-testid="labels-row"]')).toHaveLength(2);
  });

  it("renames a label", async () => {
    await render();
    await setValue(container.querySelector<HTMLInputElement>('input[aria-label="Name of Bug"]')!, "Defect");
    await act(async () => { button("Rename").click(); });
    await flush();
    expect(mockIssuesApi.updateLabel).toHaveBeenCalledWith("l1", { name: "Defect" });
  });

  it("recolors a label once the picker is left, not on every step", async () => {
    await render();
    const picker = container.querySelector<HTMLInputElement>('input[aria-label="Color of UI"]')!;
    await setValue(picker, "#0000ff");
    expect(mockIssuesApi.updateLabel).not.toHaveBeenCalled();
    await act(async () => { picker.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await flush();
    expect(mockIssuesApi.updateLabel).toHaveBeenCalledWith("l2", { color: "#0000ff" });
  });

  it("an owner or admin deletes one, or several selected, through the preview dialog", async () => {
    await render();
    await act(async () => { button("Delete Bug").click(); });
    expect(dialog.last).toMatchObject({ kind: "label.delete", ids: ["l1"], companyId: "company-1" });
    await act(async () => { (dialog.last!.onOpenChange as (open: boolean) => void)(false); });
    for (const box of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await act(async () => { box.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="labels-delete-selected"]')!.click(); });
    expect(dialog.last).toMatchObject({ kind: "label.delete", ids: ["l1", "l2"] });
  });

  describe("a member", () => {
    beforeEach(() => viewerIs(false));

    it("sees no checkboxes and no delete-selected", async () => {
      await render();
      expect(container.querySelectorAll('[data-testid="labels-row"]')).toHaveLength(2);
      expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
      expect(container.querySelector('[data-testid="labels-delete-selected"]')).toBeNull();
    });

    it("still renames a label", async () => {
      await render();
      await setValue(container.querySelector<HTMLInputElement>('input[aria-label="Name of UI"]')!, "Interface");
      await act(async () => { button("Rename").click(); });
      await flush();
      expect(mockIssuesApi.updateLabel).toHaveBeenCalledWith("l2", { name: "Interface" });
    });

    it("deletes one label through its own route after a confirm, not through a batch", async () => {
      await render();
      await act(async () => { button("Delete Bug").click(); });
      expect(dialog.last).toBeNull();
      expect(mockIssuesApi.deleteLabel).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="labels-confirm-delete"]')!.textContent).toContain("Delete Bug?");
      await act(async () => { button("Delete label").click(); });
      await flush();
      expect(mockIssuesApi.deleteLabel).toHaveBeenCalledWith("l1");
      expect(dialog.last).toBeNull();
    });

    it("can cancel the delete", async () => {
      await render();
      await act(async () => { button("Delete Bug").click(); });
      await act(async () => { button("Cancel").click(); });
      expect(container.querySelector('[data-testid="labels-confirm-delete"]')).toBeNull();
      expect(mockIssuesApi.deleteLabel).not.toHaveBeenCalled();
    });
  });
});
