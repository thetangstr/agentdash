import { describe, expect, it } from "vitest";
import { shortenInstancePaths } from "./instancePaths";

const WS = "/paperclip/instances/default/workspaces/43e8155e-a1b2-4c3d-9e8f-001122334455";

describe("shortenInstancePaths", () => {
  it("shows a workspace file as its path inside the workspace", () => {
    expect(
      shortenInstancePaths(`Local copy: ${WS}/competitor-scan-warehouse-picking-grippers.md`),
    ).toBe("Local copy: competitor-scan-warehouse-picking-grippers.md");
  });

  it("keeps directories relative to the workspace", () => {
    expect(shortenInstancePaths(`wrote ${WS}/notes/plan.md next`)).toBe("wrote notes/plan.md next");
  });

  it("does not eat sentence punctuation after the path", () => {
    expect(shortenInstancePaths(`Saved to ${WS}/scan.md.`)).toBe("Saved to scan.md.");
    expect(shortenInstancePaths(`see ${WS}/a.md, then x`)).toBe("see a.md, then x");
  });

  it("shortens other instance-internal paths to the file name", () => {
    expect(shortenInstancePaths("log at /paperclip/instances/default/logs/run-1.log")).toBe("log at run-1.log");
  });

  it("handles quoted paths and markdown links", () => {
    expect(shortenInstancePaths(`File "${WS}/x.py", line 3`)).toBe('File "x.py", line 3');
    expect(shortenInstancePaths(`[scan](${WS}/scan.md)`)).toBe("[scan](scan.md)");
  });

  it("leaves non-instance absolute paths alone", () => {
    expect(shortenInstancePaths("wrote /tmp/output/result.md")).toBe("wrote /tmp/output/result.md");
    expect(shortenInstancePaths("instances are not paths")).toBe("instances are not paths");
  });

  it("handles several paths in one text", () => {
    expect(shortenInstancePaths(`${WS}/a.md and ${WS}/b.md`)).toBe("a.md and b.md");
  });
});
