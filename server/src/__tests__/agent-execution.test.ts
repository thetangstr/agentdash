import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAgentSchema } from "@paperclipai/shared";
import { getServerAdapter, requireServerAdapter } from "../adapters/index.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/types.js";

/**
 * The suite that actually runs an agent.
 *
 * Everything else in this repo tests the machinery *around* execution — routes,
 * validators, schedulers, the board deck driving agents over the API with their
 * own keys. None of it ever spawns an adapter. That gap is not theoretical: the
 * Chief and Delivery agents shipped on 2026-08-08 with `adapterType: "process"`
 * and no `command`, and sat unrunnable for four days while 4,819 tests passed
 * and the demo deck reported `ok=26 broken=0`. Every heartbeat threw "Process
 * adapter missing command" into the server log, where nobody was looking.
 *
 * So these tests execute real child processes through the real registry. They
 * are hermetic — the only binary they need is the Node that is already running
 * them — and they assert the three things the log was saying and no test heard:
 * a working agent produces output, a broken one fails loudly, and a failing one
 * is never reported as success.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");

function executionContext(
  config: Record<string, unknown>,
  logs: Array<{ stream: string; chunk: string }>,
): AdapterExecutionContext {
  return {
    runId: "run-agent-execution-test",
    agent: {
      id: "00000000-0000-4000-8000-00000000a9e7",
      companyId: "00000000-0000-4000-8000-00000000c0a1",
      name: "Delivery",
      adapterType: "process",
      adapterConfig: config,
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: {},
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
  };
}

function runProcessAgent(
  config: Record<string, unknown>,
): { result: Promise<AdapterExecutionResult>; logs: Array<{ stream: string; chunk: string }> } {
  const logs: Array<{ stream: string; chunk: string }> = [];
  const adapter = requireServerAdapter("process");
  return { result: adapter.execute(executionContext(config, logs)), logs };
}

describe("agent execution", () => {
  it("runs a configured process agent and returns its output", async () => {
    const { result, logs } = runProcessAgent({
      command: process.execPath,
      args: ["-e", "process.stdout.write('AGENT_RAN')"],
    });
    const outcome = await result;

    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.errorMessage).toBeUndefined();
    expect(String((outcome.resultJson as { stdout?: string })?.stdout)).toContain("AGENT_RAN");
    // The log stream is how a run becomes visible in the UI. An agent that runs
    // but streams nothing looks identical to one that never started.
    expect(logs.map((l) => l.chunk).join("")).toContain("AGENT_RAN");
  });

  /**
   * The exact configuration Chief and Delivery shipped with.
   *
   * The assertion that matters is not the message — it is that this *throws*
   * rather than resolving. A resolved result with `exitCode: 0` is how a
   * permanently broken agent passes for a healthy one.
   */
  it("fails loudly when a process agent has no command", async () => {
    const { result } = runProcessAgent({});
    await expect(result).rejects.toThrow(/missing command/i);
  });

  it("reports a non-zero exit as a failure instead of a successful run", async () => {
    const { result } = runProcessAgent({
      command: process.execPath,
      args: ["-e", "process.stderr.write('boom'); process.exit(3)"],
    });
    const outcome = await result;

    expect(outcome.exitCode).toBe(3);
    expect(outcome.errorMessage).toMatch(/exited with code 3/);
  });

  /**
   * `getServerAdapter` returns the process adapter for any unknown type. That
   * makes a typo in `adapterType` silently become a process agent — which then
   * fails with "missing command" for a reason that has nothing to do with the
   * actual mistake. `requireServerAdapter` is the honest lookup; this pins the
   * difference so the forgiving one is a deliberate choice at each call site.
   */
  it("distinguishes the forgiving adapter lookup from the strict one", () => {
    expect(() => requireServerAdapter("procces")).toThrow(/Unknown adapter type/);
    expect(getServerAdapter("procces")).toBe(getServerAdapter("process"));
  });
});

/**
 * Returns the `adapterType: "process"` declarations that never set a command.
 *
 * A source-text check, because the seed script is a standalone .mjs that talks
 * to a live server over HTTP — importing it would run an install. The check is
 * proven against a known-broken sample below before it is trusted against the
 * real file, so a guard that silently stops matching cannot pass as a clean
 * seed.
 */
function processSpecsMissingCommand(source: string): number {
  const matches = [...source.matchAll(/adapterType:\s*"process"/g)];
  return matches.filter((match) => {
    const start = match.index ?? 0;
    const window = source.slice(start, start + 300);
    return !/command:\s*["'`]/.test(window);
  }).length;
}

describe("seeded agents are runnable", () => {
  it("detects a process agent declared without a command", () => {
    const broken = `agentdashHireAgent { name: "Delivery", role: "engineer", adapterType: "process",
                        adapterConfig: {} }`;
    expect(processSpecsMissingCommand(broken)).toBe(1);
  });

  it("seeds the Chief on the harness the workspace actually runs", () => {
    const source = readFileSync(resolve(REPO_ROOT, "scripts/demo/first-run.mjs"), "utf8");
    // `process` + /usr/bin/true passed every check and did nothing. An inert
    // agent is harder to notice than a broken one, so the seed is pinned to the
    // adapter the live workspace runs rather than merely to "something valid".
    expect(source).toMatch(/name:\s*"Chief"[\s\S]{0,120}adapterType:\s*"hermes_local"/);
    // Config values only — the comment above the seed names /usr/bin/true to
    // explain why it is not used, and that prose is not a regression.
    expect(source).not.toMatch(/command:\s*["'`]\/usr\/bin\/true/);
  });

  /**
   * Every seed script, not just the one that had the bug.
   *
   * The guard originally read `first-run.mjs` alone, and
   * `mkthink-company.mjs` — the script used to stand up a real customer's
   * workspace — quietly carried the same defect: four agents created as
   * `process` with no `adapterConfig` at all. It was found days before an
   * on-site install, by reading, not by this suite. Scanning the directory
   * means a new script is covered the moment it is added.
   */
  it("ships no commandless process agents in any demo seed", () => {
    const dir = resolve(REPO_ROOT, "scripts/demo");
    const scripts = readdirSync(dir).filter((file) => file.endsWith(".mjs"));
    expect(scripts.length).toBeGreaterThan(0);

    const offenders = scripts.filter(
      (file) => processSpecsMissingCommand(readFileSync(resolve(dir, file), "utf8")) > 0,
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The seed talks to the live API, so a payload it sends is only good if the
   * route's own validator accepts it. Pinning the shape against the real schema
   * catches a seed that reads fine and 400s on a cold install — which is the
   * one run nobody is watching.
   */
  it("accepts the seeded Chief payload through the real create validator", () => {
    const seeded = createAgentSchema.safeParse({
      name: "Chief",
      role: "chief_of_staff",
      adapterType: "hermes_local",
      adapterConfig: {},
    });
    expect(seeded.success).toBe(true);

    // Same payload on `process` is the original defect, and must still fail.
    const asProcess = createAgentSchema.safeParse({
      name: "Chief",
      role: "chief_of_staff",
      adapterType: "process",
      adapterConfig: {},
    });
    expect(asProcess.success).toBe(false);
  });
});
