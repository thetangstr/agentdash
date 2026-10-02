// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileList, ResponsiveTable } from "./ResponsiveTable";
import { mockViewportWidth } from "../lib/test-viewport";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: string; name: string; cost: string; when: string };
const ROWS: Row[] = [
  { id: "a", name: "Alpha", cost: "$1.00", when: "today" },
  { id: "b", name: "Beta", cost: "$2.50", when: "yesterday" },
];

function Table() {
  return (
    <ResponsiveTable<Row>
      rows={ROWS}
      getRowKey={(row) => row.id}
      rowHref={(row) => `/things/${row.id}`}
      columns={[
        { key: "name", header: "Name", cell: (row) => row.name },
        { key: "cost", header: "Cost", cell: (row) => row.cost, align: "right" },
      ]}
      mobileRow={(row) => ({ primary: row.name, secondary: row.when, trailing: row.cost })}
    />
  );
}

describe("ResponsiveTable / MobileList", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("switches at the sm edge: 639px is a phone, 640px gets the table", () => {
    const restorePhone = mockViewportWidth(639);
    act(() => root.render(<Table />));
    expect(container.querySelector("[data-testid='mobile-list']")).not.toBeNull();
    act(() => root.unmount());
    restorePhone();

    root = createRoot(container);
    mockViewportWidth(640);
    act(() => root.render(<Table />));
    expect(container.querySelector("table")).not.toBeNull();
  });

  it("renders a table on desktop", () => {
    mockViewportWidth(1280);
    act(() => root.render(<Table />));
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelectorAll("th")[1]?.className).toContain("text-right");
    expect(container.querySelector("[data-testid='mobile-list']")).toBeNull();
  });

  it("renders stacked two-line rows with 44px targets on a phone", () => {
    mockViewportWidth(390);
    act(() => root.render(<Table />));
    expect(container.querySelector("table")).toBeNull();
    const rows = container.querySelectorAll("[data-testid='mobile-list-row']");
    expect(rows).toHaveLength(2);
    const link = rows[1]!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/things/b");
    expect(link.className).toContain("min-h-11");
    expect(link.textContent).toContain("Beta");
    expect(link.textContent).toContain("yesterday");
    expect(link.textContent).toContain("$2.50");
  });

  it("MobileList renders plain rows without a link", () => {
    mockViewportWidth(390);
    act(() => root.render(<MobileList rows={[{ key: "x", primary: "Only", secondary: "line two" }]} />));
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("Onlyline two");
  });
});
