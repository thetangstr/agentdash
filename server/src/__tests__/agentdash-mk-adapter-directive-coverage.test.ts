// AgentDash-MK: every adapter must actually hand the steward's directives to
// the thing it drives.
//
// Slice 1 wired `renderAgentDirectivesPrompt` into all eight adapters and
// asserted the result for exactly one of them. Seven were typechecked and read.
// A directive that reaches an adapter's local variable and not the model is the
// same failure as a service function with tests and no caller — the difference
// between "wired" and "works" is a test that reads the far end of the wire.
//
// So each case below drives the adapter's real exported `execute` and reads the
// prompt *the adapter handed to its runtime*: the bytes on the child process's
// stdin or argv, the text passed to `AcpRuntime.startTurn`, or the `message`
// field the gateway WebSocket actually received. None of them read `onMeta`,
// which is a reporting side-channel and would pass even if the prompt sent on
// the real path were a different variable.
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { createAcpxLocalExecutor } from "@paperclipai/adapter-acpx-local/server";
import { execute as executeClaudeLocal } from "@paperclipai/adapter-claude-local/server";
import { execute as executeCodexLocal } from "@paperclipai/adapter-codex-local/server";
import { execute as executeCursorLocal } from "@paperclipai/adapter-cursor-local/server";
import { execute as executeGeminiLocal } from "@paperclipai/adapter-gemini-local/server";
import { execute as executeOpenClawGateway } from "@paperclipai/adapter-openclaw-gateway/server";
import { execute as executeOpenCodeLocal } from "@paperclipai/adapter-opencode-local/server";
import { execute as executePiLocal } from "@paperclipai/adapter-pi-local/server";
import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpRuntimeTurnResult,
} from "acpx/runtime";

const DIRECTIVE_BODY = "Never contact a client directly. Escalate to your steward instead.";

const PUSHED_DIRECTIVES = {
  version: 7,
  directives: DIRECTIVE_BODY,
  pushedAt: "2026-08-02T10:00:00.000Z",
  pushedByUserId: "steward-1",
};

/**
 * The three things every adapter's emitted prompt must carry.
 *
 * The body alone is not enough. The frame is load-bearing: directives arrive
 * from a trusted authority but grant nothing, and an adapter that shipped the
 * text without the frame would hand the model prose it would reasonably read as
 * authorization the structured policy never gave.
 */
function expectDirectivesInEmittedPrompt(emitted: string, adapterType: string) {
  expect(emitted, `${adapterType} did not emit the directive body`).toContain(DIRECTIVE_BODY);
  expect(emitted, `${adapterType} did not emit the directives heading`).toContain(
    "Operating Directives",
  );
  expect(emitted, `${adapterType} did not emit the directives version`).toContain("v7");
  expect(emitted, `${adapterType} dropped the non-granting frame`).toContain("cannot grant");
}

// ---------------------------------------------------------------------------
// child-process adapters
// ---------------------------------------------------------------------------

type ChildCapture = { argv: string[]; stdin: string };

/**
 * A fake agent binary that records everything it was handed and then prints
 * `stdoutLines` so the adapter's own parser has something well-formed to read.
 *
 * stdio[0] is "ignore" (i.e. /dev/null) when the adapter passes no stdin, so
 * reading fd 0 is safe for the argv-delivering adapters too.
 */
async function writeCapturingCommand(
  commandPath: string,
  capturePath: string,
  stdoutLines: unknown[],
): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
// Model-discovery probes run before the real turn and must not clobber the
// capture written by it.
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
if (process.argv[2] === "models") {
  console.log("anthropic/claude-sonnet-4");
  process.exit(0);
}
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch { stdin = ""; }
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  argv: process.argv.slice(2),
  stdin,
}), "utf8");
${stdoutLines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("\n")}
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

/**
 * Whatever the adapter handed the process, in one string. Some adapters deliver
 * the prompt on stdin and some as the trailing argv entry; the property under
 * test is "the directives reached the process", not which pipe carried them.
 */
