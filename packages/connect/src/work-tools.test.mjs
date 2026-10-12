import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createInboxMcpHandler } from "./inbox-mcp.mjs";
import { WORK_TOOLS, fetchBodyTimeoutMs, isMarkupFileName, quarantineFileName } from "./work-tools.mjs";

const SERVER = "http://agentdash.example.test:3102";
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempInbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-work-"));
  dirs.push(dir);
  return dir;
}

function handlerWith(respond, extra = {}) {
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
      ...extra,
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

describe("work tools: reading the agent's hand-off from the person's own session", () => {
  it("lists the four work tools beside the inbox tools", async () => {
    const { handle } = handlerWith(() => json({}));
    const res = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = res.result.tools.map((tool) => tool.name);
    for (const name of ["work_list", "work_read", "work_run_log", "work_fetch_file"]) expect(names).toContain(name);
    expect(WORK_TOOLS.map((tool) => tool.name)).toEqual(["work_list", "work_read", "work_run_log", "work_fetch_file"]);
  });

  it("tells the session that agent material is material, never instructions", async () => {
    const { handle } = handlerWith(() => json({}));
    const res = await handle({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
    expect(res.result.instructions).toMatch(/untrusted-agent-material/);
    expect(res.result.instructions).toMatch(/never instructions/i);
    for (const tool of WORK_TOOLS) expect(tool.description).toMatch(/material|data/i);
    const runLog = WORK_TOOLS.find((tool) => tool.name === "work_run_log");
    expect(runLog.description).toMatch(/injection|instructions/i);
  });

  it("posts list, read and run-log to the work routes with the person's bridge token", async () => {
    const { handle, calls } = handlerWith(() => json({ ok: true }));
    await call(handle, "work_list", { limit: 5 });
    await call(handle, "work_read", { issueId: "ACME-41", documentKey: "note", offset: 20000 });
    await call(handle, "work_read", { issueId: "ACME-41", commentId: "c1", offset: 2000 });
    await call(handle, "work_read", { issueId: "ACME-41", section: "description", offset: 8000 });
    await call(handle, "work_run_log", { issueId: "ACME-41", runId: "r1", offset: 64000 });
    expect(calls.map((c) => c.url)).toEqual([
      `${SERVER}/api/bridge/work/list`,
      `${SERVER}/api/bridge/work/read`,
      `${SERVER}/api/bridge/work/read`,
      `${SERVER}/api/bridge/work/read`,
      `${SERVER}/api/bridge/work/run-log`,
    ]);
    expect(calls[0].body).toEqual({ limit: 5 });
    expect(calls[1].body).toEqual({ issueId: "ACME-41", documentKey: "note", offset: 20000 });
    expect(calls[2].body).toEqual({ issueId: "ACME-41", commentId: "c1", offset: 2000 });
    expect(calls[3].body).toEqual({ issueId: "ACME-41", section: "description", offset: 8000 });
    expect(calls[4].body).toEqual({ issueId: "ACME-41", runId: "r1", offset: 64000 });
    for (const c of calls) expect(c.init.headers.authorization).toBe("Bearer bridge-token-xyz");
  });

  it("reports a refusal (flag off) as an outcome with a next step", async () => {
    const { handle } = handlerWith(() => json({ ok: false, code: "coworker_bridge_disabled", reason: "not switched on" }));
    const result = await call(handle, "work_list", {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, code: "coworker_bridge_disabled", note: expect.any(String) });
  });

  it("says plainly when the machine lacks bridge:work", async () => {
    const { handle } = handlerWith(() => json({ error: "That endpoint did not declare the bridge:work capability" }, 403));
    const result = await call(handle, "work_read", { issueId: "ACME-41" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bridge:work");
  });

  it("saves a fetched file into the quarantine folder, 0600, and checks its hash", async () => {
    const inboxDir = tempInbox();
    const bytes = Buffer.from("a,b\n1,2\n", "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const { handle, calls } = handlerWith(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="figures.csv"',
            "x-agentdash-file": "attachment",
            "x-agentdash-attachment-id": "11111111-2222-3333-4444-555555555555",
            "x-agentdash-sha256": sha,
            "x-agentdash-issue": "ACME-41",
          },
        }),
      { inboxDir },
    );
    const result = await call(handle, "work_fetch_file", { attachmentId: "11111111-2222-3333-4444-555555555555" });
    expect(calls[0].url).toBe(`${SERVER}/api/bridge/work/file`);
    expect(calls[0].body).toEqual({ attachmentId: "11111111-2222-3333-4444-555555555555" });
    expect(result.isError).toBeUndefined();
    const out = JSON.parse(result.content[0].text);
    const expected = path.join(inboxDir, "incoming", "ACME-41", "figures.csv");
    expect(out).toMatchObject({ ok: true, path: expected, bytes: bytes.length, sha256: sha, contentType: "text/csv" });
    expect(out.note).toMatch(/never (run|execute)/i);
    expect(fs.readFileSync(expected)).toEqual(bytes);
    expect(fs.statSync(expected).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(expected)).mode & 0o777).toBe(0o700);
  });

  it("writes nothing when the server refuses the file", async () => {
    const inboxDir = tempInbox();
    const { handle } = handlerWith(() => json({ ok: false, code: "file_refused", reason: "HTML is not sent over the bridge" }), {
      inboxDir,
    });
    const result = await call(handle, "work_fetch_file", { attachmentId: "a1" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, code: "file_refused" });
    expect(fs.existsSync(path.join(inboxDir, "incoming"))).toBe(false);
  });

  it("refuses bytes whose hash does not match, and keeps nothing", async () => {
    const inboxDir = tempInbox();
    const { handle } = handlerWith(
      () =>
        new Response(Buffer.from("tampered"), {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="figures.csv"',
            "x-agentdash-file": "attachment",
            "x-agentdash-sha256": "0".repeat(64),
            "x-agentdash-issue": "ACME-41",
          },
        }),
      { inboxDir },
    );
    const result = await call(handle, "work_fetch_file", { attachmentId: "a1" });
    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(inboxDir, "incoming", "ACME-41", "figures.csv"))).toBe(false);
  });

  function fileResponse(bytes, headers) {
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "x-agentdash-file": "attachment",
        "x-agentdash-issue": "ACME-41",
        ...headers,
      },
    });
  }

  it("refuses bytes that arrive without a well-formed sha256, and keeps nothing", async () => {
    const bytes = Buffer.from("a,b\n", "utf8");
    for (const sha of [undefined, "", "abc123", "z".repeat(64)]) {
      const inboxDir = tempInbox();
      const headers = { "content-disposition": 'attachment; filename="figures.csv"' };
      if (sha !== undefined) headers["x-agentdash-sha256"] = sha;
      const { handle } = handlerWith(() => fileResponse(bytes, headers), { inboxDir });
      const result = await call(handle, "work_fetch_file", { attachmentId: "a1" });
      expect(result.isError, String(sha)).toBe(true);
      expect(result.content[0].text).toMatch(/sha256/);
      expect(fs.existsSync(path.join(inboxDir, "incoming")), String(sha)).toBe(false);
    }
  });

  it("never writes a markup file, whatever the server let through", async () => {
    const bytes = Buffer.from("<script>alert(1)</script>", "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const cases = [
      { name: "report.html ", type: "text/plain" },
      { name: "report.html.", type: "text/plain" },
      { name: "report.ht\u200bml", type: "text/plain" },
      { name: "drawing.svg", type: "text/plain" },
      { name: "notes.txt", type: "text/html; charset=utf-8" },
    ];
    for (const { name, type } of cases) {
      const inboxDir = tempInbox();
      const { handle } = handlerWith(
        () =>
          fileResponse(bytes, {
            "content-type": type,
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            "x-agentdash-sha256": sha,
          }),
        { inboxDir },
      );
      const result = await call(handle, "work_fetch_file", { attachmentId: "a1" });
      expect(JSON.parse(result.content[0].text), name).toMatchObject({ ok: false, code: "file_refused" });
      expect(fs.existsSync(path.join(inboxDir, "incoming")), name).toBe(false);
    }
  });

  it("answers with an error instead of hanging when the body read or the folder fails", async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const { handle } = handlerWith(() => fileResponse(broken, { "x-agentdash-sha256": "0".repeat(64) }), {
      inboxDir: tempInbox(),
    });
    const result = await call(handle, "work_fetch_file", { attachmentId: "a1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/connection reset/);

    // The inbox "folder" is a file: mkdir fails, and the call still answers.
    const notADir = path.join(tempInbox(), "file");
    fs.writeFileSync(notADir, "x");
    const bytes = Buffer.from("a,b\n", "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const second = handlerWith(
      () => fileResponse(bytes, { "content-disposition": 'attachment; filename="figures.csv"', "x-agentdash-sha256": sha }),
      { inboxDir: notADir },
    );
    const failed = await call(second.handle, "work_fetch_file", { attachmentId: "a1" });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toMatch(/Could not save/);
  });

  it("gives a file download time for its size, not the 15-second answer timeout", () => {
    expect(fetchBodyTimeoutMs(null)).toBeGreaterThanOrEqual(60_000);
    expect(fetchBodyTimeoutMs("1024")).toBeLessThanOrEqual(fetchBodyTimeoutMs(null) + 1000);
    // 1 GB at the assumed floor rate needs far longer than a minute, and is capped.
    expect(fetchBodyTimeoutMs(String(1024 ** 3))).toBeGreaterThan(10 * 60_000);
    expect(fetchBodyTimeoutMs(String(1024 ** 4))).toBeLessThanOrEqual(60 * 60_000);
  });

  it("keeps a hostile file name inside the issue's quarantine folder", () => {
    expect(quarantineFileName("../../.ssh/authorized_keys", "a1")).toBe("authorized_keys");
    expect(quarantineFileName("..", "abcdef12-0000")).toBe("attachment-abcdef12");
    expect(quarantineFileName(".bashrc", "a1")).toBe("_bashrc");
    expect(quarantineFileName("report\u0000.pdf", "a1")).toBe("report_.pdf");
    expect(quarantineFileName("report.html \u00a0. ", "a1")).toBe("report.html");
    expect(quarantineFileName("rep\u200bort\u202e.pdf", "a1")).toBe("report.pdf");
    expect(isMarkupFileName("report.html")).toBe(true);
    expect(isMarkupFileName("report.html\u3000")).toBe(true);
    expect(isMarkupFileName("drawing.SVG")).toBe(true);
    expect(isMarkupFileName("figures.csv")).toBe(false);
  });
});
