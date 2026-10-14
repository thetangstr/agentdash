import { describe, expect, it } from "vitest";
import {
  createPrivateLogState,
  createPrivateLogStripper,
  withholdPrivateContentFromLogLine,
  withholdPrivateContentFromRunLogNdjson,
} from "../services/run-log-private-content.js";
import { AGENT_CORRECTIONS_WITHHELD_TEXT, AGENT_MEMORY_WITHHELD_TEXT } from "../services/run-private-content.js";

const MEMORY = "Lessons:\n- Lead with the total, then the drivers (seen 2x).\n- SENTINEL-mem-3f1 never quote client figures.";
const NEW_MEMORY = `${MEMORY}\n- SENTINEL-new-9c2 label every figure as estimated.`;
const AGENT_ID = "6a1f6b0e-1111-4222-8333-944455556666";
const COMPANY_ID = "0b6c2e0d-aaaa-4bbb-8ccc-9ddddeeeeeee";
const memoryJson = JSON.stringify({ memory: { version: 3, content: MEMORY, authorKind: "agent" } });

// claude_local --output-format stream-json --verbose: an MCP tool call is an
// assistant line with a tool_use block, answered by a user line with a
// tool_result block (plus the CLI's top-level tool_use_result copy).
const claudeGetCall = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "tool_use", id: "toolu_get", name: "mcp__agentdash__agentdashGetMyMemory", input: {} }],
  },
  parent_tool_use_id: null,
  session_id: "sess-1",
});
const claudeGetResult = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ tool_use_id: "toolu_get", type: "tool_result", content: [{ type: "text", text: memoryJson }] }] },
  parent_tool_use_id: null,
  session_id: "sess-1",
  tool_use_result: [{ type: "text", text: memoryJson }],
});
const claudeUpdateCall = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_02",
    type: "message",
    role: "assistant",
    content: [
      { type: "tool_use", id: "toolu_put", name: "mcp__agentdash__agentdashUpdateMyMemory", input: { content: NEW_MEMORY, expectedVersion: 3 } },
    ],
  },
  session_id: "sess-1",
});
const claudeUpdateResult = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ tool_use_id: "toolu_put", type: "tool_result", content: [{ type: "text", text: JSON.stringify({ memory: { version: 4, content: NEW_MEMORY } }) }] }] },
  session_id: "sess-1",
});
const claudeOtherTool = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "toolu_issue", name: "mcp__agentdash__get_issue", input: { issueId: "ABC-1" } }] },
  session_id: "sess-1",
});
const claudeCurlMemory = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_bash",
        name: "Bash",
        input: { command: `curl -s "$PAPERCLIP_API_URL/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory"` },
      },
    ],
  },
});
const claudeCurlResult = JSON.stringify({
  type: "user",
  message: { content: [{ tool_use_id: "toolu_bash", type: "tool_result", content: memoryJson }] },
});

// codex exec --json: MCP calls are mcp_tool_call items (server, tool,
// arguments, result), shell calls are command_execution items.
const codexGetStarted = JSON.stringify({
  type: "item.started",
  item: { id: "item_4", type: "mcp_tool_call", server: "agentdash", tool: "agentdashGetMyMemory", arguments: {}, result: null, error: null, status: "in_progress" },
});
const codexGetCompleted = JSON.stringify({
  type: "item.completed",
  item: {
    id: "item_4",
    type: "mcp_tool_call",
    server: "agentdash",
    tool: "agentdashGetMyMemory",
    arguments: {},
    result: { content: [{ type: "text", text: memoryJson }], structured_content: null },
    error: null,
    status: "completed",
  },
});
const codexUpdateCompleted = JSON.stringify({
  type: "item.completed",
  item: {
    id: "item_7",
    type: "mcp_tool_call",
    server: "agentdash",
    tool: "agentdashUpdateMyMemory",
    arguments: { content: NEW_MEMORY, expectedVersion: 3 },
    result: { content: [{ type: "text", text: "{\"memory\":{\"version\":4}}" }], structured_content: null },
    error: null,
    status: "completed",
  },
});
const codexApiRequest = JSON.stringify({
  type: "item.completed",
  item: {
    id: "item_8",
    type: "mcp_tool_call",
    server: "agentdash",
    tool: "api_request",
    arguments: { method: "GET", path: `/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory/history` },
    result: { content: [{ type: "text", text: memoryJson }], structured_content: null },
    status: "completed",
  },
});
const codexCurl = JSON.stringify({
  type: "item.completed",
  item: {
    id: "item_9",
    type: "command_execution",
    command: `bash -lc 'curl -s $PAPERCLIP_API_URL/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory'`,
    aggregated_output: memoryJson,
    exit_code: 0,
    status: "completed",
  },
});
const codexOtherCommand = JSON.stringify({
  type: "item.completed",
  item: { id: "item_10", type: "command_execution", command: "bash -lc 'pnpm test'", aggregated_output: "ok 12 tests", exit_code: 0, status: "completed" },
});

