// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AgentDash admin powers: the Issues list's action bar. Each menu builds one
 * change and opens the shared preview dialog with the selected tasks.
 */

const dialogProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("./BatchPreviewDialog", () => ({
  BatchPreviewDialog: (props: Record<string, unknown>) => {
    dialogProps.last = props;
    return <div data-testid="dialog-open" />;
  },
}));

const { IssuesBulkBar } = await import("./IssuesBulkBar");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dialogProps.last = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function render() {
  await act(async () => {
    root.render(
      <IssuesBulkBar
        companyId="company-1"
        selectedIds={["a", "b"]}
        agents={[{ id: "agent-1", name: "Builder" }]}
        people={[{ id: "me", name: "Me Myself" }, { id: "sam", name: "Sam" }]}
        projects={[{ id: "p1", name: "Launch" }]}
        labels={[{ id: "l1", name: "Bug" }]}
        currentUserId="me"
        onClear={vi.fn()}
        onFinished={vi.fn()}
      />,
    );
  });
}

async function pick(menuTestId: string, itemText: string) {
  const trigger = container.querySelector(`[data-testid="${menuTestId}"]`)!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const item = [...document.body.querySelectorAll('[data-slot="dropdown-menu-item"]')].find((el) => el.textContent === itemText);
  expect(item, itemText).toBeTruthy();
  await act(async () => {
    item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("IssuesBulkBar", () => {
  it("shows the count and every action, phone-sized", async () => {
    await render();
    expect(container.querySelector('[data-testid="issues-bulk-count"]')!.textContent).toBe("2 selected");
    for (const id of ["issues-bulk-status", "issues-bulk-assignee", "issues-bulk-labels", "issues-bulk-project", "issues-bulk-priority"]) {
      expect(container.querySelector(`[data-testid="${id}"]`)!.className, id).toContain("max-sm:min-h-11");
    }
  });

  it.each([
    ["issues-bulk-status", "Done", { status: "done" }],
    ["issues-bulk-priority", "High", { priority: "high" }],
    ["issues-bulk-assignee", "Builder", { assignee: { agentId: "agent-1" } }],
    ["issues-bulk-assignee", "Sam", { assignee: { userId: "sam" } }],
    ["issues-bulk-assignee", "No one", { assignee: null }],
    ["issues-bulk-labels", "Add Bug", { addLabelIds: ["l1"] }],
    ["issues-bulk-labels", "Remove Bug", { removeLabelIds: ["l1"] }],
    ["issues-bulk-project", "Launch", { projectId: "p1" }],
    ["issues-bulk-project", "No project", { projectId: null }],
  ] as const)("%s → %s opens the preview with that change", async (menu, label, change) => {
    await render();
    await pick(menu, label);
    expect(dialogProps.last).toMatchObject({ kind: "issue.update", ids: ["a", "b"], change, companyId: "company-1" });
  });

  it("formats fields in plain words for the dialog", async () => {
    await render();
    await pick("issues-bulk-status", "Done");
    const format = dialogProps.last!.formatField as (field: string, value: unknown) => { label: string; value: string } | null;
    expect(format("status", "in_progress")).toEqual({ label: "Status", value: "In progress" });
    expect(format("assigneeAgentId", "agent-1")).toEqual({ label: "Agent", value: "Builder" });
    expect(format("assigneeUserId", "me")).toEqual({ label: "Person", value: "You" });
    expect(format("projectId", null)).toEqual({ label: "Project", value: "None" });
    expect(format("labelIds", ["l1"])).toEqual({ label: "Labels", value: "Bug" });
    expect(format("assigneeAgentId", "someone-else")).toEqual({ label: "Agent", value: "Someone you cannot see" });
  });
});
