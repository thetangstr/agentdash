import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createInboxMcpHandler, runInboxMcp } from "./inbox-mcp.mjs";
import { inboxMcpLaunch, upsertClaudeStdioServer } from "./harnesses.mjs";

const SERVER = "http://10.0.0.5:3102";

function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const { status = 200, json } = respond(url, calls.at(-1).body) ?? {};
    return new Response(JSON.stringify(json ?? {}), { status });
  };
  return { impl, calls };
}

function handler(respond, extra = {}) {
  const fetch = fakeFetch(respond);
  const handle = createInboxMcpHandler(
    {},
    {
      fetchImpl: fetch.impl,
      readServer: () => SERVER,
      readToken: () => "bridge-token-xyz",
      owner: { name: "Titus", email: "t@example.test" },
      version: "9.9.9",
      ...extra,
    },
  );
  return { handle, calls: fetch.calls };
}

describe("agentdash-connect mcp", () => {
  it("introduces itself as the person's own inbox, not an agent", async () => {
    const { handle } = handler(() => ({}));
    const res = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(res.result.serverInfo).toEqual({ name: "agentdash-inbox", version: "9.9.9" });
    expect(res.result.protocolVersion).toBe("2025-03-26");
    expect(res.result.instructions).toContain("Titus's own AgentDash inbox");
    expect(res.result.instructions).toMatch(/never decide on your own initiative/);
  });

  it("offers exactly the inbox surface — no bridge task tools, nothing from the control plane", async () => {
    const { handle } = handler(() => ({}));
    const res = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.result.tools.map((t) => t.name).sort()).toEqual(
      ["inbox_ack", "inbox_agents", "inbox_confirm", "inbox_decide", "inbox_propose", "inbox_sync"],
    );
    const decide = res.result.tools.find((t) => t.name === "inbox_decide");
    expect(decide.description).toMatch(/AS THE PERSON AT THIS TERMINAL/);
    expect(decide.inputSchema.required).toEqual(["token"]);
  });

  it("decides with the person's bridge token, carrying only the handle", async () => {
    const { handle, calls } = handler(() => ({ json: { ok: true, decision: "approved", approvalId: "a1" } }));
    const res = await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "inbox_decide", arguments: { token: "handle-approve-1" } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SERVER}/api/bridge/inbox/decide`);
    expect(calls[0].init.headers.authorization).toBe("Bearer bridge-token-xyz");
    expect(calls[0].body).toEqual({ token: "handle-approve-1" });
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0].text)).toMatchObject({ ok: true, decision: "approved" });
  });

  it("reports a refused decision as an outcome with a next step, not a failure", async () => {
    const { handle } = handler(() => ({ json: { ok: false, reason: "already_decided" } }));
    const res = await handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "inbox_decide", arguments: { token: "spent" } },
    });
    const body = JSON.parse(res.result.content[0].text);
    expect(body).toMatchObject({ ok: false, reason: "already_decided" });
    expect(body.note).toMatch(/inbox_sync again/);
  });

  it("surfaces an HTTP refusal as a tool error with the server's words", async () => {
    const { handle } = handler(() => ({ status: 403, json: { error: "Bridge endpoint lacks bridge:inbox" } }));
    const res = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "inbox_sync", arguments: {} } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("403");
    expect(res.result.content[0].text).toContain("bridge:inbox");
  });

  it("asks for the digest by default on sync", async () => {
    const { handle, calls } = handler(() => ({ json: { events: [] } }));
    await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "inbox_sync", arguments: { limit: 5 } } });
    expect(calls[0].body).toEqual({ includeDigest: true, limit: 5 });
  });

  it("explains a missing credential instead of calling out", async () => {
    const { handle, calls } = handler(() => ({}), {
      readToken: () => {
        throw new Error("No bridge token at ~/.agentdash/bridge-token");
      },
    });
    const res = await handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "inbox_sync", arguments: {} } });
    expect(calls).toHaveLength(0);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("No bridge token");
  });

  it("refuses unknown tools and methods, and stays silent on notifications", async () => {
    const { handle } = handler(() => ({}));
    const tool = await handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "approval_decision", arguments: {} } });
    expect(tool.result.isError).toBe(true);
    const method = await handle({ jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect(method.error.code).toBe(-32601);
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("answers every request piped in before stdin closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];
    output.on("data", (chunk) => chunks.push(chunk.toString()));
    const done = runInboxMcp(
      {},
      {
        input,
        output,
        fetchImpl: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new Response(JSON.stringify({ events: [] }), { status: 200 });
        },
        readServer: () => SERVER,
        readToken: () => "t",
        owner: null,
      },
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox_sync", arguments: {} } })}\n`);
    input.end();
    await done;
    const lines = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(1);
  });
});

describe("registering the inbox tools with Claude Code", () => {
  it("launches through npx, pinned @latest, with the instance address", () => {
    expect(inboxMcpLaunch({ server: SERVER, platform: "darwin" })).toEqual({
      command: "npx",
      args: ["-y", "agentdash-connect@latest", "mcp", "--server", SERVER],
    });
  });

  it("goes through cmd on Windows, where npx is a shim Claude Code cannot spawn", () => {
    expect(inboxMcpLaunch({ server: SERVER, platform: "win32" }).command).toBe("cmd");
    expect(inboxMcpLaunch({ server: SERVER, platform: "win32" }).args.slice(0, 2)).toEqual(["/c", "npx"]);
  });

  it("writes a stdio entry beside the agent's, carrying no secret", () => {
    const before = { mcpServers: { agentdash: { type: "http", url: `${SERVER}/api/mcp`, headers: { Authorization: "Bearer pcp_x" } } } };
    const after = upsertClaudeStdioServer(before, "agentdash-inbox", inboxMcpLaunch({ server: SERVER, platform: "darwin" }));
    expect(after.mcpServers.agentdash).toEqual(before.mcpServers.agentdash);
    expect(after.mcpServers["agentdash-inbox"].type).toBe("stdio");
    expect(JSON.stringify(after.mcpServers["agentdash-inbox"])).not.toMatch(/pcp_|Bearer|token/i);
  });
});
