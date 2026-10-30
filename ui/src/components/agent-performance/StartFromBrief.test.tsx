// @vitest-environment jsdom
//
// Agent Performance Management gate 5 (P5.2): "Start from a brief". The
// owner pastes or uploads Markdown, may start from the brief template (shown
// as a template, never as company facts), and saves. Saving creates the
// planning issue and nothing else: it never submits, assigns or wakes
// anyone, and the page says so. A failed save keeps the text.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";

const mockBriefs = vi.hoisted(() => ({
  create: vi.fn(),
  submit: vi.fn(),
  list: vi.fn(),
  issue: vi.fn(),
  brief: vi.fn(),
  briefRevisions: vi.fn(),
  saveBrief: vi.fn(),
  manifest: vi.fn(),
  performanceManager: vi.fn(),
}));
const mockUnbound = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../api/agent-briefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-briefs")>();
  return { ...actual, agentBriefsApi: mockBriefs };
});
vi.mock("../../api/agent-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-profiles")>();
  return { ...actual, unboundAgentProfilesApi: mockUnbound };
});
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { StartFromBrief } = await import("./StartFromBrief");
const { AGENT_BRIEF_TEMPLATE, BRIEF_SAVE_NO_WAKE_TEXT, BRIEF_TEMPLATE_NOTE } = await import("./brief-shared");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BRIEF = `# Collections at Acme

## Scenario S01 — Chase overdue invoices
Stakeholders and decision this supports: finance lead; whether to escalate
Current process and who does it today: Dana, by hand, every Monday
`;

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
const onSaved = vi.fn();

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <StartFromBrief companyId="company-1" onSaved={onSaved} />
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

function byTestId<T extends HTMLElement = HTMLElement>(scope: ParentNode, id: string): T {
  const found = scope.querySelector<T>(`[data-testid='${id}']`);
  if (!found) throw new Error(`No [data-testid=${id}]`);
  return found;
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}

