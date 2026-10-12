import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readLocalFiles, resolveLocalPath } from "./file-send.mjs";
import { createInboxMcpHandler } from "./inbox-mcp.mjs";

const SERVER = "http://agentdash.example.test:3102";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const dirs = [];
function tempDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "connect-files-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function handlerWith(respond, deps = {}) {
  const calls = [];
  const handle = createInboxMcpHandler(
    {},
    {
      fetchImpl: async (url, init) => {
        let body;
        if (init?.body instanceof FormData) {
          const file = init.body.get("file");
          body = {
            form: true,
            token: init.body.get("token"),
            filename: file?.name,
            bytes: file ? Buffer.from(await file.arrayBuffer()) : null,
          };
        } else if (typeof init?.body === "string") {
          body = JSON.parse(init.body);
        }
        calls.push({ url, init, body });
        return respond(url, body);
      },
      readServer: () => SERVER,
      readToken: () => "bridge-token-xyz",
      owner: { name: "Person A", email: "a@example.test" },
      version: "9.9.9",
      inboxDir: "/nonexistent",
      ...deps,
    },
  );
  return { handle, calls };
}

async function call(handle, name, args) {
  const res = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return res.result;
}
const parsed = (result) => JSON.parse(result.content[0].text);

describe("local files for a send-back or a request", () => {
  it("takes only absolute or ~/ paths", () => {
    expect(resolveLocalPath("~/work/plan.md", "/home/person-a")).toBe("/home/person-a/work/plan.md");
    expect(resolveLocalPath("/tmp/x.csv")).toBe("/tmp/x.csv");
    expect(resolveLocalPath("plan.md")).toBeNull();
    expect(resolveLocalPath("./plan.md")).toBeNull();
  });

  it("hashes plain files and refuses hidden places, links into them, folders, empty files and markup", () => {
    const dir = tempDir();
    const plan = path.join(dir, "plan.md");
    fs.writeFileSync(plan, "# Plan\n");
    const read = readLocalFiles([{ path: plan }]);
    expect(read).toEqual({ ok: true, files: [{ path: plan, name: "plan.md", size: 7, sha256: sha(Buffer.from("# Plan\n")) }] });

    fs.mkdirSync(path.join(dir, ".ssh"));
    fs.writeFileSync(path.join(dir, ".ssh", "id_key"), "secret");
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=1");
    expect(readLocalFiles([{ path: path.join(dir, ".ssh", "id_key") }])).toMatchObject({ ok: false, code: "hidden_path" });
    expect(readLocalFiles([{ path: path.join(dir, ".env") }])).toMatchObject({ ok: false, code: "hidden_path" });
    fs.symlinkSync(path.join(dir, ".ssh"), path.join(dir, "keys"));
    expect(readLocalFiles([{ path: path.join(dir, "keys", "id_key") }])).toMatchObject({ ok: false, code: "hidden_path" });
    fs.symlinkSync(plan, path.join(dir, "plan-link.md"));
    expect(readLocalFiles([{ path: path.join(dir, "plan-link.md") }])).toMatchObject({ ok: false, code: "not_a_file" });
    expect(readLocalFiles([{ path: dir }])).toMatchObject({ ok: false, code: "not_a_file" });
    fs.writeFileSync(path.join(dir, "empty.csv"), "");
    expect(readLocalFiles([{ path: path.join(dir, "empty.csv") }])).toMatchObject({ ok: false, code: "empty_file" });
    fs.writeFileSync(path.join(dir, "page.html"), "<p>hi</p>");
    expect(readLocalFiles([{ path: path.join(dir, "page.html") }])).toMatchObject({ ok: false, code: "file_refused" });
    expect(readLocalFiles([{ path: "relative.md" }])).toMatchObject({ ok: false, code: "invalid_path" });
    expect(readLocalFiles([{ path: path.join(dir, "missing.md") }])).toMatchObject({ ok: false, code: "not_found" });
  });

  it("proposes with names and hashes only, uploads after the yes, then confirms", async () => {
    const dir = tempDir();
    const figures = path.join(dir, "q3 figures.csv");
    const bytes = Buffer.from("site,share\nnorth,0.42\n");
    fs.writeFileSync(figures, bytes);
    const file = { name: "q3 figures.csv", sha256: sha(bytes), size: bytes.length };
    const { handle, calls } = handlerWith((url) => {
      if (url.endsWith("/work/propose")) {
        return json({ ok: true, handle: "h-1", readback: ["..."], upload: { files: [file] } });
      }
      if (url.endsWith("/work/upload")) return json({ ok: true, name: file.name, sha256: file.sha256, bytes: file.size });
      return json({ ok: true, sent: { files: [{ name: "q3 figures v2 (Person A).csv", version: 2 }] } });
    });

    const proposed = parsed(await call(handle, "work_propose_reply", { issueId: "ACME-41", comment: "Corrected.", files: [{ path: figures }] }));
    expect(calls[0].body).toEqual({ issueId: "ACME-41", comment: "Corrected.", files: [file] });
    expect(JSON.stringify(calls[0].body)).not.toContain(dir);
    expect(proposed.localFiles).toEqual([{ path: figures, bytes: bytes.length, sha256: file.sha256, sent: true }]);

    const confirmed = parsed(await call(handle, "work_confirm_reply", { token: "h-1" }));
    expect(confirmed.ok).toBe(true);
    expect(calls.map((c) => c.url.replace(SERVER, ""))).toEqual([
      "/api/bridge/work/propose",
      "/api/bridge/work/upload",
      "/api/bridge/work/confirm",
    ]);
    expect(calls[1].body).toMatchObject({ form: true, token: "h-1", filename: "q3 figures.csv" });
    expect(calls[1].body.bytes.equals(bytes)).toBe(true);
    expect(calls[1].init.headers.authorization).toBe("Bearer bridge-token-xyz");
    expect(calls[2].body).toEqual({ token: "h-1" });
  });

  it("sends nothing when a file changed since the read-back, or the upload is refused", async () => {
    const dir = tempDir();
    const figures = path.join(dir, "q3.csv");
    fs.writeFileSync(figures, "a,b\n1,2\n");
    const file = { name: "q3.csv", sha256: sha(Buffer.from("a,b\n1,2\n")), size: 8 };
    let uploadAnswer = json({ ok: true });
    let proposals = 0;
    const { handle, calls } = handlerWith((url) => {
      if (url.endsWith("/work/propose")) return json({ ok: true, handle: `h-${proposals++}`, upload: { files: [file] } });
      if (url.endsWith("/work/upload")) return uploadAnswer;
      return json({ ok: true });
    });

    await call(handle, "work_propose_reply", { issueId: "ACME-41", files: [{ path: figures }] });
    fs.writeFileSync(figures, "a,b\n9,9\n");
    const changed = parsed(await call(handle, "work_confirm_reply", { token: "h-0" }));
    expect(changed).toMatchObject({ ok: false, code: "file_changed" });
    expect(calls.some((c) => c.url.endsWith("/work/confirm") || c.url.endsWith("/work/upload"))).toBe(false);

    fs.writeFileSync(figures, "a,b\n1,2\n");
    await call(handle, "work_propose_reply", { issueId: "ACME-41", files: [{ path: figures }] });
    uploadAnswer = json({ ok: false, code: "file_too_large", reason: "The file is over this company's attachment cap of 8 bytes." });
    const refused = parsed(await call(handle, "work_confirm_reply", { token: "h-1" }));
    expect(refused).toMatchObject({ ok: false, code: "file_too_large" });
    expect(refused.note).toContain("nothing was sent");
    expect(calls.some((c) => c.url.endsWith("/work/confirm"))).toBe(false);
  });

  it("keeps nothing to upload when the server left the files out (not a restricted project)", async () => {
    const dir = tempDir();
    const figures = path.join(dir, "q3.csv");
    fs.writeFileSync(figures, "a,b\n");
    const { handle, calls } = handlerWith((url) =>
      url.endsWith("/work/propose")
        ? json({ ok: true, handle: "h-1", filesLeftOut: "Files travel over the bridge only on issues in projects with restricted access..." })
        : json({ ok: true }),
    );
    const proposed = parsed(await call(handle, "work_propose_reply", { issueId: "ACME-41", comment: "x", files: [{ path: figures }] }));
    expect(proposed.filesLeftOut).toContain("restricted access");
    expect(proposed.localFiles[0].sent).toBe(false);
    await call(handle, "work_confirm_reply", { token: "h-1" });
    expect(calls.map((c) => c.url.replace(SERVER, ""))).toEqual(["/api/bridge/work/propose", "/api/bridge/work/confirm"]);
  });

  it("refuses a hidden file before proposing anything", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=1");
    const { handle, calls } = handlerWith(() => json({ ok: true }));
    const refused = parsed(await call(handle, "work_propose_reply", { issueId: "ACME-41", comment: "x", files: [{ path: path.join(dir, ".env") }] }));
    expect(refused).toMatchObject({ ok: false, code: "hidden_path" });
    expect(calls).toHaveLength(0);
  });

  it("sends files with a request the same way: names at propose, bytes after the yes", async () => {
    const dir = tempDir();
    const brief = path.join(dir, "vendor figures.csv");
    const bytes = Buffer.from("vendor,price\n");
    fs.writeFileSync(brief, bytes);
    const file = { name: "vendor figures.csv", sha256: sha(bytes), size: bytes.length };
    const { handle, calls } = handlerWith((url) => {
      if (url.endsWith("/work/request")) return json({ ok: true, handle: "r-1", upload: { files: [file] } });
      if (url.endsWith("/work/upload")) return json({ ok: true });
      return json({ ok: true, files: [{ name: "vendor figures v1 (Person A).csv" }] });
    });
    await call(handle, "work_request_propose", {
      title: "Check the figures",
      wanted: "Check them.",
      doneMeans: "A note.",
      person: "Person B",
      project: "Restricted work",
      files: [{ path: brief }],
    });
    expect(calls[0].body.files).toEqual([file]);
    await call(handle, "work_request_confirm", { token: "r-1" });
    expect(calls.map((c) => c.url.replace(SERVER, ""))).toEqual([
      "/api/bridge/work/request",
      "/api/bridge/work/upload",
      "/api/bridge/work/request/confirm",
    ]);
  });
});

describe("work_fetch_file and versions", () => {
  it("keeps the versioned name and says when the file is not the current version", async () => {
    const inboxDir = tempDir();
    const bytes = Buffer.from("site,share\n");
    const headers = {
      "content-type": "text/csv",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("q3 figures v1 (Agent A).csv")}`,
      "x-agentdash-file": "attachment",
      "x-agentdash-attachment-id": "a1",
      "x-agentdash-sha256": sha(bytes),
      "x-agentdash-issue": "ACME-41",
      "x-agentdash-version": "1",
      "x-agentdash-current": "false",
      "x-agentdash-current-attachment-id": "a2",
    };
    const { handle } = handlerWith(() => new Response(bytes, { status: 200, headers }), { inboxDir });
    const result = parsed(await call(handle, "work_fetch_file", { attachmentId: "a1" }));
    expect(result.path).toBe(path.join(inboxDir, "incoming", "ACME-41", "q3 figures v1 (Agent A).csv"));
    expect(result).toMatchObject({ version: 1, isCurrent: false, currentAttachmentId: "a2" });
    expect(result.versionNote).toContain("not the current version");
  });
});