async function readEmittedPrompt(capturePath: string): Promise<string> {
  const raw = await fs.readFile(capturePath, "utf8");
  const capture = JSON.parse(raw) as ChildCapture;
  return [capture.stdin ?? "", ...(capture.argv ?? [])].join("\n");
}

function baseContext(
  overrides: {
    adapterType: string;
    config: Record<string, unknown>;
  },
): AdapterExecutionContext {
  return {
    runId: "run-directives-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Directive Agent",
      adapterType: overrides.adapterType,
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: overrides.config,
    context: {
      issueId: "issue-1",
      paperclipTaskMarkdown: "Task context",
      paperclipAgentDirectives: PUSHED_DIRECTIVES,
    },
    onLog: async () => {},
  };
}

/**
 * Runs a spawn-based adapter against a fake binary in an isolated HOME and
 * returns what that binary received. HOME is redirected because several of
 * these adapters materialize skills and config under the user's home.
 */
async function runSpawningAdapter(input: {
  prefix: string;
  commandName: string;
  adapterType: string;
  stdoutLines: unknown[];
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
  extraConfig?: Record<string, unknown>;
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), input.prefix));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const commandPath = path.join(root, input.commandName);
  const capturePath = path.join(root, "capture.json");
  await writeCapturingCommand(commandPath, capturePath, input.stdoutLines);

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    await input.execute(
      baseContext({
        adapterType: input.adapterType,
        config: {
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Do the assigned work.",
          ...(input.extraConfig ?? {}),
        },
      }),
    );
    return await readEmittedPrompt(capturePath);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// acpx-local — no child process; the prompt goes to AcpRuntime.startTurn
// ---------------------------------------------------------------------------

class CapturingAcpRuntime implements AcpRuntime {
  startInputs: Array<{ text: string }> = [];
  private ensureCount = 0;

  constructor(readonly options: AcpRuntimeOptions) {}

