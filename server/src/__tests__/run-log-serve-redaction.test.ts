// AgentDash (2026-10-07 HQ stall): the serve-time run-log redaction pass must
// never block the event loop for long. It runs in yielding slices, is capped
// per request for bytes the store does not vouch for (the client pages with
// nextOffset), and produces exactly the output of the synchronous pass.
import { describe, expect, it } from "vitest";
import { REDACTED } from "@paperclipai/shared";
import {
  RUN_LOG_SERVE_MAX_UNVERIFIED_BYTES,
  redactRunLogNdjson,
  redactRunLogNdjsonAsync,
  redactRunLogReadForServe,
} from "../services/run-log-redaction.ts";

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
      const raw = slice.toString("utf8");
      const served = await redactRunLogReadForServe({
        content: raw,
        nextOffset: offset + slice.length < total ? offset + slice.length : undefined,
        redactedAtPersist: false,
        verifiedChars: 0,
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
      { content, redactedAtPersist: false, verifiedChars: 0, startOffset: 0 },
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
      verifiedChars: head.length,
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
      verifiedChars: content.length,
      startOffset: 0,
    });
    expect(served).toEqual({ content, nextOffset: 99, redactedAtPersist: true });
  });
});
