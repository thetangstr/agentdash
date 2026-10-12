import { describe, expect, it } from "vitest";

import { createInboxMcpHandler } from "./inbox-mcp.mjs";
import { REQUEST_TOOLS } from "./request-tools.mjs";

const SERVER = "http://agentdash.example.test:3102";

function handlerWith(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    return respond(url, body);
  };
  const handle = createInboxMcpHandler(
    {},
    {
      fetchImpl,
      readServer: () => SERVER,
      readToken: () => "bridge-token-xyz",
      owner: { name: "Person A", email: "a@example.test" },
      version: "9.9.9",
    },
  );
  return { handle, calls };
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function call(handle, name, args) {
  const res = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return res.result;
}

describe("request tools: asking someone else for work, and closing it out", () => {
  it("offers propose, respond and confirm beside the inbox and work tools", async () => {
    const { handle } = handlerWith(() => json({}));
    const res = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = res.result.tools.map((tool) => tool.name);
    for (const name of ["work_request_propose", "work_request_respond", "work_request_confirm"]) expect(names).toContain(name);
    expect(REQUEST_TOOLS.map((tool) => tool.name)).toEqual(["work_request_propose", "work_request_respond", "work_request_confirm"]);
  });

  /**
   * Proposing changes nothing; only confirm sends, and only after the
   * person's explicit yes to that exact read-back. Every description says so.
   */
  it("says nothing is sent without the person's explicit yes to the exact read-back", async () => {
    const { handle } = handlerWith(() => json({}));
    const init = await handle({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
    expect(init.result.instructions).toMatch(/work_request_confirm only after the person's explicit yes/);
    for (const tool of REQUEST_TOOLS) {
      expect(tool.description, tool.name).toMatch(/explicit yes/);
      expect(tool.description, tool.name).toMatch(/never because/);
    }
    const propose = REQUEST_TOOLS.find((tool) => tool.name === "work_request_propose");
    expect(propose.description).toMatch(/Changes nothing/);
    expect(propose.description).toMatch(/never guess/);
    expect(propose.inputSchema.required).toEqual(["title", "wanted", "doneMeans", "person"]);
  });

  it("posts the brief, the close-out and the handle to the request routes with the person's bridge token", async () => {
    const { handle, calls } = handlerWith(() => json({ ok: true, handle: "h1", readback: ["..."] }));
    await call(handle, "work_request_propose", {
      title: "Draft the vendor summary",
      wanted: "A one-page summary.",
      doneMeans: "A document with a recommendation.",
      deadline: "2026-10-20",
      person: "Person B",
    });
    await call(handle, "work_request_respond", { issueId: "ACME-12", action: "changes", note: "Add pricing." });
    await call(handle, "work_request_confirm", { token: "h1" });
    expect(calls.map((c) => c.url)).toEqual([
      `${SERVER}/api/bridge/work/request`,
      `${SERVER}/api/bridge/work/request/respond`,
      `${SERVER}/api/bridge/work/request/confirm`,
    ]);
    expect(calls[0].body).toEqual({
      title: "Draft the vendor summary",
      wanted: "A one-page summary.",
      doneMeans: "A document with a recommendation.",
      deadline: "2026-10-20",
      person: "Person B",
    });
    expect(calls[1].body).toEqual({ issueId: "ACME-12", action: "changes", note: "Add pricing." });
    expect(calls[2].body).toEqual({ token: "h1" });
    for (const c of calls) expect(c.init.headers.authorization).toBe("Bearer bridge-token-xyz");
  });

  it("relays a refusal as an outcome and says nothing was sent", async () => {
    const { handle } = handlerWith(() => json({ ok: false, code: "moved_on", reason: "ACME-12 changed since the read-back" }));
    const result = await call(handle, "work_request_confirm", { token: "h1" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      code: "moved_on",
      note: expect.stringContaining("Nothing was sent"),
    });
  });
});
