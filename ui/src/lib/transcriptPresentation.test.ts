import { describe, expect, it } from "vitest";
import { describeToolInput, isPlumbingOutputLine, summarizeToolInput, summarizeToolResult } from "./transcriptPresentation";

describe("summarizeToolInput", () => {
  it("prefers human descriptions over raw commands when both exist", () => {
    expect(
      summarizeToolInput("command_execution", {
        description: "Inspect the issue chat thread layout classes",
        command: "zsh -lc 'sed -n \"1,220p\" ui/src/components/IssueChatThread.tsx'",
      }),
    ).toBe("Inspect the issue chat thread layout classes");
  });
});

describe("describeToolInput", () => {
  it("keeps command tools description-first in the detail view", () => {
    expect(
      describeToolInput("command_execution", {
        description: "Inspect the issue chat thread layout classes",
        command: "zsh -lc 'sed -n \"1,220p\" ui/src/components/IssueChatThread.tsx'",
        cwd: "/workspace/paperclip",
      }),
    ).toEqual([
      { label: "Intent", value: "Inspect the issue chat thread layout classes", tone: "default" },
      { label: "Directory", value: "/workspace/paperclip", tone: "default" },
    ]);
  });

  it("surfaces concise structured details for file tools", () => {
    expect(
      describeToolInput("read_file", {
        path: "ui/src/lib/issue-chat-messages.ts",
      }),
    ).toEqual([
      { label: "Path", value: "ui/src/lib/issue-chat-messages.ts", tone: "default" },
    ]);
  });
});

// AgentDash (c4-stops): wire plumbing inside a tool's output must never be
// the line a collapsed row quotes.
describe("isPlumbingOutputLine", () => {
  it("classifies the plumbing shapes seen on hosted transcripts", () => {
    for (const line of [
      "=== SINGLE COMMENT ===",
      "=== RAW DOC PUT ===",
      "--- stderr ---",
      "HTTP: 201",
      "HTTP/1.1 200 OK",
      "exit_code: 0",
      "exit code 1",
      "workProducts:",
      "DATABASE_URL=postgres://localhost/db",
      "===",
      "---",
    ]) {
      expect(isPlumbingOutputLine(line), line).toBe(true);
    }
  });

  it("keeps real outcome lines", () => {
    for (const line of [
      "Got issue ACM-9",
      "Error: Document update requires baseRevisionId",
      "All 42 checks pass",
      "Status: all green",
      "Error: bad request",
    ]) {
      expect(isPlumbingOutputLine(line), line).toBe(false);
    }
  });
});

describe("summarizeToolResult plumbing", () => {
  it("skips banners and status echoes to the first real line", () => {
    expect(
      summarizeToolResult("=== SINGLE COMMENT ===\nHTTP: 201\nexit code 0\nComment posted on the issue.", false),
    ).toBe("Comment posted on the issue.");
  });

  it("surfaces a real error line after plumbing", () => {
    expect(
      summarizeToolResult("=== RAW DOC PUT ===\nError: Document update requires baseRevisionId", true),
    ).toBe("Error: Document update requires baseRevisionId");
  });
});
