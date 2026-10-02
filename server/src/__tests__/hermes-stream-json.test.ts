import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  applyHermesStreamUsageFallback,
  createHermesStreamJsonCapture,
  HERMES_STREAM_JSON_PROBE_TTL_MS,
  hermesConfigPinsOutputFormat,
  hermesHelpAdvertisesStreamJson,
  hermesRejectedStreamJsonFlag,
  invalidateHermesStreamJsonProbe,
  hermesStreamJsonDisabledByEnv,
  hermesSupportsStreamJson,
  isHermesBookkeepingStderr,
  resetHermesStreamJsonProbeCache,
  withHermesStreamJsonArgs,
} from "../adapters/hermes-stream-json.js";

// Sanitised from a real `hermes chat -q … -Q --format stream-json` run
// (Hermes v2026.9.24).
const STREAM_JSON_STDOUT = [
  '{"type": "system", "subtype": "init", "model": "glm-5.3-flash", "session_id": "20261001_231546_52cd79", "timestamp": 1790921746825}',
  '{"type": "tool_use", "name": "terminal", "input": {"command": "echo hermes-smoke-ok"}, "timestamp": 1790921757363}',
  '{"type": "tool_result", "name": "terminal", "output": "{\\"output\\": \\"hermes-smoke-ok\\", \\"exit_code\\": 0, \\"error\\": null}", "duration_ms": 83, "is_error": false, "timestamp": 1790921757447}',
  '{"type": "text", "text": "\\n\\nSmoke test", "timestamp": 1790921761223}',
  '{"type": "text", "text": " passed: hermes-smoke-ok.", "timestamp": 1790921761285}',
  '{"type": "result", "session_id": "20261001_231546_52cd79", "exit_code": 0, "text": "Smoke test passed: hermes-smoke-ok.", "tokens": {"input": 484, "output": 196, "total": 38056, "cache_read": 37376, "cache_write": 0}, "duration_ms": 14620, "timestamp": 1790921761445}',
  "",
].join("\n");

const HELP_WITH_STREAM_JSON = [
  "usage: hermes chat [-h] [-q QUERY | --query-file PATH] [-Q] [--format {text,stream-json}]",
  "  --format {text,stream-json}",
  "                        Output format for single-query mode (-q).",
].join("\n");

const HELP_WITHOUT_STREAM_JSON = [
  "usage: hermes chat [-h] [-q QUERY] [-m MODEL] [-Q] [--resume SESSION_ID]",
  "  -Q, --quiet           Quiet mode for programmatic use",
].join("\n");