const corrections = [
  {
    summary: 'Person A sent your draft back.\nTheir note: "SENTINEL-corr-77 lead with the total, always."',
    lessons: ["Lead with SENTINEL-lesson-55 the total."],
  },
];

function freshState() {
  return createPrivateLogState({ memoryContents: [MEMORY], corrections });
}

describe("run log: memory tool traffic and lesson echoes are withheld", () => {
  it("claude_local: read and write calls, by tool name and tool_use_id", () => {
    const state = freshState();
    const lines = [claudeGetCall, claudeGetResult, claudeUpdateCall, claudeUpdateResult].map((line) =>
      withholdPrivateContentFromLogLine(line, state),
    );
    const all = lines.join("\n");
    expect(all).not.toContain("SENTINEL");
    expect(all).not.toContain("Lead with the total, then the drivers");
    expect(JSON.parse(lines[0]!).message.content[0].name).toBe("mcp__agentdash__agentdashGetMyMemory");
    expect(JSON.parse(lines[1]!).message.content[0].content).toBe(AGENT_MEMORY_WITHHELD_TEXT);
    expect(JSON.parse(lines[1]!).tool_use_result).toBe(AGENT_MEMORY_WITHHELD_TEXT);
    expect(JSON.parse(lines[2]!).message.content[0].input).toEqual({ withheld: AGENT_MEMORY_WITHHELD_TEXT });
    // A later echo of the memory written mid-run is withheld too.
    const echo = withholdPrivateContentFromLogLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Saved: SENTINEL-new-9c2 label every figure as estimated." }] } }),
      state,
    );
    expect(echo).not.toContain("SENTINEL");
  });

  it("claude_local: a curl to the memory route is memory traffic", () => {
    const state = freshState();
    const out = [claudeCurlMemory, claudeCurlResult].map((line) => withholdPrivateContentFromLogLine(line, state)).join("\n");
    expect(out).not.toContain("SENTINEL");
    expect(JSON.parse(out.split("\n")[1]!).message.content[0].content).toBe(AGENT_MEMORY_WITHHELD_TEXT);
  });

  it("codex_local: mcp_tool_call read and write, api_request to the route, and a curl", () => {
    const state = freshState();
    const out = [codexGetStarted, codexGetCompleted, codexUpdateCompleted, codexApiRequest, codexCurl].map((line) =>
      withholdPrivateContentFromLogLine(line, state),
    );
    expect(out.join("\n")).not.toContain("SENTINEL");
    const completed = JSON.parse(out[1]!);
    expect(completed.item.tool).toBe("agentdashGetMyMemory");
    expect(completed.item.result.content[0].text).toBe(AGENT_MEMORY_WITHHELD_TEXT);
    expect(JSON.parse(out[2]!).item.arguments).toEqual({ withheld: AGENT_MEMORY_WITHHELD_TEXT });
    expect(JSON.parse(out[4]!).item.aggregated_output).toBe(AGENT_MEMORY_WITHHELD_TEXT);
  });

  it("leaves non-memory tool lines untouched, byte for byte", () => {
    const state = freshState();
    expect(withholdPrivateContentFromLogLine(claudeOtherTool, state)).toBe(claudeOtherTool);
    expect(withholdPrivateContentFromLogLine(codexOtherCommand, state)).toBe(codexOtherCommand);
    expect(withholdPrivateContentFromLogLine("plain progress line", state)).toBe("plain progress line");
  });

  it("withholds echoes of memory and correction text anywhere in a line", () => {
    const state = freshState();
    const assistant = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: 'Applying "SENTINEL-corr-77 lead with the total, always." and Lead with SENTINEL-lesson-55 the total.' }] },
    });
    const out = withholdPrivateContentFromLogLine(assistant, state);
    expect(out).not.toContain("SENTINEL");
    expect(out).toContain(AGENT_CORRECTIONS_WITHHELD_TEXT);
    expect(withholdPrivateContentFromLogLine("note: SENTINEL-mem-3f1 never quote client figures.", state)).toBe(
      `note: ${AGENT_MEMORY_WITHHELD_TEXT}`,
    );
  });

  it("streams: a JSON line split across chunks is still recognised", () => {
    const stripper = createPrivateLogStripper(freshState());
    const text = `${claudeGetCall}\n${claudeGetResult}\n${claudeOtherTool}\n`;
    const cut = claudeGetCall.length + 40;
    const out = stripper.push(text.slice(0, cut)) + stripper.push(text.slice(cut)) + stripper.flush();
    expect(out).not.toContain("SENTINEL");
    expect(out).toContain(claudeOtherTool);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("stored NDJSON pages: chunk by chunk, call ids carried across entries", async () => {
    const entries = [claudeGetCall, claudeGetResult, codexOtherCommand].map((chunk, index) =>
      JSON.stringify({ ts: `2026-10-0${index + 1}T00:00:00.000Z`, stream: "stdout", chunk: `${chunk}\n` }),
    );
    const out = await withholdPrivateContentFromRunLogNdjson(entries.join("\n"), freshState());
    expect(out).not.toContain("SENTINEL");
    expect(out.split("\n")[2]).toBe(entries[2]);
    // A page boundary that cut an entry: content pass only, still no echo.
    const cutLine = entries[1]!.slice(10);
    expect(await withholdPrivateContentFromRunLogNdjson(cutLine, freshState())).not.toContain("SENTINEL");
  });

  it("learns memory written by a curl PUT body, so the agent's later echo is withheld", () => {
    const state = freshState();
    const lesson = "SENTINEL-curl-lesson ask the steward before quoting any rate";
    const body = JSON.stringify({ content: `${MEMORY}\n- ${lesson}`, expectedVersion: 3 });
    const claudePut = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_curl_put",
            name: "Bash",
            input: { command: `curl -s -X PUT "$PAPERCLIP_API_URL/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory" -H 'Content-Type: application/json' -d '${body}'` },
          },
        ],
      },
    });
    const echo = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Noted: ${lesson}.` }] } });
    const out = [claudePut, echo].map((line) => withholdPrivateContentFromLogLine(line, state)).join("\n");
    expect(out).not.toContain("SENTINEL");

    const codexState = freshState();
    const codexPut = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_11",
        type: "command_execution",
        command: `bash -lc "curl -s -X PUT $PAPERCLIP_API_URL/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory --data '${body}'"`,
        aggregated_output: "{}",
        exit_code: 0,
        status: "completed",
      },
    });
    const codexEcho = JSON.stringify({ type: "item.completed", item: { id: "item_12", type: "agent_message", text: `Saved ${lesson}` } });
    expect([codexPut, codexEcho].map((line) => withholdPrivateContentFromLogLine(line, codexState)).join("\n")).not.toContain("SENTINEL");
  });

  it("learns memory from a memory-route result before withholding it", () => {
    const fresh = "SENTINEL-fresh-lesson label every figure as estimated";
    const resultJson = JSON.stringify({ memory: { id: "m", version: 5, content: `Notes\n- ${fresh}`, authorKind: "steward" } });
    // A state that has never seen this version (a steward edit after the run began).
    const claudeState = createPrivateLogState({});
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_get2", name: "mcp__agentdash__agentdashGetMyMemory", input: {} }] } }),
      JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "toolu_get2", type: "tool_result", content: [{ type: "text", text: resultJson }] }] } }),
      JSON.stringify({ type: "result", result: `Done; remember: ${fresh}.` }),
    ];
    expect(lines.map((line) => withholdPrivateContentFromLogLine(line, claudeState)).join("\n")).not.toContain("SENTINEL");

    const codexState = createPrivateLogState({});
    const codexLines = [
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_13", type: "command_execution", command: `curl -s $PAPERCLIP_API_URL/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/memory`, aggregated_output: resultJson, exit_code: 0, status: "completed" },
      }),
      JSON.stringify({ type: "item.completed", item: { id: "item_14", type: "agent_message", text: fresh } }),
    ];
    expect(codexLines.map((line) => withholdPrivateContentFromLogLine(line, codexState)).join("\n")).not.toContain("SENTINEL");
  });

  it("does not withhold short common lines that happen to be in memory", () => {
    const state = createPrivateLogState({ memoryContents: ["- git status --short\n- Run the full test suite before closing"] });
    expect(withholdPrivateContentFromLogLine("$ git status --short", state)).toBe("$ git status --short");
    expect(withholdPrivateContentFromLogLine("next: Run the full test suite before closing", state)).toBe(
      `next: ${AGENT_MEMORY_WITHHELD_TEXT}`,
    );
  });

  it("stored NDJSON: joins a stream's chunks, so a line split across entries is caught and re-framed", async () => {
    const echoLine = "Ask the steward before quoting any rate.";
    const state = createPrivateLogState({ corrections: [{ summary: "Sent back.", lessons: [echoLine] }] });
    // No stored copy at all: an update whose version never landed.
    const unstored = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_lost", name: "mcp__agentdash__agentdashUpdateMyMemory", input: { content: "SENTINEL-unstored never stored anywhere" } }] },
    });
    const entry = (stream: string, chunk: string, ts: string) => JSON.stringify({ ts, stream, chunk });
    const page = [
      entry("stdout", "Ask t", "t1"),
      entry("stderr", "warning: slow\n", "t2"),
      entry("stdout", "he steward before quoting any rate.\n", "t3"),
      entry("stdout", unstored.slice(0, 50), "t4"),
      entry("stdout", `${unstored.slice(50)}\n`, "t5"),
      entry("stdout", "plain tail\n", "t6"),
    ].join("\n");
    const out = await withholdPrivateContentFromRunLogNdjson(page, state);
    expect(out).not.toContain("SENTINEL");
    expect(out).not.toContain("he steward before quoting");
    const entries = out.split("\n").map((line) => JSON.parse(line) as { ts: string; stream: string; chunk: string });
    // Re-framed: each cleaned line sits in the entry where it ended; the
    // stderr entry and the untouched tail keep their place.
    expect(entries.map((e) => e.ts)).toEqual(["t2", "t3", "t5", "t6"]);
    expect(entries[1]!.chunk).toBe(`${AGENT_CORRECTIONS_WITHHELD_TEXT}\n`);
    expect(JSON.parse(entries[2]!.chunk).message.content[0].input).toEqual({ withheld: AGENT_MEMORY_WITHHELD_TEXT });
    expect(entries[3]!.chunk).toBe("plain tail\n");
  });

  it("stored NDJSON: a memory result whose call was on an earlier page is still recognised by its shape", async () => {
    const resultJson = JSON.stringify({ memory: { id: "m", version: 2, content: "SENTINEL-nextpage lead with the total", authorKind: "agent" } });
    const resultLine = JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "toolu_prev_page", type: "tool_result", content: [{ type: "text", text: resultJson }] }] } });
    const page = JSON.stringify({ ts: "t9", stream: "stdout", chunk: `${resultLine}\n` });
    const out = await withholdPrivateContentFromRunLogNdjson(page, createPrivateLogState({}));
    expect(out).not.toContain("SENTINEL");
    expect(out).toContain("toolu_prev_page");
  });

  it("never matches a tiny whole memory or summary on its own: log lines stay valid and untouched", () => {
    const lines = [claudeOtherTool, codexOtherCommand, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } })];
    for (const tiny of ["assistant", "text", '"}', "done"]) {
      const state = createPrivateLogState({ memoryContents: [tiny], corrections: [{ summary: tiny, lessons: [] }] });
      for (const line of lines) {
        const out = withholdPrivateContentFromLogLine(line, state);
        expect(out).toBe(line);
        expect(() => JSON.parse(out)).not.toThrow();
      }
      // Its memory calls are still withheld by shape.
      expect(withholdPrivateContentFromLogLine(claudeGetCall, state)).toContain(AGENT_MEMORY_WITHHELD_TEXT);
    }
  });
});
