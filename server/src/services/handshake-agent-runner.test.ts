import { describe, expect, it, vi } from "vitest";
import {
  extractDecision,
  extractReasoning,
  handshakeAgentRunner,
  type HandshakeExecuteFn,
} from "./handshake-agent-runner.js";

// A fake `execute` that emits canned adapter output via onLog — proves the
// decision-extraction contract WITHOUT spawning a real Hermes.
function fakeExecute(output: string): HandshakeExecuteFn {
  return vi.fn(async (ctx) => {
    await ctx.onLog("stdout", output);
    return { exitCode: 0, signal: null, timedOut: false } as never;
  });
}

// Runner wired with in-memory fs seams + a stubbed profile command so no real
// filesystem or hermes profile is touched.
function runnerWith(output: string) {
  const execute = fakeExecute(output);
  const writes: Array<{ path: string; content: string }> = [];
  const runner = handshakeAgentRunner({
    execute,
    ensureCommand: async () => "/bin/agentdash-fake",
    mkdtemp: (prefix) => `/tmp/${prefix}run`,
    writeFile: (path, content) => {
      writes.push({ path, content });
    },
  });
  return { runner, execute, writes };
}

const INPUT = {
  agentId: "atlas-1",
  name: "Atlas",
  companyId: "co-1",
  role: "ceo",
  agentsMd: "You are Atlas.",
  task: 'Reply "APPROVE: <why>" or "DECLINE: <why>".',
};

describe("extractDecision", () => {
  it("APPROVE → approved true", () => {
    expect(extractDecision("APPROVE: within cap and policy")).toEqual({
      decision: "APPROVE: within cap and policy",
      approved: true,
    });
  });

  it("DECLINE → approved false", () => {
    expect(extractDecision("DECLINE: cap too high for this vendor")).toEqual({
      decision: "DECLINE: cap too high for this vendor",
      approved: false,
    });
  });

  it("ACCEPT → approved true", () => {
    expect(extractDecision("ACCEPT: reasonable scope").approved).toBe(true);
  });

  it("REJECT → approved false", () => {
    expect(extractDecision("REJECT: unknown counterparty").approved).toBe(false);
  });

  it("parses the decision line even when it appears after a session_id line", () => {
    // Real hermes -Q output interleaves banner/log lines and a trailing
    // session_id: the decision line is not the first line of output.
    const raw = [
      "[hermes] starting chat",
      "Reasoning: the vendor is known and the cap is within policy.",
      "session_id: 6b7aed7c-2f1a-4d3e-9a1b-0c2d3e4f5a6b",
      "APPROVE: cap $1000 over 7 days is proportionate for freight",
    ].join("\n");
    expect(extractDecision(raw)).toEqual({
      decision: "APPROVE: cap $1000 over 7 days is proportionate for freight",
      approved: true,
    });
  });

  it("falls back to a sentinel when no decision line is present", () => {
    expect(extractDecision("hmm, I am not sure").decision).toBe("(no explicit decision line)");
    expect(extractDecision("hmm, I am not sure").approved).toBe(false);
  });
});

describe("extractReasoning", () => {
  it("trims hermes log noise and drops the session_id tail", () => {
    const raw = [
      "[hermes] boot",
      "Reasoning: cap is within policy.",
      "session_id: abc-123",
    ].join("\n");
    const reasoning = extractReasoning(raw);
    expect(reasoning).toContain("cap is within policy");
    expect(reasoning).not.toContain("session_id");
    expect(reasoning).not.toContain("[hermes]");
  });
});

describe("handshakeAgentRunner.runDecision", () => {
  it("writes the role AGENTS.md and returns the parsed decision (APPROVE)", async () => {
    const { runner, execute, writes } = runnerWith(
      "Reasoning: within cap.\nsession_id: x\nAPPROVE: within cap and 7-day window",
    );
    const res = await runner.runDecision(INPUT);

    expect(res.approved).toBe(true);
    expect(res.decision).toBe("APPROVE: within cap and 7-day window");
    expect(res.reasoning).toContain("within cap");
    expect(res.raw).toContain("APPROVE");

    // AGENTS.md written into the run cwd
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/tmp/hermes-atlas-run/AGENTS.md");
    expect(writes[0].content).toBe("You are Atlas.");

    // adapter invoked with the injected profile command + demo adapter config
    expect(execute).toHaveBeenCalledTimes(1);
    const ctx = (execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.agent.adapterType).toBe("hermes_local");
    expect(ctx.agent.adapterConfig.hermesCommand).toBe("/bin/agentdash-fake");
    expect(ctx.agent.adapterConfig.maxTurnsPerRun).toBe(2);
    expect(ctx.agent.adapterConfig.promptTemplate).toBe(INPUT.task);
  });

  it("returns approved=false when the agent DECLINEs", async () => {
    const { runner } = runnerWith("DECLINE: this vendor is not yet vetted");
    const res = await runner.runDecision(INPUT);
    expect(res.approved).toBe(false);
    expect(res.decision).toBe("DECLINE: this vendor is not yet vetted");
  });

  it("falls back to the default hermes command when provisioning fails", async () => {
    const execute = fakeExecute("APPROVE: ok");
    const runner = handshakeAgentRunner({
      execute,
      ensureCommand: async () => undefined, // provisioning unavailable
      defaultHermesCommand: "hermes",
      mkdtemp: (p) => `/tmp/${p}run`,
      writeFile: () => {},
    });
    await runner.runDecision(INPUT);
    const ctx = (execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.agent.adapterConfig.hermesCommand).toBe("hermes");
  });
});
