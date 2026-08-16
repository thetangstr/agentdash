// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The markdown chain is stubbed, not exercised. `MarkdownEditor` transitively
 * imports `@codesandbox/sandpack-react`, which throws inside jsdom's CSS parser
 * at import time — every other test in this repo dodges it by mocking
 * `InlineEditor` outright, which is exactly what makes `readOnly` untested.
 *
 * So the stubs stand in for the editor, and the assertions are about which
 * BRANCH renders: read-only shows text with no affordance, editable shows the
 * editor. That is the whole behaviour `readOnly` controls; the editor's own
 * behaviour is not what is under test here.
 */
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <textarea defaultValue={value} />,
}));
vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("./FoldCurtain", () => ({
  FoldCurtain: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { InlineEditor } from "./InlineEditor";

/**
 * `readOnly` is the primitive every direction surface now depends on, so it is
 * worth testing directly rather than only through the pages that use it.
 *
 * The property is not "looks different". It is that there is **no way in**: a
 * click must not open an editor, because an editor that opens and then fails to
 * save is exactly the "did that work?" confusion the permission work exists to
 * remove.
 */

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

async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

describe("InlineEditor readOnly", () => {
  it("shows the value", async () => {
    await render(<InlineEditor value="Weekly board pack" onSave={() => {}} readOnly />);
    expect(container.textContent).toContain("Weekly board pack");
  });

  it("does not open an editor when clicked", async () => {
    const onSave = vi.fn();
    await render(<InlineEditor value="Weekly board pack" onSave={onSave} readOnly />);

    const display = container.firstElementChild as HTMLElement;
    await act(async () => display.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers no pointer affordance — it reads as text, not a control", async () => {
    // A cursor that says "click me" on something that cannot be clicked is the
    // same lie as a disabled button, just quieter.
    await render(<InlineEditor value="Weekly board pack" onSave={() => {}} readOnly />);
    expect((container.firstElementChild as HTMLElement).className).not.toContain("cursor-pointer");
  });

  it("still opens an editor when NOT read-only", async () => {
    // The control case. Without it, a component that never renders an editor at
    // all would pass every assertion above.
    await render(<InlineEditor value="Weekly board pack" onSave={() => {}} />);

    const display = container.firstElementChild as HTMLElement;
    expect(display.className).toContain("cursor-pointer");
    await act(async () => display.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.querySelector("input") ?? container.querySelector("textarea")).not.toBeNull();
  });
});