describe("hermes stream-json helpers", () => {
  beforeEach(() => {
    resetHermesStreamJsonProbeCache();
  });

  it("detects stream-json support from `hermes chat --help`", () => {
    expect(hermesHelpAdvertisesStreamJson(HELP_WITH_STREAM_JSON)).toBe(true);
    expect(hermesHelpAdvertisesStreamJson(HELP_WITHOUT_STREAM_JSON)).toBe(false);
  });

  it("probes once per command and treats a failing probe as unsupported", async () => {
    const run = vi.fn(async () => ({ stdout: HELP_WITH_STREAM_JSON }));
    expect(await hermesSupportsStreamJson("/opt/hermes/bin/hermes", run)).toBe(true);
    expect(await hermesSupportsStreamJson("/opt/hermes/bin/hermes", run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("/opt/hermes/bin/hermes", ["chat", "--help"]);

    const failing = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    expect(await hermesSupportsStreamJson("/missing/hermes", failing)).toBe(false);
  });

  it("shares one in-flight probe, re-probes after the TTL, and never caches a failed probe", async () => {
    let clock = 0;
    const now = () => clock;
    let release: (value: { stdout: string }) => void = () => {};
    const slow = vi.fn(
      () =>
        new Promise<{ stdout: string }>((resolve) => {
          release = resolve;
        }),
    );
    const first = hermesSupportsStreamJson("/opt/hermes", slow, now);
    const second = hermesSupportsStreamJson("/opt/hermes", slow, now);
    release({ stdout: HELP_WITH_STREAM_JSON });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(slow).toHaveBeenCalledTimes(1);

    // Within the TTL the answer is reused; after it, Hermes is asked again.
    const downgraded = vi.fn(async () => ({ stdout: HELP_WITHOUT_STREAM_JSON }));
    clock = HERMES_STREAM_JSON_PROBE_TTL_MS - 1;
    expect(await hermesSupportsStreamJson("/opt/hermes", downgraded, now)).toBe(true);
    clock = HERMES_STREAM_JSON_PROBE_TTL_MS + 1;
    expect(await hermesSupportsStreamJson("/opt/hermes", downgraded, now)).toBe(false);
    expect(downgraded).toHaveBeenCalledTimes(1);

    // A timed-out probe answers false for that run only; the next run probes again.
    const timedOut = vi.fn(async () => {
      throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    });
    expect(await hermesSupportsStreamJson("/opt/slow-hermes", timedOut, now)).toBe(false);
    const recovered = vi.fn(async () => ({ stdout: HELP_WITH_STREAM_JSON }));
    expect(await hermesSupportsStreamJson("/opt/slow-hermes", recovered, now)).toBe(true);
    expect(recovered).toHaveBeenCalledTimes(1);

    // An explicit invalidation forgets the answer immediately.
    invalidateHermesStreamJsonProbe("/opt/slow-hermes");
    expect(await hermesSupportsStreamJson("/opt/slow-hermes", downgraded, now)).toBe(false);
  });

  it("recognises Hermes rejecting the --format flag", () => {
    expect(
      hermesRejectedStreamJsonFlag("usage: hermes [-h]\nhermes: error: unrecognized arguments: --format stream-json\n"),
    ).toBe(true);
    expect(hermesRejectedStreamJsonFlag("hermes chat: error: argument --format: invalid choice: 'stream-json'")).toBe(true);
    expect(hermesRejectedStreamJsonFlag("Error: provider returned 401")).toBe(false);
  });

  it("falls back to the stream's per-run usage only when the ledger has none, and marks it per-run", () => {
    const streamUsage = { inputTokens: 500, outputTokens: 80, cachedInputTokens: 0 };
    const ledgerMetered: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      usage: { inputTokens: 1500, outputTokens: 200, cachedInputTokens: 0 },
      resultJson: { meteringStatus: "metered" },
    };
    expect(applyHermesStreamUsageFallback(ledgerMetered, streamUsage)).toBe(ledgerMetered);

    const noLedger: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { meteringStatus: "unmetered_no_ledger" },
    };
    const fallback = applyHermesStreamUsageFallback(noLedger, streamUsage);
    expect(fallback.usage).toEqual(streamUsage);
    expect(fallback.resultJson).toMatchObject({
      usageBasis: "per_run",
      meteringStatus: "adapter_reported",
      ledgerMeteringStatus: "unmetered_no_ledger",
    });
  });

  it("honours the kill switch and an agent's own output-format choice", () => {
    expect(hermesStreamJsonDisabledByEnv({ AGENTDASH_HERMES_STREAM_JSON: "false" })).toBe(true);
    expect(hermesStreamJsonDisabledByEnv({ AGENTDASH_HERMES_STREAM_JSON: "0" })).toBe(true);
    expect(hermesStreamJsonDisabledByEnv({})).toBe(false);
    expect(hermesConfigPinsOutputFormat({ quiet: false })).toBe(true);
    expect(hermesConfigPinsOutputFormat({ extraArgs: ["--format", "text"] })).toBe(true);
    expect(hermesConfigPinsOutputFormat({ extraArgs: ["--checkpoints"] })).toBe(false);
    expect(withHermesStreamJsonArgs({ extraArgs: ["--checkpoints"] }).extraArgs).toEqual([
      "--checkpoints",
      "--format",
      "stream-json",
    ]);
  });

  it("treats session_id and blank stderr chunks as bookkeeping, not errors", () => {
    expect(isHermesBookkeepingStderr("\nsession_id: 20261001_231546_52cd79\n")).toBe(true);
    expect(isHermesBookkeepingStderr("\n")).toBe(true);
    expect(isHermesBookkeepingStderr("Error: provider returned 401\n")).toBe(false);
  });

  it("puts the stream's answer, session and usage on the result instead of raw JSONL", () => {
    const capture = createHermesStreamJsonCapture();
    // Split mid-line to prove the capture buffers partial lines.
    capture.feed(STREAM_JSON_STDOUT.slice(0, 200));
    capture.feed(STREAM_JSON_STDOUT.slice(200));
    const vendored: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: STREAM_JSON_STDOUT.slice(0, 2000),
      resultJson: { result: STREAM_JSON_STDOUT, session_id: null, usage: null, cost_usd: null },
    };
    const result = capture.apply(vendored, { persistSession: true });
    expect(result.summary).toBe("Smoke test passed: hermes-smoke-ok.");
    expect(result.sessionParams).toEqual({ sessionId: "20261001_231546_52cd79" });
    expect(result.sessionDisplayId).toBe("20261001_231546_");
    // Usage is the ledger's job; the stream's per-run counts are only a fallback.
    expect(result.usage).toBeUndefined();
    expect(capture.streamUsage()).toEqual({ inputTokens: 484, outputTokens: 196, cachedInputTokens: 37376 });
    expect(result.resultJson).toMatchObject({
      result: "Smoke test passed: hermes-smoke-ok.",
      session_id: "20261001_231546_52cd79",
      output_format: "stream-json",
    });
  });

  it("surfaces the stream's error on a failed run", () => {
    const capture = createHermesStreamJsonCapture();
    capture.feed(
      '{"type": "system", "subtype": "init", "model": "glm-5.3-flash", "session_id": "s-err", "timestamp": 1}\n' +
        '{"type": "result", "session_id": "s-err", "exit_code": 1, "text": "", "tokens": {"input": 0, "output": 0}, "error": "Provider returned 401 Unauthorized", "timestamp": 2}\n',
    );
    const result = capture.apply(
      { exitCode: 1, signal: null, timedOut: false, summary: "{\"type\": \"system\"" },
      { persistSession: false },
    );
    expect(result.errorMessage).toBe("Provider returned 401 Unauthorized");
    expect(result.summary).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
  });

  it("leaves a text-mode result untouched", () => {
    const capture = createHermesStreamJsonCapture();
    capture.feed("Heartbeat complete. Nothing assigned.\n");
    const original: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, summary: "Heartbeat complete." };
    expect(capture.apply(original, { persistSession: true })).toBe(original);
  });
});

