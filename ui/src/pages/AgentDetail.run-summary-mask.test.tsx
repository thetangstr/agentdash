// @vitest-environment jsdom
// AgentDash (c3-a11y review #1014): stored run summaries can carry any of the
// server mask spellings; both the latest-run card and the run-list row show
// the one display mask.

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";

// AgentDetail's import graph reaches `@mdxeditor/editor` via AgentConfigForm →
// MarkdownEditor, and its Sandpack dependency throws inside jsdom's CSS parser.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

// MarkdownBody needs ThemeProvider; the assertion is on the text handed to it.
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: string; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { LatestRunCard, RunListItem } from "./AgentDetail";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function runWithSummary(id: string, summary: string): HeartbeatRun {
  return {
    id,
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: null,
    status: "succeeded",
    startedAt: new Date("2026-10-01T00:00:00Z"),
    finishedAt: new Date("2026-10-01T00:01:00Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: { summary },
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:01:00Z"),
  } as HeartbeatRun;
}

describe("run summaries show the one display mask", () => {
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

  it("the latest-run card masks a stored ***REDACTED*** marker before markdown sees it", () => {
    act(() => {
      root.render(
        <LatestRunCard
          runs={[runWithSummary("run-1", "Found the key ***REDACTED*** in the logs")]}
          agentId="agent-1"
        />,
      );
    });

    expect(container.textContent).toContain("•••• (hidden)");
    expect(container.textContent).not.toContain("REDACTED");
  });

  it("the run-list row masks the full summary before slicing", () => {
    const summary = `Token ***REDACTED*** ${"x".repeat(80)}`;
    act(() => {
      root.render(<RunListItem run={runWithSummary("run-2", summary)} isSelected={false} agentId="agent-1" />);
    });

    expect(container.textContent).toContain("•••• (hidden)");
    expect(container.textContent).not.toContain("REDACTED");
  });
});