function labelFor(node: HTMLElement, id: string): string {
  return node.querySelector(`label[for='${id}']`)?.textContent?.trim() ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBriefs.list.mockResolvedValue([]);
  mockUnbound.list.mockResolvedValue([]);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("StartFromBrief", () => {
  it("labels the fields and says saving wakes no one", async () => {
    const node = await render();
    const title = byTestId<HTMLInputElement>(node, "brief-title");
    const markdown = byTestId<HTMLTextAreaElement>(node, "brief-markdown");
    expect(labelFor(node, title.id)).toBe("Brief title");
    expect(labelFor(node, markdown.id)).toBe("The brief (Markdown)");
    expect(byTestId(node, "brief-save-note").textContent).toContain(BRIEF_SAVE_NO_WAKE_TEXT);
    expect(node.textContent).toContain(`Template: ${BRIEF_TEMPLATE_NOTE}`);
  });

  it("offers the brief template, labelled as a template, without moving focus", async () => {
    const node = await render();
    const useTemplate = byTestId<HTMLButtonElement>(node, "brief-use-template");
    expect(useTemplate.textContent).toBe("Use the brief template");
    expect(useTemplate.getAttribute("aria-describedby")).toBeTruthy();
    useTemplate.focus();
    await click(useTemplate);
    expect(byTestId<HTMLTextAreaElement>(node, "brief-markdown").value).toBe(AGENT_BRIEF_TEMPLATE);
    expect(document.activeElement).toBe(useTemplate);
    const notice = byTestId(node, "brief-notice");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("It's a template");
  });

  it("won't save the blank template as if it were company facts", async () => {
    const node = await render();
    await click(byTestId(node, "brief-use-template"));
    await type(byTestId(node, "brief-title"), "Collections");
    await click(byTestId(node, "brief-save"));
    expect(mockBriefs.create).not.toHaveBeenCalled();
    const markdown = byTestId<HTMLTextAreaElement>(node, "brief-markdown");
    expect(markdown.getAttribute("aria-invalid")).toBe("true");
    expect(node.textContent).toContain("This is still the blank template");
  });

  it("asks for a title and the brief inline, and sends nothing", async () => {
    const node = await render();
    await click(byTestId(node, "brief-save"));
    const title = byTestId<HTMLInputElement>(node, "brief-title");
    expect(title.getAttribute("aria-invalid")).toBe("true");
    const titleError = document.getElementById(title.getAttribute("aria-describedby")!);
    expect(titleError?.textContent).toBe("Give the brief a title.");
    expect(node.textContent).toContain("Paste or upload the brief first.");
    expect(mockBriefs.create).not.toHaveBeenCalled();
  });

  it("saves the brief — create only, never submit — and hands the result to the page", async () => {
    const result = {
      kind: "agent_brief",
      companyId: "company-1",
      issueId: "issue-1",
      identifier: "ACME-12",
      title: "Collections at Acme",
      status: "backlog",
      assigneeAgentId: null,
      document: { id: "doc-1", key: "agent-work-brief", latestRevisionId: "rev-1", latestRevisionNumber: 1 },
    };
    mockBriefs.create.mockResolvedValue(result);
    const node = await render();
    await type(byTestId(node, "brief-markdown"), BRIEF);
    // The title is suggested from the brief's own heading; the person can change it.
    expect(byTestId<HTMLInputElement>(node, "brief-title").value).toBe("Collections at Acme");
    await click(byTestId(node, "brief-save"));
    expect(mockBriefs.create).toHaveBeenCalledWith("company-1", { title: "Collections at Acme", markdown: BRIEF });
    expect(mockBriefs.submit).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(result);
    expect(node.textContent).not.toMatch(/Agent ready|Agent started|Agent hired/);
  });

  it("keeps the text when the save fails, and says nothing was saved", async () => {
    mockBriefs.create.mockRejectedValue(new ApiError("Missing permission", 403, { error: "Missing permission" }));
    const node = await render();
    await type(byTestId(node, "brief-markdown"), BRIEF);
    await type(byTestId(node, "brief-title"), "Collections");
    await click(byTestId(node, "brief-save"));
    const alert = byTestId(node, "brief-save-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("The server refused to save the brief");
    expect(alert.textContent).toContain("nothing was saved");
    expect(byTestId<HTMLTextAreaElement>(node, "brief-markdown").value).toBe(BRIEF);
    expect(onSaved).not.toHaveBeenCalled();
    expect(mockBriefs.submit).not.toHaveBeenCalled();
  });

  it("loads an uploaded Markdown file, suggests a title, and can put back what was there", async () => {
    const node = await render();
    await type(byTestId(node, "brief-markdown"), "my notes");
    const input = byTestId<HTMLInputElement>(node, "brief-file");
    const file = new File([BRIEF], "collections.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(byTestId<HTMLTextAreaElement>(node, "brief-markdown").value).toBe(BRIEF);
    expect(byTestId<HTMLInputElement>(node, "brief-title").value).toBe("Collections at Acme");
    expect(byTestId(node, "brief-notice").textContent).toContain("Loaded collections.md");
    expect(mockBriefs.create).not.toHaveBeenCalled();
    await click(byTestId(node, "brief-undo"));
    expect(byTestId<HTMLTextAreaElement>(node, "brief-markdown").value).toBe("my notes");
  });

  it("lists earlier briefs and open draft profiles", async () => {
    mockBriefs.list.mockResolvedValue([
      { id: "issue-1", title: "Collections", status: "backlog", assigneeAgentId: null, assigneeUserId: null, updatedAt: "2026-10-29T10:00:00.000Z" },
      { id: "issue-2", title: "Onboarding", status: "todo", assigneeAgentId: "agent-cos", assigneeUserId: null, updatedAt: "2026-10-29T10:00:00.000Z" },
    ]);
    mockUnbound.list.mockResolvedValue([
      { profileId: "profile-1", companyId: "company-1", agentId: null, name: "Rowan", title: "Collections assistant", latestRevision: null, createdAt: "", updatedAt: "" },
    ]);
    const node = await render();
    const briefs = byTestId(node, "brief-list");
    expect(briefs.querySelector("a[href='/agents/briefs/issue-1']")?.textContent).toBe("Collections");
    expect(briefs.textContent).toContain("saved, not sent to the planner");
    expect(briefs.textContent).toContain("with the planner");
    expect(byTestId(node, "unbound-draft-list").querySelector("a")?.getAttribute("href")).toBe("/agents/drafts/profile-1");
  });
});
