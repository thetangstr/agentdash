import { describe, expect, it } from "vitest";
import {
  renderAgentCorrectionsPrompt,
  renderAgentMemoryPrompt,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { AGENT_MEMORY_CONTEXT_KEY } from "@paperclipai/shared";
import {
  AGENT_CORRECTIONS_WITHHELD_TEXT,
  AGENT_MEMORY_WITHHELD_TEXT,
  withholdPrivateContentFromInvocationPayload,
  withholdPrivateContentFromRunEvents,
  withholdPrivateContentFromText,
  withoutPrivateRunContext,
} from "../services/run-private-content.js";

const SECRET = "SENTINEL-memory-lesson-41f9: always label figures as estimated.";
const memory = {
  version: 3,
  content: `Durable notes.\n\n${SECRET}\nSecond paragraph.`,
  writtenAt: "2026-10-01T12:00:00.000Z",
  authorKind: "agent",
};

const CORRECTION_SECRET = "SENTINEL-correction-8a2b";
const corrections = [
  {
    id: "c-1",
    kind: "steward_send_back",
    issueId: "i-1",
    issueIdentifier: "ABC-1",
    summary: `Person A sent your draft back.\nTheir note: "${CORRECTION_SECRET} lead with the total."`,
    lessons: [`Lead with the total ${CORRECTION_SECRET}`],
    createdAt: "2026-10-02T09:00:00.000Z",
  },
];
const wake = { reason: "issue_assigned", corrections, correctionsRemaining: 2 };

function contextWithEverything() {
  return {
    issueId: "i-1",
    [AGENT_MEMORY_CONTEXT_KEY]: memory,
    paperclipAgentCorrections: corrections,
    paperclipAgentCorrectionsRemaining: 2,
    paperclipWake: wake,
  };
}

/**
 * Memory and the corrections that feed it reach the run as context and as
 * rendered prompt sections. Every copy is persisted with the run (context
 * snapshot, `adapter.invoke` event) and served to anyone who can read the
 * run, so they are withheld there. The live context the adapter runs with is
 * never touched.
 */
describe("private run content", () => {
  it("drops memory and corrections from a run context and leaves the rest", () => {
    const context = contextWithEverything();
    const stripped = withoutPrivateRunContext(context) as Record<string, any>;
    expect(stripped).not.toHaveProperty(AGENT_MEMORY_CONTEXT_KEY);
    expect(stripped).not.toHaveProperty("paperclipAgentCorrections");
    expect(stripped).not.toHaveProperty("paperclipAgentCorrectionsRemaining");
    expect(stripped.paperclipWake).toEqual({ reason: "issue_assigned" });
    expect(stripped.issueId).toBe("i-1");
    expect(JSON.stringify(stripped)).not.toContain("SENTINEL");
    // Not mutated: the adapter still receives everything.
    expect(context[AGENT_MEMORY_CONTEXT_KEY]).toBe(memory);
    expect(context.paperclipWake.corrections).toBe(corrections);
  });

  it("returns a context without private keys unchanged", () => {
    const context = { issueId: "i-1", paperclipWake: { reason: "x" } };
    expect(withoutPrivateRunContext(context)).toBe(context);
    expect(withoutPrivateRunContext(null)).toBeNull();
  });

  it("replaces the exact memory section in a prompt and keeps what surrounds it", () => {
    const prompt = ["## Directives\nbe brief", renderAgentMemoryPrompt(memory), "## Wake\ndo the task"].join("\n\n");
    const out = withholdPrivateContentFromText(prompt, contextWithEverything());
    expect(out).not.toContain(SECRET);
    expect(out).toContain(AGENT_MEMORY_WITHHELD_TEXT);
    expect(out).toContain("## Directives\nbe brief");
    expect(out).toContain("## Wake\ndo the task");
  });

  it("replaces the exact What changed section of a wake prompt and keeps the rest of the wake", () => {
    const wakePrompt = renderPaperclipWakePrompt(wake);
    expect(wakePrompt).toContain(CORRECTION_SECRET);
    const prompt = `intro\n\n${wakePrompt}\n\n## Task\nwrite it`;
    const out = withholdPrivateContentFromText(prompt, contextWithEverything());
    expect(out).not.toContain(CORRECTION_SECRET);
    expect(out).toContain(AGENT_CORRECTIONS_WITHHELD_TEXT);
    expect(out).toContain("## Task\nwrite it");
  });

  it("replaces the Hermes-escaped corrections section too", () => {
    const hermes = renderAgentCorrectionsPrompt(corrections, 2).replace(/\{\{/g, "{ {");
    const out = withholdPrivateContentFromText(`role\n\n${hermes}\n\ntask`, contextWithEverything());
    expect(out).toBe(`role\n\n${AGENT_CORRECTIONS_WITHHELD_TEXT}\n\ntask`);
  });

  it("cuts from a heading to the end when the stored text was truncated", () => {
    const rendered = renderAgentMemoryPrompt(memory);
    const truncated = `preamble\n\n${rendered.slice(0, rendered.indexOf(SECRET) + 12)}[truncated]`;
    expect(withholdPrivateContentFromText(truncated, contextWithEverything())).toBe(`preamble\n\n${AGENT_MEMORY_WITHHELD_TEXT}`);
    const section = renderAgentCorrectionsPrompt(corrections, 2);
    const cut = `before\n${section.slice(0, section.indexOf(CORRECTION_SECRET) + 5)}`;
    expect(withholdPrivateContentFromText(cut, null)).toBe(`before\n${AGENT_CORRECTIONS_WITHHELD_TEXT}`);
  });

  it("withholds a section whose heading is still there, even when a marker appears elsewhere", () => {
    const prompt = `${AGENT_MEMORY_WITHHELD_TEXT}\n\nintro\n\n${renderAgentMemoryPrompt(memory)}`;
    const out = withholdPrivateContentFromText(prompt, null);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`${AGENT_MEMORY_WITHHELD_TEXT}\n\nintro\n\n${AGENT_MEMORY_WITHHELD_TEXT}`);
  });

  it("leaves a non-JSON string that starts with a brace and mentions corrections as text", () => {
    const payload = { note: '{ "corrections" were discussed, not a payload' };
    expect(withholdPrivateContentFromInvocationPayload(payload)).toEqual(payload);
  });

  it("finds a section by its heading when no context copy is available", () => {
    const prompt = `intro\n\n${renderAgentMemoryPrompt(memory)}`;
    expect(withholdPrivateContentFromText(prompt, null)).toBe(`intro\n\n${AGENT_MEMORY_WITHHELD_TEXT}`);
  });

  it("leaves a mandate that merely names the headings alone", () => {
    const prompt = "Memory is rendered under `## Your Memory`; corrections under `## What changed (corrections to your work)`.";
    expect(withholdPrivateContentFromText(prompt, null)).toBe(prompt);
  });

  it("strips every copy from an adapter.invoke payload: prompt, context, wake payload env", () => {
    const context = contextWithEverything();
    const payload = {
      adapterType: "claude_local",
      prompt: `before\n\n${renderAgentMemoryPrompt(memory)}\n\n${renderPaperclipWakePrompt(wake)}\n\nafter`,
      context,
      env: { PAPERCLIP_WAKE_PAYLOAD_JSON: stringifyPaperclipWakePayload(wake), HOME: "/home/agent" },
      commandArgs: ["--print", "-"],
    };
    const out = withholdPrivateContentFromInvocationPayload(payload) as Record<string, any>;
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
    expect(out.prompt).toContain(AGENT_MEMORY_WITHHELD_TEXT);
    expect(out.prompt).toContain(AGENT_CORRECTIONS_WITHHELD_TEXT);
    expect(out.prompt.endsWith("after")).toBe(true);
    expect(out.context.issueId).toBe("i-1");
    expect(JSON.parse(out.env.PAPERCLIP_WAKE_PAYLOAD_JSON).reason).toBe("issue_assigned");
    expect(out.env.HOME).toBe("/home/agent");
    expect(out.commandArgs).toEqual(["--print", "-"]);
    // The adapter's own objects are not mutated.
    expect(context.paperclipWake.corrections).toBe(corrections);
    expect(payload.env.PAPERCLIP_WAKE_PAYLOAD_JSON).toContain(CORRECTION_SECRET);
  });

  it("only rewrites adapter.invoke events in an event list", () => {
    const events = [
      { eventType: "lifecycle", payload: { note: "run started" } },
      {
        eventType: "adapter.invoke",
        payload: { prompt: renderAgentMemoryPrompt(memory), context: contextWithEverything() },
      },
      { eventType: "adapter.invoke", payload: null },
    ];
    const out = withholdPrivateContentFromRunEvents(events);
    expect(out[0]).toBe(events[0]);
    expect(JSON.stringify(out[1])).not.toContain("SENTINEL");
    expect(out[2]).toBe(events[2]);
  });
});
