// AgentDash: Hermes harness-preflight round-trip probe.
//
// The packaged Hermes testEnvironment only does STATIC checks (binary present,
// Python version, whether a key exists). A Hermes that is installed but crashes
// at runtime still reports pass/warn. This probe runs a REAL one-shot completion
// (`hermes chat -q <arithmetic> --max-turns 1`) whose answer is not in the prompt,
// so harness-preflight actually catches a broken adapter. Opt-in (it spawns a
// real process): gated by AGENTDASH_HERMES_ROUNDTRIP_PROBE at the call site.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);

// Arithmetic whose answer (42) is NOT present in the prompt text.
const PROBE_QUERY = "Reply with ONLY the number, nothing else: what is 17 plus 25?";
const EXPECTED_ANSWER = "42";

export interface RoundTripProbeInput {
  command: string;
  model?: string;
  provider?: string;
  timeoutMs?: number;
  /** injectable for tests */
  run?: (cmd: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<{ stdout: string }>;
}

export async function hermesRoundTripProbeCheck(input: RoundTripProbeInput): Promise<AdapterEnvironmentCheck> {
  const run = input.run ?? ((cmd, args, opts) => execFileAsync(cmd, args, opts).then((r) => ({ stdout: r.stdout })));
  const args = ["chat", "-q", PROBE_QUERY, "--max-turns", "1"];
  if (input.model) args.push("-m", input.model);
  if (input.provider) args.push("--provider", input.provider);

  try {
    const { stdout } = await run(input.command, args, { cwd: os.tmpdir(), timeout: input.timeoutMs ?? 90_000 });
    if (stdout.includes(EXPECTED_ANSWER)) {
      return {
        code: "hermes_roundtrip_ok",
        level: "info",
        message: "Hermes completed a live round-trip (one-shot completion succeeded).",
      };
    }
    return {
      code: "hermes_roundtrip_no_answer",
      level: "error",
      message: "Hermes ran but did not return the expected answer — the provider/model is likely misconfigured.",
      detail: stdout.slice(0, 200),
    };
  } catch (err) {
    const e = err as { code?: string; killed?: boolean; message?: string };
    const reason = e.killed
      ? "timed out"
      : e.code === "ENOENT"
        ? "hermes command not found"
        : (e.message ?? String(err));
    return {
      code: "hermes_roundtrip_failed",
      level: "error",
      message: `Hermes round-trip probe failed: ${reason}`,
    };
  }
}