  async ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    resumeSessionId?: string;
  }): Promise<AcpRuntimeHandle> {
    this.ensureCount += 1;
    return {
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime-${this.ensureCount}`,
      cwd: input.cwd,
      acpxRecordId: `record-${this.ensureCount}`,
      backendSessionId: `acp-${this.ensureCount}`,
      agentSessionId: `agent-${this.ensureCount}`,
    };
  }

  startTurn(input: { handle: AcpRuntimeHandle; text: string; requestId: string }): AcpRuntimeTurn {
    this.startInputs.push({ text: input.text });
    const events: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "ok", stream: "output", tag: "agent_message_chunk" },
    ];
    const terminal: AcpRuntimeTurnResult = { status: "completed", stopReason: "end_turn" };
    return {
      requestId: input.requestId,
      events: {
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) yield event;
        },
      },
      result: Promise.resolve(terminal),
      cancel: async () => {},
      closeStream: async () => {},
    };
  }

  runTurn(): AsyncIterable<AcpRuntimeEvent> {
    throw new Error("not used");
  }

  getCapabilities() {
    return { controls: [] };
  }

  getStatus() {
    return Promise.resolve({});
  }

  async setMode() {}
  async setConfigOption() {}
  async cancel() {}
  async close() {}
}

async function runAcpxLocal(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentdash-directives-acpx-"));
  try {
    let runtime: CapturingAcpRuntime | null = null;
    const execute = createAcpxLocalExecutor({
      createRuntime: (options) => {
        runtime = new CapturingAcpRuntime(options);
        return runtime;
      },
    });
    await execute(
      baseContext({
        adapterType: "acpx_local",
        config: {
          agent: "claude",
          cwd: root,
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
        },
      }),
    );
    const captured = runtime as CapturingAcpRuntime | null;
    return captured?.startInputs.map((input) => input.text).join("\n") ?? "";
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// openclaw-gateway — no child process and no joinPromptSections seam.
//
// A2: this adapter's directive path is genuinely different. It has no prompt
// section list; it speaks JSON-RPC over a WebSocket and its "prompt" is the
// `message` field of the `agent` request. Rather than invent a seam that only
// this adapter would use, the different path is exercised directly: a real
// gateway server is stood up, the adapter connects to it for real, and the test
// reads `message` off the frame the server received.
// ---------------------------------------------------------------------------

async function createRecordingGateway() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let agentParams: Record<string, unknown> | null = null;

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-1" },
      }),
    );
    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: {
                maxPayload: 1_000_000,
                maxBufferedBytes: 1_000_000,
                tickIntervalMs: 30_000,
              },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent") {
        agentParams = frame.params ?? null;
        const runId =
          typeof frame.params?.idempotencyKey === "string" ? frame.params.idempotencyKey : "run-1";
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId, status: "accepted", acceptedAt: Date.now() },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId,
              seq: 1,
              stream: "assistant",
              ts: Date.now(),
              data: { delta: "ok" },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent.wait") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId: frame.params?.runId, status: "ok", startedAt: 1, endedAt: 2 },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no gateway address");

  return {
    url: `ws://127.0.0.1:${address.port}`,
    getAgentParams: () => agentParams,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function runOpenClawGateway(): Promise<string> {
  const gateway = await createRecordingGateway();
  try {
    await executeOpenClawGateway(
      baseContext({
        adapterType: "openclaw_gateway",
        config: { url: gateway.url, waitTimeoutMs: 5_000 },
      }),
    );
    const params = gateway.getAgentParams();
    return typeof params?.message === "string" ? params.message : "";
  } finally {
    await gateway.close();
  }
}

// ---------------------------------------------------------------------------
// coverage table — the single source of truth for A1/A2/A3
// ---------------------------------------------------------------------------

/**
 * Keyed by the adapter's package directory under `packages/adapters/`, because
 * that is the set the guard test enumerates from disk. Adding an adapter
 * package without adding a row here fails the guard.
 */
const DIRECTIVE_COVERAGE: Record<string, () => Promise<string>> = {
  "acpx-local": runAcpxLocal,
  "claude-local": () =>
    runSpawningAdapter({
      prefix: "agentdash-directives-claude-",
      commandName: "claude",
      adapterType: "claude_local",
      execute: executeClaudeLocal,
      stdoutLines: [
        { type: "system", subtype: "init", session_id: "claude-1", model: "claude-sonnet" },
        {
          type: "assistant",
          session_id: "claude-1",
          message: { content: [{ type: "text", text: "ok" }] },
        },
        {
          type: "result",
          session_id: "claude-1",
          result: "ok",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        },
      ],
    }),
  "codex-local": () =>
    runSpawningAdapter({
      prefix: "agentdash-directives-codex-",
      commandName: "codex-acp",
      adapterType: "codex_local",
      execute: executeCodexLocal,
      stdoutLines: [
        { type: "thread.started", thread_id: "codex-1" },
        { type: "item.completed", item: { type: "agent_message", text: "ok" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
      ],
    }),
  "cursor-local": () =>
    runSpawningAdapter({
      prefix: "agentdash-directives-cursor-",
      commandName: "agent",
      adapterType: "cursor",
      execute: executeCursorLocal,
      stdoutLines: [
        { type: "system", subtype: "init", session_id: "cursor-1", model: "auto" },
        { type: "assistant", message: { content: [{ type: "output_text", text: "ok" }] } },
        { type: "result", subtype: "success", session_id: "cursor-1", result: "ok" },
      ],
    }),
  "gemini-local": () =>
    runSpawningAdapter({
      prefix: "agentdash-directives-gemini-",
      commandName: "gemini",
      adapterType: "gemini_local",
      execute: executeGeminiLocal,
      stdoutLines: [
        { type: "system", subtype: "init", session_id: "gemini-1", model: "gemini-2.5-pro" },
        { type: "assistant", message: { content: [{ type: "output_text", text: "ok" }] } },
        { type: "result", subtype: "success", session_id: "gemini-1", result: "ok" },
      ],
    }),
  "openclaw-gateway": runOpenClawGateway,
  "opencode-local": () =>
    runSpawningAdapter({
      prefix: "agentdash-directives-opencode-",
      commandName: "opencode",
      adapterType: "opencode_local",
      execute: executeOpenCodeLocal,
      extraConfig: { model: "anthropic/claude-sonnet-4" },
      stdoutLines: [
        { type: "session", id: "opencode-1" },
        { type: "message", role: "assistant", parts: [{ type: "text", text: "ok" }] },
      ],
    }),
  "pi-local": () =>
    runSpawningAdapter({
      prefix: "agentdash-directives-pi-",
      commandName: "pi",
      adapterType: "pi_local",
      execute: executePiLocal,
      extraConfig: { model: "google/gemini-3-flash-preview" },
      stdoutLines: [
        { type: "agent_start" },
        { type: "turn_start" },
        {
          type: "turn_end",
          message: { role: "assistant", content: "ok" },
          toolResults: [],
        },
        { type: "agent_end", messages: [] },
      ],
    }),
};

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const ADAPTERS_DIR = path.join(REPO_ROOT, "packages", "adapters");

describe("agentdash-mk harness directives reach every adapter's emitted prompt", () => {
  // A1/A2.
  for (const [adapterDir, run] of Object.entries(DIRECTIVE_COVERAGE)) {
    it(`${adapterDir} emits pushed directives into the prompt it hands its runtime`, async () => {
      const emitted = await run();
      expect(emitted.length, `${adapterDir} emitted nothing`).toBeGreaterThan(0);
      expectDirectivesInEmittedPrompt(emitted, adapterDir);
    }, 30_000);
  }

  // A3. The gap this closes is not "an adapter is wrong" but "an adapter was
  // added and nobody noticed the directives stopped applying to it". A silent
  // hole in a governance channel is worse than a loud one, so the guard reads
  // the adapter set off disk rather than trusting a list someone maintains.
  it("fails when an adapter package exists without directive wiring or coverage", async () => {
    const entries = await fs.readdir(ADAPTERS_DIR, { withFileTypes: true });
    const adapterDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(adapterDirs.length).toBeGreaterThan(0);
    expect(Object.keys(DIRECTIVE_COVERAGE).sort()).toEqual(adapterDirs);

    for (const adapterDir of adapterDirs) {
      const executePath = path.join(ADAPTERS_DIR, adapterDir, "src", "server", "execute.ts");
      const source = await fs.readFile(executePath, "utf8");
      expect(
        source,
        `${adapterDir}/src/server/execute.ts does not call renderAgentDirectivesPrompt`,
      ).toContain("renderAgentDirectivesPrompt");
      expect(
        source,
        `${adapterDir} renders directives but never puts the result into a prompt`,
      ).toContain("agentDirectivesNote");
    }
  });

  // The other half of "coverage": an adapter package can carry its own suite and
  // still be executed by nobody. `packages/mcp-server` shipped 96 tests in that
  // state. `packages/adapters/openclaw-gateway` was in it too — which is how the
  // weakest directive path in the system came to have a test file no runner
  // opened. Both runner manifests are checked because they are maintained
  // separately and drifted apart already.
  it("fails when an adapter package carries tests that no runner executes", async () => {
    const vitestConfig = await fs.readFile(path.join(REPO_ROOT, "vitest.config.ts"), "utf8");
    const stableRunner = await fs.readFile(
      path.join(REPO_ROOT, "scripts", "run-vitest-stable.mjs"),
      "utf8",
    );

    const entries = await fs.readdir(ADAPTERS_DIR, { withFileTypes: true });
    const missing: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const adapterRoot = path.join(ADAPTERS_DIR, entry.name);
      if (!(await hasTestFile(path.join(adapterRoot, "src")))) continue;

      const pkg = JSON.parse(
        await fs.readFile(path.join(adapterRoot, "package.json"), "utf8"),
      ) as { name: string };

      if (!vitestConfig.includes(`packages/adapters/${entry.name}`)) {
        missing.push(`${entry.name} is not a project in vitest.config.ts`);
      }
      if (!stableRunner.includes(`"${pkg.name}"`)) {
        missing.push(`${pkg.name} is not in run-vitest-stable.mjs nonServerProjects`);
      }
    }

    expect(missing).toEqual([]);
  });
});

async function hasTestFile(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    if (entry.isDirectory()) {
      if (await hasTestFile(path.join(dir, entry.name))) return true;
    } else if (entry.name.endsWith(".test.ts")) {
      return true;
    }
  }
  return false;
}
