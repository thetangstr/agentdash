import { describe, expect, it } from "vitest";
import { renderAgentMemoryPrompt } from "@paperclipai/adapter-utils/server-utils";
import { AGENT_MEMORY_CONTEXT_KEY } from "@paperclipai/shared";
import {
  AGENT_MEMORY_WITHHELD_TEXT,
  withholdAgentMemoryFromInvocationPayload,
  withholdAgentMemoryFromPrompt,
  withholdAgentMemoryFromRunEvents,
  withoutAgentMemoryContext,
} from "../services/agent-memory-redaction.js";

const SECRET = "SENTINEL-memory-lesson-41f9: always label figures as estimated.";
const memory = {
  version: 3,
  content: `Durable notes.\n\n${SECRET}\nSecond paragraph.`,
  writtenAt: "2026-10-01T12:00:00.000Z",
  authorKind: "agent",
};

/**
 * Memory reaches the run as context and as a rendered prompt section. Both
 * copies are persisted with the run (context snapshot, `adapter.invoke` event)
 * and served to anyone who can read the run, so they are withheld there.
 */
describe("agent memory redaction", () => {
  it("drops the memory key from a run context and leaves the rest", () => {
    const context = { issueId: "i-1", [AGENT_MEMORY_CONTEXT_KEY]: memory };
    const stripped = withoutAgentMemoryContext(context);
    expect(stripped).toEqual({ issueId: "i-1" });
    // The live context the adapter runs with is not mutated.
    expect(context[AGENT_MEMORY_CONTEXT_KEY]).toBe(memory);
  });

  it("returns a context without memory unchanged", () => {
    const context = { issueId: "i-1" };
    expect(withoutAgentMemoryContext(context)).toBe(context);
    expect(withoutAgentMemoryContext(null)).toBeNull();
  });

  it("replaces the exact rendered section in a prompt and keeps what surrounds it", () => {
    const prompt = ["## Directives\nbe brief", renderAgentMemoryPrompt(memory), "## Wake\ndo the task"].join("\n\n");
    const out = withholdAgentMemoryFromPrompt(prompt, memory);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("Second paragraph");
    expect(out).toContain(AGENT_MEMORY_WITHHELD_TEXT);
    expect(out).toContain("## Directives\nbe brief");
    expect(out).toContain("## Wake\ndo the task");
  });

  it("cuts from the memory heading to the end when the stored prompt was truncated", () => {
    const rendered = renderAgentMemoryPrompt(memory);
    const truncated = `preamble\n\n${rendered.slice(0, rendered.indexOf(SECRET) + 12)}[truncated]`;
    const out = withholdAgentMemoryFromPrompt(truncated, memory);
    expect(out).not.toContain("SENTINEL-mem");
    expect(out).toBe(`preamble\n\n${AGENT_MEMORY_WITHHELD_TEXT}`);
  });

  it("finds the section by its heading when the context copy is missing", () => {
    const prompt = `intro\n\n${renderAgentMemoryPrompt(memory)}`;
    const out = withholdAgentMemoryFromPrompt(prompt, null);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`intro\n\n${AGENT_MEMORY_WITHHELD_TEXT}`);
  });

  it("leaves a mandate that merely names the heading alone", () => {
    const prompt = "Memory is rendered into your prompt under `## Your Memory`.";
    expect(withholdAgentMemoryFromPrompt(prompt, null)).toBe(prompt);
  });

  it("strips both copies from an adapter.invoke payload", () => {
    const payload = {
      adapterType: "claude_local",
      prompt: `before\n\n${renderAgentMemoryPrompt(memory)}\n\nafter`,
      context: { issueId: "i-1", [AGENT_MEMORY_CONTEXT_KEY]: memory },
    };
    const out = withholdAgentMemoryFromInvocationPayload(payload);
    expect(JSON.stringify(out)).not.toContain("SENTINEL-memory");
    expect(out.prompt).toBe(`before\n\n${AGENT_MEMORY_WITHHELD_TEXT}\n\nafter`);
    expect(out.context).toEqual({ issueId: "i-1" });
    expect(out.adapterType).toBe("claude_local");
  });

  it("only rewrites adapter.invoke events in an event list", () => {
    const events = [
      { eventType: "lifecycle", payload: { note: SECRET } },
      {
        eventType: "adapter.invoke",
        payload: { prompt: renderAgentMemoryPrompt(memory), context: { [AGENT_MEMORY_CONTEXT_KEY]: memory } },
      },
      { eventType: "adapter.invoke", payload: null },
    ];
    const out = withholdAgentMemoryFromRunEvents(events);
    expect(out[0]).toBe(events[0]);
    expect(JSON.stringify(out[1])).not.toContain("SENTINEL-memory");
    expect(out[2]).toBe(events[2]);
  });
});
