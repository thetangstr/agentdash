import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInboxMcpHandler } from "./inbox-mcp.mjs";
import { DENIED_FOLDERS, UploadRefusal, inspectLocalFile, nextOffset, streamFragments } from "./upload.mjs";

/**
 * The person's own file, read on their own machine: only the file they named,
 * only after checks, and only metadata until they say yes.
 */

const SERVER = "https://agentdash.example.test";
const SENTINEL = "SENTINEL-FILE-CONTENT-7f3a";

let home;
let work;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "connect-upload-home-"));
  work = path.join(home, "Documents");
  fs.mkdirSync(work, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A small file that looks like real OOXML: zip magic, then content. */
function writeDeck(name = "deck.pptx", size = 2000) {
  const file = path.join(work, name);
  const body = Buffer.alloc(size, 0x41);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(body, 0);
  Buffer.from(SENTINEL).copy(body, 10);
  fs.writeFileSync(file, body);
  return file;
}

function fakeServer(respond) {
  const calls = [];
  const impl = async (url, init) => {
    const route = new URL(url).pathname.replace(/^\/api\/bridge\//, "");
    const isFragment = route === "upload/fragment";
    const call = {
      route,
      headers: init.headers,
      json: isFragment ? undefined : JSON.parse(init.body),
      bytes: isFragment ? Buffer.from(init.body) : undefined,
      rawBody: isFragment ? undefined : init.body,
    };
    calls.push(call);
    const out = await respond(call, calls);
    if (out === "network") throw new TypeError("fetch failed");
    const { status = 200, json = {} } = out ?? {};
    return new Response(JSON.stringify(json), { status });
  };
  return { impl, calls };
}

function uploadHandler(respond) {
  const server = fakeServer(respond);
  const handle = createInboxMcpHandler(
    {},
    {
      fetchImpl: server.impl,
      readServer: () => SERVER,
      readToken: () => "bridge-token-xyz",
      owner: { name: "Person A" },
      version: "9.9.9",
      fileOptions: { home, cwd: work },
    },
  );
  const call = async (name, args) => {
    const res = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const text = res.result.content[0].text;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { text, parsed, isError: res.result.isError === true };
  };
  return { call, calls: server.calls };
}

describe("inspectLocalFile", () => {
  it("accepts one regular OOXML file and reports name, size and type", () => {
    const file = writeDeck();
    const info = inspectLocalFile(file, { home, cwd: work });
    expect(info).toMatchObject({
      path: file,
      name: "deck.pptx",
      byteSize: 2000,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    // Relative to where the person is, and ~ for home.
    expect(inspectLocalFile("deck.pptx", { home, cwd: work }).path).toBe(file);
    expect(inspectLocalFile("~/Documents/deck.pptx", { home, cwd: "/" }).path).toBe(file);
  });

  const refusalOf = (fn) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(UploadRefusal);
      return err.reason;
    }
    return null;
  };

  it("refuses symlinks, directories, globs, and missing paths", () => {
    const file = writeDeck();
    const link = path.join(work, "link.pptx");
    fs.symlinkSync(file, link);
    expect(refusalOf(() => inspectLocalFile(link, { home, cwd: work }))).toBe("symlink_not_allowed");
    expect(refusalOf(() => inspectLocalFile(work, { home, cwd: work }))).toBe("directory_not_allowed");
    expect(refusalOf(() => inspectLocalFile("*.pptx", { home, cwd: work }))).toBe("glob_not_allowed");
    expect(refusalOf(() => inspectLocalFile("nope.pptx", { home, cwd: work }))).toBe("not_found");
    expect(refusalOf(() => inspectLocalFile("", { home, cwd: work }))).toBe("path_required");
  });

  it("never reads under a credential folder, even through a symlinked parent", () => {
    expect(DENIED_FOLDERS).toEqual(expect.arrayContaining([".agentdash", ".ssh", ".claude", ".codex", ".gnupg"]));
    for (const folder of [".ssh", ".agentdash", ".claude", ".codex", ".gnupg"]) {
      const dir = path.join(home, folder);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "keys.pdf");
      fs.writeFileSync(file, Buffer.from("%PDF-1.7 secret"));
      expect(refusalOf(() => inspectLocalFile(file, { home, cwd: work })), folder).toBe("credential_folder");
    }
    // A harmless-looking folder that is really ~/.ssh.
    const disguised = path.join(work, "notes");
    fs.symlinkSync(path.join(home, ".ssh"), disguised);
    expect(refusalOf(() => inspectLocalFile(path.join(disguised, "keys.pdf"), { home, cwd: work }))).toBe(
      "credential_folder",
    );
  });

  it("refuses the wrong type, content that does not match the extension, empty and oversize files", () => {
    const zip = path.join(work, "a.zip");
    fs.writeFileSync(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]));
    expect(refusalOf(() => inspectLocalFile(zip, { home, cwd: work }))).toBe("type_not_allowed");
    const fakePdf = path.join(work, "fake.pdf");
    fs.writeFileSync(fakePdf, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]));
    expect(refusalOf(() => inspectLocalFile(fakePdf, { home, cwd: work }))).toBe("content_mismatch");
    const empty = path.join(work, "empty.docx");
    fs.writeFileSync(empty, "");
    expect(refusalOf(() => inspectLocalFile(empty, { home, cwd: work }))).toBe("empty_file");
    const file = writeDeck("big.pptx", 5000);
    expect(refusalOf(() => inspectLocalFile(file, { home, cwd: work, maxBytes: 4999 }))).toBe("too_large");
  });
});

