// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dndState = vi.hoisted(() => ({
  useSortable: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    disableIssueQuicklook?: boolean;
  }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
  PointerSensor: class PointerSensor {},
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useSensor: () => ({}),
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSortable: dndState.useSortable,
  verticalListSortingStrategy: {},
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

import { KanbanBoard } from "./KanbanBoard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "AGE-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Review steward card",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-08-26T00:00:00.000Z"),
    updatedAt: new Date("2026-08-26T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    assigneeSteward: {
      userId: "steward-1",
      name: "Steward One",
      email: "steward@example.test",
      source: "steward",
    },
    awaitingReviewByViewer: {
      viewerUserId: "viewer-1",
      stageType: "review",
      status: "pending",
      viewerMatchesPrincipal: true,
    },
    ...overrides,
  };
}

describe("KanbanBoard steward grouping", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dndState.useSortable.mockReset();
    dndState.useSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    });
  });

  afterEach(() => {
    container.remove();
  });

  it("disables card dragging and removes the grab affordance when grouped by steward", () => {
    const issue = createIssue({ assigneeSteward: null });
    const root = createRoot(container);

    act(() => {
      root.render(
        <KanbanBoard
          issues={[issue]}
          agents={[{ id: "agent-1", name: "Agent One" }]}
          boardGroupBy="steward"
          onUpdateIssue={() => undefined}
        />,
      );
    });

    expect(dndState.useSortable).toHaveBeenCalledWith(expect.objectContaining({
      id: issue.id,
      disabled: true,
    }));
    const card = container.querySelector(`[data-kanban-issue-id="${issue.id}"]`);
    expect(card?.className).toContain("cursor-default");
    expect(card?.className).not.toContain("cursor-grab");

    act(() => root.unmount());
  });

  it("names the empty-accountability bucket Unstewarded", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <KanbanBoard
          issues={[createIssue({ assigneeSteward: null })]}
          boardGroupBy="steward"
          onUpdateIssue={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain("Unstewarded");
    expect(container.textContent).not.toContain("Unassigned");

    act(() => root.unmount());
  });

  it("uses dark-theme variants for the review badge and active steward chip", () => {
    const issue = createIssue();
    const root = createRoot(container);

    act(() => {
      root.render(
        <KanbanBoard
          issues={[issue]}
          agents={[{ id: "agent-1", name: "Agent One" }]}
          viewerUserId="viewer-1"
          onUpdateIssue={() => undefined}
        />,
      );
    });

    const reviewBadge = container.querySelector(`[aria-label="Awaiting your review on ${issue.title}"]`);
    expect(reviewBadge?.className).toContain("dark:bg-amber-400/10");
    expect(reviewBadge?.className).toContain("dark:text-amber-300");
    expect(reviewBadge?.className).toContain("dark:border-amber-300/35");

    const stewardChip = container.querySelector('[aria-label="Steward: Steward One"]');
    expect(stewardChip?.className).toContain("dark:bg-emerald-500/10");
    expect(stewardChip?.className).toContain("dark:text-emerald-200");
    expect(stewardChip?.className).toContain("dark:border-emerald-500/30");

    act(() => root.unmount());
  });
});
