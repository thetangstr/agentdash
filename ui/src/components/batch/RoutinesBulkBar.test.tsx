// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** AgentDash admin powers: the Routines action bar (archive, delete). */

const dialog = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("./BatchPreviewDialog", () => ({
  BatchPreviewDialog: (props: Record<string, unknown>) => {
    dialog.last = props;
    return <div data-testid="dialog-open" />;
  },
}));

const { RoutinesBulkBar } = await import("./RoutinesBulkBar");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RoutinesBulkBar", () => {
  it.each([["routines-bulk-archive", "routine.archive"], ["routines-bulk-delete", "routine.delete"]])("%s opens the preview for %s", async (testId, kind) => {
    await act(async () => {
      root.render(<RoutinesBulkBar companyId="company-1" selectedIds={["r1", "r2"]} onClear={vi.fn()} onFinished={vi.fn()} />);
    });
    expect(container.querySelector('[data-testid="routines-bulk-count"]')!.textContent).toBe("2 selected");
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click(); });
    expect(dialog.last).toMatchObject({ kind, ids: ["r1", "r2"], change: {} });
    const format = dialog.last!.formatField as (field: string, value: unknown) => unknown;
    expect(format("state", "deleted")).toEqual({ label: "Routine", value: "Deleted" });
    expect(format("status", "active")).toEqual({ label: "Routine", value: "On" });
  });
});
