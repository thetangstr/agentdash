// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvaluationDemo } from "./EvaluationDemo";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(<EvaluationDemo />)); }
async function select(name: string) { const button = [...container.querySelectorAll("button")].find(item => item.textContent?.includes(name)); expect(button).toBeTruthy(); await act(async () => button!.click()); return button!; }
describe("simulated task evidence", () => {
  it("shows supporting evidence without inventing owner acceptance or a business outcome", async () => {
    await render();
    expect(container.textContent).toContain("Simulated walkthrough");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Evidence checked");
    expect(container.textContent).toContain("$36,000 + $12,200 = $48,200");
    expect(container.textContent).toContain("Owner decision not recorded");
    expect(container.textContent).toContain("Not measured by this check");
  });
  it("catches a polished false completion from an observed missing section", async () => {
    await render(); await select("Convincing false success");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("False success detected");
    expect(container.textContent).toContain("Risks & next actions");
    expect(container.textContent).toContain("absent from the saved content");
    expect(container.querySelector('[data-check="sections"]')?.textContent).toContain("Failed");
    expect(container.textContent).toContain("Owner decision not recorded");
  });
  it("does not pass missing proof even when the reported number happens to match", async () => {
    await render(); await select("Missing proof");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Unverified");
    expect(container.querySelector('[data-check="total"]')?.textContent).toContain("Unverified");
    expect(container.querySelector('[data-check="total"]')?.textContent).not.toContain("Supported");
    expect(container.textContent).toContain("$48,200");
    expect(container.textContent).toContain("Not supplied");
  });
  it("keeps a legitimate approval block separate from completion or platform error", async () => {
    await render(); const button = await select("Approval required");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Approval blocked");
    expect(container.textContent).toContain("Protected access was not attempted");
    expect(container.textContent).toContain("Not complete");
    expect(container.textContent).toContain("not a platform error");
    await act(async () => { button.focus(); button.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(document.activeElement?.textContent).toContain("Evidence checks pass");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Evidence checked");
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  });
});
