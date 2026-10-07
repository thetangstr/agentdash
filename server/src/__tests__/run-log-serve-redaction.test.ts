// AgentDash (2026-10-07 HQ stall): the serve-time run-log redaction pass must
// never block the event loop for long. It runs in yielding slices, is capped
// per request for bytes the store does not vouch for (the client pages with
// nextOffset), and produces exactly the output of the synchronous pass.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REDACTED } from "@paperclipai/shared";
import {
  RUN_LOG_SERVE_MAX_UNVERIFIED_BYTES,
  redactRunLogNdjson,
  redactRunLogNdjsonAsync,
  redactRunLogReadForServe,
} from "../services/run-log-redaction.ts";
import { getRunLogStore, resetRunLogStoreForTests } from "../services/run-log-store.ts";

const SECRET_VALUE = "Zq8Rk2Vm7Tn4Wb9Xc3Ls";

function buildLog(targetBytes: number): string {
  const lines: string[] = [];
  let bytes = 0;
  for (let i = 0; bytes < targetBytes; i++) {
    const chunk =
      i % 50 === 0
        ? `export API_KEY=${SECRET_VALUE}\n`
        : i % 333 === 0
          ? `${"the agent ran a shell command ".repeat(400)}\n`
          : `step ${i}: read files from the workspace then wrote output\n`;
    const line = JSON.stringify({ ts: "2026-10-07T00:00:00.000Z", stream: "stdout", chunk, seq: i });
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  return `${lines.join("\n")}\n`;
}

describe("run-log serve-time redaction", () => {
  it("async pass is byte-for-byte the sync pass (whole lines, truncated head/tail, plain text)", async () => {
    const log = buildLog(120_000);
    const samples = [
      log,
      log.slice(37, 50_000), // byte-range read: truncated first and last lines
      `not json ${SECRET_VALUE} password: hunter2pass99\n{"broken":`,
      "",
      "\n\n",
    ];
    for (const sample of samples) {
      expect(await redactRunLogNdjsonAsync(sample, [], { sliceMs: 0 })).toBe(redactRunLogNdjson(sample));
    }
  });

  it("yields to the event loop during a large read", async () => {
    const log = buildLog(1_500_000);
    let timerFired = false;
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
    }, 1);
    setTimeout(() => {
      timerFired = true;
    }, 0);
    const out = await redactRunLogNdjsonAsync(log, [], { sliceMs: 2 });
    const firedBeforeDone = timerFired;
    clearInterval(interval);
    expect(firedBeforeDone).toBe(true);
    expect(ticks).toBeGreaterThan(0);
    expect(out).not.toContain(SECRET_VALUE);
  });

  it("caps unverified bytes per request at a line boundary and pages to the same output", async () => {
    const log = buildLog(700_000);
    const total = Buffer.byteLength(log);
    let offset = 0;
    let assembled = "";
    let pages = 0;
    while (offset < total) {
      // Same shape the store returns for an unmarked (legacy) file read with
      // the API's 1 MB max limitBytes.
      const slice = Buffer.from(log).subarray(offset, offset + 1024 * 1024);
      const served = await redactRunLogReadForServe({
        content: slice.toString("utf8"),
        nextOffset: offset + slice.length < total ? offset + slice.length : undefined,
        redactedAtPersist: false,
        buffer: slice,
        verifiedBytes: 0,
        startOffset: offset,
      });
      pages++;
      expect(served.redactedAtPersist).toBe(false);
      expect(served.content).not.toContain(SECRET_VALUE);
      if (served.nextOffset !== undefined) {
        // Trimmed pages end on a whole line and never exceed the cap by more
        // than that line.
        expect(served.content.endsWith("\n")).toBe(true);
        expect(served.nextOffset - offset).toBeLessThanOrEqual(RUN_LOG_SERVE_MAX_UNVERIFIED_BYTES);
        expect(served.nextOffset).toBeGreaterThan(offset);
      }
      assembled += served.content;
      if (served.nextOffset === undefined) break;
      offset = served.nextOffset;
    }
    expect(pages).toBeGreaterThan(2);
    expect(assembled).toBe(redactRunLogNdjson(log));
    expect(assembled).toContain(REDACTED);
  });

  it("keeps a single line longer than the cap whole instead of splitting it", async () => {
    const longLine = JSON.stringify({ ts: "t", stream: "stdout", chunk: `${"x".repeat(5000)} API_KEY=${SECRET_VALUE}` });
    const content = `${longLine}\n${longLine}\n`;
    const served = await redactRunLogReadForServe(
      { content, redactedAtPersist: false, buffer: Buffer.from(content), verifiedBytes: 0, startOffset: 0 },
      { maxUnverifiedBytes: 100 },
    );
    expect(served.content).toBe(redactRunLogNdjson(`${longLine}\n`));
    expect(served.nextOffset).toBe(Buffer.byteLength(`${longLine}\n`));
  });

  it("passes the store-verified prefix through and redacts only the tail", async () => {
    const head = `${JSON.stringify({ ts: "t", stream: "stdout", chunk: "already redacted at write time\n" })}\n`;
    const tail = `${JSON.stringify({ ts: "t", stream: "stdout", chunk: `export API_KEY=${SECRET_VALUE}\n` })}\n`;
    const served = await redactRunLogReadForServe({
      content: head + tail,
      redactedAtPersist: false,
      buffer: Buffer.from(head + tail),
      verifiedBytes: Buffer.byteLength(head),
      startOffset: 0,
    });
    expect(served.content).toBe(head + redactRunLogNdjson(tail));
    expect(served.content).not.toContain(SECRET_VALUE);
    expect(served.nextOffset).toBeUndefined();
  });

  it("serves a fully marked range untouched", async () => {
    const content = `${JSON.stringify({ ts: "t", stream: "stdout", chunk: "ok\n" })}\n`;
    const served = await redactRunLogReadForServe({
      content,
      nextOffset: 99,
      redactedAtPersist: true,
      buffer: Buffer.from(content),
      verifiedBytes: Buffer.byteLength(content),
      startOffset: 0,
    });
    expect(served).toEqual({ content, nextOffset: 99, redactedAtPersist: true });
  });

  it("pages on raw file bytes when a page starts inside a multi-byte UTF-8 character", async () => {
    const base = await mkdtemp(join(tmpdir(), "run-log-utf8-"));
    const prevBase = process.env.RUN_LOG_BASE_PATH;
    process.env.RUN_LOG_BASE_PATH = base;
    resetRunLogStoreForTests();
    try {
      const logRef = join("c1", "a1", "utf8.ndjson");
      await mkdir(join(base, "c1", "a1"), { recursive: true });
      let log = "";
      for (let i = 0; i < 400; i++) {
        log += `${JSON.stringify({ ts: "t", stream: "stdout", chunk: `€€€ price ${i} ✓ 日本語 ${i % 25 === 0 ? `API_KEY=${SECRET_VALUE}` : ""}\n` })}\n`;
      }
      // JSON.stringify keeps non-ASCII raw, so the file holds multi-byte runs.
      const fileBytes = Buffer.from(log, "utf8");
      await writeFile(join(base, logRef), fileBytes);
      const euro = fileBytes.indexOf(Buffer.from("€"));
      const start = euro + 1; // inside the 3-byte "€"
      const store = getRunLogStore();
      let offset = start;
      let pages = 0;
      while (offset < fileBytes.length && pages < 1000) {
        const read = await store.read({ store: "local_file", logRef }, { offset, limitBytes: 64 * 1024 });
        const served = await redactRunLogReadForServe(read, { maxUnverifiedBytes: 500 });
        pages++;
        expect(served.content).not.toContain(SECRET_VALUE);
        if (served.nextOffset === undefined) break;
        expect(served.nextOffset).toBeGreaterThan(offset);
        // The cut lands right after a newline in the FILE, so no byte is
        // skipped or repeated between pages.
        expect(fileBytes[served.nextOffset - 1]).toBe(0x0a);
        offset = served.nextOffset;
      }
      expect(pages).toBeGreaterThan(10);
    } finally {
      if (prevBase === undefined) delete process.env.RUN_LOG_BASE_PATH;
      else process.env.RUN_LOG_BASE_PATH = prevBase;
      resetRunLogStoreForTests();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("stops redacting when the request is aborted", async () => {
    const log = buildLog(1_500_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    await expect(redactRunLogNdjsonAsync(log, [], { sliceMs: 1, signal: controller.signal })).rejects.toThrow();
  });
});