async function writeFakeHermes(dir: string, options: { streamJson: boolean }) {
  const argsPath = join(dir, "args.json");
  const hermesCommand = join(dir, "hermes");
  const help = options.streamJson ? HELP_WITH_STREAM_JSON : HELP_WITHOUT_STREAM_JSON;
  await writeFile(
    hermesCommand,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const argv = process.argv.slice(2);",
      `if (argv.includes("--help")) { process.stdout.write(${JSON.stringify(help)} + "\\n"); process.exit(0); }`,
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ argv }));`,
      'if (argv.includes("stream-json")) {',
      `  process.stdout.write(${JSON.stringify(STREAM_JSON_STDOUT)});`,
      "} else {",
      '  process.stdout.write("Smoke test passed.\\n");',
      "}",
      'process.stderr.write("\\nsession_id: 20261001_231546_52cd79\\n");',
    ].join("\n"),
  );
  await chmod(hermesCommand, 0o755);
  return { hermesCommand, argsPath };
}

function buildCtx(hermesCommand: string, logs: Array<{ stream: string; chunk: string }>) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Priya",
      role: "pm",
      adapterType: "hermes_local",
      adapterConfig: { cwd: tmpdir(), hermesCommand },
    },
    runtime: {},
    config: {},
    context: {},
    authToken: "test-run-token",
    onLog: async (stream: string, chunk: string) => {
      logs.push({ stream, chunk });
    },
    onMeta: async () => {},
    onSpawn: async () => {},
  };
}

describe("hermes_local execute with stream-json", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
    delete process.env.AGENTDASH_HERMES_STREAM_JSON;
  });
  afterEach(() => {
    delete process.env.AGENTDASH_HERMES_STREAM_JSON;
  });

  it("launches Hermes with --format stream-json when the binary supports it and reports the real answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentdash-hermes-stream-json-"));
    const { hermesCommand, argsPath } = await writeFakeHermes(dir, { streamJson: true });
    const logs: Array<{ stream: string; chunk: string }> = [];

    const { getServerAdapter } = await import("../adapters/registry.js");
    const result = await getServerAdapter("hermes_local").execute(buildCtx(hermesCommand, logs) as never);

    const { argv } = JSON.parse(await readFile(argsPath, "utf8")) as { argv: string[] };
    expect(argv.slice(argv.indexOf("--format"), argv.indexOf("--format") + 2)).toEqual(["--format", "stream-json"]);
    expect(result.summary).toBe("Smoke test passed: hermes-smoke-ok.");
    expect(result.sessionParams).toMatchObject({ sessionId: "20261001_231546_52cd79" });
    // The session_id bookkeeping line is logged as stdout, not as an error.
    expect(logs.some((log) => log.stream === "stdout" && log.chunk.includes("session_id: 20261001_231546_52cd79"))).toBe(true);
    expect(logs.some((log) => log.stream === "stderr" && log.chunk.includes("session_id:"))).toBe(false);
  });

  it("keeps plain -Q text on a Hermes that predates stream-json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentdash-hermes-text-"));
    const { hermesCommand, argsPath } = await writeFakeHermes(dir, { streamJson: false });

    const { getServerAdapter } = await import("../adapters/registry.js");
    const result = await getServerAdapter("hermes_local").execute(buildCtx(hermesCommand, []) as never);

    const { argv } = JSON.parse(await readFile(argsPath, "utf8")) as { argv: string[] };
    expect(argv).not.toContain("--format");
    expect(argv).toContain("-Q");
    expect(result.summary).toBe("Smoke test passed.");
  });

  it("stays on text output when the kill switch is set", async () => {
    process.env.AGENTDASH_HERMES_STREAM_JSON = "false";
    const dir = await mkdtemp(join(tmpdir(), "agentdash-hermes-killswitch-"));
    const { hermesCommand, argsPath } = await writeFakeHermes(dir, { streamJson: true });

    const { getServerAdapter } = await import("../adapters/registry.js");
    await getServerAdapter("hermes_local").execute(buildCtx(hermesCommand, []) as never);

    const { argv } = JSON.parse(await readFile(argsPath, "utf8")) as { argv: string[] };
    expect(argv).not.toContain("--format");
  });
});

// A scriptable fake: each chat invocation plays the next step of a plan
// (stdout, stderr, exit code, and optionally a cumulative ledger row, the way
// a real Hermes updates `session_model_usage` for a resumed session).
const SCRIPTED_FAKE_HERMES = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const dir = process.env.HERMES_FAKE_DIR;
if (argv.includes("--help")) {
  process.stdout.write(fs.readFileSync(dir + "/help.txt", "utf8"));
  process.exit(0);
}
fs.appendFileSync(dir + "/calls.log", JSON.stringify(argv) + "\n");
const plan = JSON.parse(fs.readFileSync(dir + "/plan.json", "utf8"));
const counterPath = dir + "/counter";
const n = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;
fs.writeFileSync(counterPath, String(n + 1));
const step = plan[n];
if (step.ledger) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.env.AGENTDASH_HERMES_STATE_DB);
  db.exec("CREATE TABLE IF NOT EXISTS session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL)");
  db.prepare("DELETE FROM session_model_usage WHERE session_id = ?").run(step.ledger.session);
  db.prepare("INSERT INTO session_model_usage VALUES (?, 'glm-5.3-flash', 'zai', 1, ?, ?, 0, ?, ?)").run(step.ledger.session, step.ledger.input, step.ledger.output, step.ledger.costUsd || 0, step.ledger.costUsd || 0);
  db.close();
}
if (step.requiresNoFormat && argv.includes("--format")) {
  process.stderr.write("usage: hermes [-h]\nhermes: error: unrecognized arguments: --format stream-json\n");
  process.exit(2);
}
process.stdout.write(step.stdout || "");
if (step.stderr) process.stderr.write(step.stderr);
process.exit(step.exit || 0);
`;