describe("nextOffset", () => {
  it("reads the first expected byte from Microsoft's ranges", () => {
    expect(nextOffset(["327680-"])).toBe(327680);
    expect(nextOffset(["655360-983039", "327680-"])).toBe(327680);
    expect(nextOffset([])).toBeNull();
    expect(nextOffset(undefined)).toBeNull();
  });
});

describe("upload tools over the inbox MCP", () => {
  const HANDLE = "handle-abc";

  it("propose sends metadata only, never the path or the bytes, and passes the read-back through", async () => {
    const file = writeDeck();
    const { call, calls } = uploadHandler(({ route }) =>
      route === "upload/propose" ? { json: { ok: true, handle: HANDLE, readback: ["Upload deck.pptx (2.0 KB)"] } } : {},
    );
    const res = await call("upload_propose", {
      path: file,
      destination: { folderId: "folder-1" },
      recipients: [{ name: "Person B", role: "write" }],
    });
    expect(res.parsed).toMatchObject({ ok: true, handle: HANDLE, readback: ["Upload deck.pptx (2.0 KB)"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].route).toBe("upload/propose");
    expect(calls[0].headers.authorization).toBe("Bearer bridge-token-xyz");
    expect(calls[0].json).toEqual({
      file: {
        name: "deck.pptx",
        byteSize: 2000,
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      destination: { folderId: "folder-1" },
      recipients: [{ name: "Person B", role: "write" }],
    });
    expect(calls[0].rawBody).not.toContain(SENTINEL);
    expect(calls[0].rawBody).not.toContain(work);
  });

  it("refuses locally, with no HTTP call, for a symlink, a directory, a credential folder or a mismatched file", async () => {
    const file = writeDeck();
    fs.symlinkSync(file, path.join(work, "link.pptx"));
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id.pdf"), "%PDF-1.7");
    fs.writeFileSync(path.join(work, "fake.docx"), "%PDF-1.7 not a docx");
    const { call, calls } = uploadHandler(() => ({ json: { ok: true, handle: HANDLE } }));
    for (const [p, reason] of [
      [path.join(work, "link.pptx"), "symlink_not_allowed"],
      [work, "directory_not_allowed"],
      [path.join(home, ".ssh", "id.pdf"), "credential_folder"],
      [path.join(work, "fake.docx"), "content_mismatch"],
    ]) {
      const res = await call("upload_propose", { path: p, destination: { folderId: "f" } });
      expect(res.parsed, p).toMatchObject({ ok: false, reason });
    }
    expect(calls).toHaveLength(0);
  });

  it("confirm refuses a file that changed after the read-back, and never calls confirm", async () => {
    const file = writeDeck();
    const { call, calls } = uploadHandler(({ route }) =>
      route === "upload/propose" ? { json: { ok: true, handle: HANDLE, readback: [] } } : { json: { ok: true } },
    );
    await call("upload_propose", { path: file, destination: { folderId: "f" } });
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    const res = await call("upload_confirm", { handle: HANDLE });
    expect(res.parsed).toMatchObject({ ok: false, reason: "file_changed" });
    expect(calls.map((c) => c.route)).toEqual(["upload/propose"]);
    // The handle is gone from this process either way.
    const again = await call("upload_confirm", { handle: HANDLE });
    expect(again.parsed).toMatchObject({ ok: false, reason: "unknown_handle" });
  });

  it("confirm refuses a handle this process never proposed", async () => {
    const { call, calls } = uploadHandler(() => ({ json: { ok: true } }));
    const res = await call("upload_confirm", { handle: "someone-elses" });
    expect(res.parsed).toMatchObject({ ok: false, reason: "unknown_handle" });
    expect(calls).toHaveLength(0);
  });

  it("streams fragments in order and resumes from nextExpectedRanges after a failure", async () => {
    const UNIT = 320 * 1024;
    const file = writeDeck("deck.pptx", 2 * UNIT + 500);
    let failedOnce = false;
    const { call, calls } = uploadHandler(({ route, headers, bytes }) => {
      if (route === "upload/propose") return { json: { ok: true, handle: HANDLE, readback: [] } };
      if (route === "upload/confirm") {
        // Even if a server ever echoed a session URL, the tool must not pass it on.
        return { json: { ok: true, uploadId: "u-1", fragmentBytes: UNIT, byteSize: 2 * UNIT + 500, uploadUrl: "https://up.1drv.example/s" } };
      }
      if (route === "upload/status") return { json: { ok: true, status: "open", nextExpectedRanges: [`${UNIT}-`] } };
      if (route === "upload/fragment") {
        const [, start, end, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers["content-range"]).map(Number);
        expect(bytes.length).toBe(end - start + 1);
        if (start === UNIT && !failedOnce) {
          failedOnce = true;
          return "network";
        }
        if (end === total - 1) {
          return { json: { ok: true, completed: true, item: { itemId: "i-1", name: "deck.pptx", webUrl: "https://onedrive.example.test/x" }, sharing: [] } };
        }
        return { status: 200, json: { ok: true, nextExpectedRanges: [`${end + 1}-`] } };
      }
      return { status: 404 };
    });
    await call("upload_propose", { path: file, destination: { folderId: "f" } });
    const res = await call("upload_confirm", { handle: HANDLE });
    expect(res.parsed).toMatchObject({ ok: true, completed: true, uploadId: "u-1", item: { itemId: "i-1" } });
    const fragments = calls.filter((c) => c.route === "upload/fragment").map((c) => c.headers["content-range"]);
    const total = 2 * UNIT + 500;
    expect(fragments).toEqual([
      `bytes 0-${UNIT - 1}/${total}`,
      `bytes ${UNIT}-${2 * UNIT - 1}/${total}`,
      `bytes ${UNIT}-${2 * UNIT - 1}/${total}`,
      `bytes ${2 * UNIT}-${total - 1}/${total}`,
    ]);
    expect(calls.map((c) => c.route)).toContain("upload/status");
    expect(calls.filter((c) => c.route === "upload/fragment").every((c) => c.headers["x-agentdash-upload-id"] === "u-1")).toBe(true);
    expect(res.text).not.toMatch(/uploadUrl|up\.1drv/);
  });

  it("says the session expired when AgentDash answers 410 mid-upload", async () => {
    const file = writeDeck();
    const { call } = uploadHandler(({ route }) => {
      if (route === "upload/propose") return { json: { ok: true, handle: HANDLE, readback: [] } };
      if (route === "upload/confirm") return { json: { ok: true, uploadId: "u-2", fragmentBytes: 10 * 1024 * 1024 } };
      return { status: 410, json: { ok: false, reason: "session_expired" } };
    });
    await call("upload_propose", { path: file, destination: { folderId: "f" } });
    const res = await call("upload_confirm", { handle: HANDLE });
    expect(res.parsed).toMatchObject({ ok: false, reason: "session_expired" });
  });

  it("passes a server refusal through unchanged: no handle means ask the person", async () => {
    const file = writeDeck();
    const { call } = uploadHandler(() => ({
      json: { ok: false, reason: "destination_required", message: "Which folder?", candidates: [{ folderId: "f", name: "Kickoff" }] },
    }));
    const res = await call("upload_propose", { path: file });
    expect(res.parsed).toMatchObject({ ok: false, reason: "destination_required" });
    const confirm = await call("upload_confirm", { handle: "anything" });
    expect(confirm.parsed.reason).toBe("unknown_handle");
  });
});

describe("streamFragments", () => {
  it("gives up after repeated failures and says nothing was shared", async () => {
    const file = writeDeck();
    await expect(
      streamFragments({
        path: file,
        byteSize: 2000,
        fragmentBytes: 10 * 1024 * 1024,
        send: async () => ({ status: 502, body: { ok: false } }),
        status: async () => ({ status: 502, body: { ok: false } }),
        maxRetries: 2,
      }),
    ).rejects.toMatchObject({ reason: "upload_interrupted" });
  });
});