interface PlanStep {
  stdout?: string;
  stderr?: string;
  exit?: number;
  requiresNoFormat?: boolean;
  ledger?: { session: string; input: number; output: number; costUsd?: number };
}

function streamRun(sessionId: string, perRun: { input: number; output: number }, events: string[] = []): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", model: "glm-5.3-flash", session_id: sessionId, timestamp: 1 }),
    ...events,
    JSON.stringify({ type: "text", text: "Done.", timestamp: 2 }),
    JSON.stringify({
      type: "result",
      session_id: sessionId,
      exit_code: 0,
      text: "Done.",
      tokens: { input: perRun.input, output: perRun.output, total: 0, cache_read: 0, cache_write: 0 },
      timestamp: 3,
    }),
    "",
  ].join("\n");
}

describe("hermes_local stream-json: metering, guard and downgrade", () => {
  let dir: string;
  let hermesCommand: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["AGENTDASH_HERMES_MANAGED_PROFILES", "AGENTDASH_HERMES_STREAM_JSON", "AGENTDASH_HERMES_STATE_DB", "HERMES_FAKE_DIR"];

  async function setup(plan: PlanStep[], options: { helpAdvertises?: boolean; ledger?: boolean } = {}) {
    await writeFile(join(dir, "plan.json"), JSON.stringify(plan));
    await writeFile(join(dir, "help.txt"), (options.helpAdvertises ?? true) ? HELP_WITH_STREAM_JSON : HELP_WITHOUT_STREAM_JSON);
    process.env.AGENTDASH_HERMES_STATE_DB = join(dir, options.ledger === false ? "missing/state.db" : "state.db");
  }

  async function runOnce(sessionId: string | null, logs: Array<{ stream: string; chunk: string }> = []) {
    const { getServerAdapter } = await import("../adapters/registry.js");
    const ctx = buildCtx(hermesCommand, logs);
    return getServerAdapter("hermes_local").execute({
      ...ctx,
      runtime: sessionId ? { sessionParams: { sessionId } } : {},
    } as never);
  }

  async function calls(): Promise<string[][]> {
    return (await readFile(join(dir, "calls.log"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  }

  beforeEach(async () => {
    vi.resetModules();
    for (const key of ENV) saved[key] = process.env[key];
    for (const key of ENV) delete process.env[key];
    dir = await mkdtemp(join(tmpdir(), "agentdash-hermes-scripted-"));
    hermesCommand = join(dir, "hermes");
    await writeFile(hermesCommand, SCRIPTED_FAKE_HERMES);
    await chmod(hermesCommand, 0o755);
    process.env.HERMES_FAKE_DIR = dir;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("meters a resumed session from the cumulative ledger, so run 2 bills exactly its own 500 tokens", async () => {
    const session = "20261001_resumed_01";
    await setup([
      // Run 1: ledger total 1000; the stream reports the same 1000 for this run.
      { stdout: streamRun(session, { input: 1000, output: 100 }), ledger: { session, input: 1000, output: 100 } },
      // Run 2 resumes: ledger total 1500; the stream reports only this run's 500.
      { stdout: streamRun(session, { input: 500, output: 60 }), ledger: { session, input: 1500, output: 160 } },
    ]);

    const run1 = await runOnce(null);
    const run2 = await runOnce(session);

    expect((await calls())[1]).toEqual(expect.arrayContaining(["--resume", session]));
    // Both runs carry the ledger's cumulative totals, never the stream's per-run numbers.
    expect(run1.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
    expect(run2.usage).toMatchObject({ inputTokens: 1500, outputTokens: 160 });
    expect(run2.resultJson).toMatchObject({ meteringStatus: "metered" });
    expect((run2.resultJson as Record<string, unknown>).usageBasis).toBeUndefined();

    // Heartbeat's session delta then bills run 2 for what the ledger says it used.
    const { deriveNormalizedUsageDelta } = await import("../services/heartbeat.js");
    const totals = (usage: typeof run1.usage) => ({
      inputTokens: usage?.inputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
    });
    expect(deriveNormalizedUsageDelta(totals(run2.usage), totals(run1.usage))).toEqual({
      inputTokens: 500,
      cachedInputTokens: 0,
      outputTokens: 60,
    });
  });

  it("falls back to the stream's per-run usage when the ledger is unreadable, without double billing the next run", async () => {
    const session = "20261001_resumed_02";
    await setup([{ stdout: streamRun(session, { input: 500, output: 60 }) }], { ledger: false });

    const run2 = await runOnce(session);

    expect(run2.usage).toMatchObject({ inputTokens: 500, outputTokens: 60 });
    expect(run2.resultJson).toMatchObject({ usageBasis: "per_run", meteringStatus: "adapter_reported" });

    // Heartbeat bills the 500 as-is (no subtraction from run 1's cumulative
    // 1000) and stores 1500 as the running total, so run 3's cumulative 1800
    // from a readable ledger is billed 300, not 800.
    const { resolvePerRunUsage, deriveNormalizedUsageDelta } = await import("../services/heartbeat.js");
    const run1Raw = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 };
    const perRun = resolvePerRunUsage({ inputTokens: 500, cachedInputTokens: 0, outputTokens: 60 }, run1Raw);
    expect(perRun.normalizedUsage).toEqual({ inputTokens: 500, cachedInputTokens: 0, outputTokens: 60 });
    expect(perRun.storedRawUsage).toEqual({ inputTokens: 1500, cachedInputTokens: 0, outputTokens: 160 });
    expect(
      deriveNormalizedUsageDelta({ inputTokens: 1800, cachedInputTokens: 0, outputTokens: 200 }, perRun.storedRawUsage),
    ).toEqual({ inputTokens: 300, cachedInputTokens: 0, outputTokens: 40 });
  });

  it("takes cost only from the ledger, not from 'spent'/'cost' text in tool output", async () => {
    const session = "20261001_cost_01";
    const toolOutput = JSON.stringify({ output: "Build spent 3 minutes; cost: 12 widgets", exit_code: 0, error: null });
    await setup([
      {
        stdout: streamRun(session, { input: 900, output: 90 }, [
          JSON.stringify({ type: "tool_use", name: "terminal", input: { command: "make" }, timestamp: 4 }),
          JSON.stringify({ type: "tool_result", name: "terminal", output: toolOutput, is_error: false, timestamp: 5 }),
        ]),
        ledger: { session, input: 900, output: 90, costUsd: 0.42 },
      },
    ]);

    const result = await runOnce(null);

    expect(result.costUsd).toBe(0.42);
    expect(result.usage).toMatchObject({ inputTokens: 900, outputTokens: 90 });
    expect((result.resultJson as Record<string, unknown>).usageBasis).toBeUndefined();
  });

  it("does not take a cost from tool output in the per-run fallback either", async () => {
    const session = "20261001_cost_02";
    const toolOutput = JSON.stringify({ output: "spent 3 minutes, cost: 12", exit_code: 0, error: null });
    await setup(
      [
        {
          stdout: streamRun(session, { input: 300, output: 30 }, [
            JSON.stringify({ type: "tool_result", name: "terminal", output: toolOutput, is_error: false, timestamp: 5 }),
          ]),
        },
      ],
      { ledger: false },
    );

    const result = await runOnce(null);

    expect(result.resultJson).toMatchObject({ usageBasis: "per_run" });
    expect(result.costUsd ?? null).toBeNull();
  });

  it("bills zero for the overlap when a ledger reading comes in below a per-run fallback baseline", async () => {
    const { pickUsageBaseline, deriveUsageDeltaAfterPerRunBaseline, deriveNormalizedUsageDelta } = await import(
      "../services/heartbeat.js"
    );
    // Run 2 fell back to the stream: stored running total = ledger 1000 + 500.
    const baseline = pickUsageBaseline([
      {
        id: "run-2",
        usageJson: { inputTokens: 500, rawInputTokens: 1500, rawOutputTokens: 160, usageSource: "per_run" },
      },
    ]);
    expect(baseline?.fromPerRunFallback).toBe(true);
    // Run 3's ledger says the session total is 1400: run 2 really used 400.
    const reading = { inputTokens: 1400, cachedInputTokens: 0, outputTokens: 150 };
    // The plain reset rule would bill all 1400 again...
    expect(deriveNormalizedUsageDelta(reading, baseline!.totals).inputTokens).toBe(1400);
    // ...the per-run-aware rule bills nothing for the overlap; 1400 becomes the new baseline.
    expect(deriveUsageDeltaAfterPerRunBaseline(reading, baseline!.totals)).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    // Above the stored total, only the excess is billed.
    expect(
      deriveUsageDeltaAfterPerRunBaseline({ inputTokens: 1700, cachedInputTokens: 0, outputTokens: 200 }, baseline!.totals),
    ).toEqual({ inputTokens: 200, cachedInputTokens: 0, outputTokens: 40 });
    // A ledger-derived baseline keeps the existing behaviour.
    expect(pickUsageBaseline([{ id: "run-1", usageJson: { rawInputTokens: 1000 } }])?.fromPerRunFallback).toBe(false);
  });

  it("fails the run closed when the clarify fallback arrives JSON-escaped and split across events", async () => {
    const session = "20261001_clarify_01";
    // Hand-written: the tool result carries the TUI line with its em dash
    // JSON-escaped (—), and the oneshot marker is split across two
    // streamed text deltas. No raw log chunk contains either marker as text.
    const toolResult =
      '{"type": "tool_result", "name": "clarify", "output": "{\\"output\\": \\"(no answer \\\\u2014 agent will decide)\\", \\"exit_code\\": 0, \\"error\\": null}", "is_error": false, "timestamp": 5}';
    const splitA = '{"type": "text", "text": "Hermes said [oneshot mode: no ", "timestamp": 6}';
    const splitB = '{"type": "text", "text": "user available] so I picked option A.", "timestamp": 7}';
    await setup([
      {
        stdout: streamRun(session, { input: 10, output: 5 }, [
          '{"type": "tool_use", "name": "clarify", "input": {"question": "Which option?"}, "timestamp": 4}',
          toolResult,
          splitA,
          splitB,
        ]),
        ledger: { session, input: 10, output: 5 },
      },
    ]);
    const logs: Array<{ stream: string; chunk: string }> = [];

    const result = await runOnce(null, logs);

    const { detectHermesHumanQuestionFallback } = await import("../adapters/hermes-human-question.js");
    expect(logs.filter((log) => log.chunk.includes('"type"')).some((log) => detectHermesHumanQuestionFallback(log.chunk))).toBe(false);
    expect(result.errorCode).toBe("human_question_unanswered");
    expect(result.errorMeta).toMatchObject({ humanQuestionFallback: expect.stringContaining("agent will decide)") });
  });

  it("catches a fallback marker split across decoded text events", async () => {
    const { createHermesHumanQuestionGuard } = await import("../adapters/hermes-human-question.js");
    const guard = createHermesHumanQuestionGuard(async () => {});
    await guard.observeText("Hermes said [oneshot mode: no ");
    expect(guard.evidence).toHaveLength(0);
    await guard.observeText("user available] so I picked option A.");
    expect(guard.evidence).toEqual(["[oneshot mode: no user available"]);
  });

  it("reruns once in text mode when Hermes rejects --format, and probes again afterwards", async () => {
    await setup([
      { requiresNoFormat: true },
      { stdout: "Text mode answer.\n", stderr: "\nsession_id: 20261001_downgrade_01\n" },
      { stdout: "Second run answer.\n", stderr: "\nsession_id: 20261001_downgrade_02\n" },
    ]);
    const logs: Array<{ stream: string; chunk: string }> = [];

    const result = await runOnce(null, logs);

    const first = await calls();
    expect(first).toHaveLength(2);
    expect(first[0]).toContain("--format");
    expect(first[1]).not.toContain("--format");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Text mode answer.");
    expect(logs.some((log) => log.chunk.includes("retrying in text mode"))).toBe(true);

    // The probe answer was dropped; with the fake now reporting no support,
    // the next run goes straight to text mode.
    await writeFile(join(dir, "help.txt"), HELP_WITHOUT_STREAM_JSON);
    await runOnce(null);
    const all = await calls();
    expect(all).toHaveLength(3);
    expect(all[2]).not.toContain("--format");
  });
});
