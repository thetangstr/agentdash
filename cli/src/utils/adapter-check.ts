// AgentDash: lightweight adapter-binary probe used by `agentdash setup`.
// Doesn't import server-side adapter packages; just checks that the
// underlying CLI binary is reachable on PATH so we can give the user a
// clear "install this" message before they hire their first agent.
import { spawnSync } from "node:child_process";

export interface AdapterCheckSpec {
  type: string;
  label: string;
  /** Binary to probe with `<command> <versionArg>`. */
  command?: string;
  versionArg?: string;
  /** Shown when the probe fails. */
  install?: string;
  /** When true, the probe always reports "configured later" — used for
   *  generic transports (process / http / openclaw_gateway) where the
   *  binary check doesn't apply. */
  manual?: boolean;
}

export interface AdapterCheckResult {
  ok: boolean;
  /** "configured" — binary detected and runs `--version`.
   *  "missing"    — binary not on PATH.
   *  "errored"    — binary on PATH but exits non-zero.
   *  "manual"     — adapter is configured later (gateway URL, custom command). */
  status: "configured" | "missing" | "errored" | "manual";
  detail?: string;
  fix?: string;
}

export const ADAPTER_CHECKS: AdapterCheckSpec[] = [
  { type: "claude_local", label: "Claude Code (local)", command: "claude", versionArg: "--version", install: "npm install -g @anthropic-ai/claude-code" },
  { type: "codex_local", label: "Codex (local)", command: "codex", versionArg: "--version", install: "npm install -g @openai/codex" },
  { type: "hermes_local", label: "Hermes Agent (local)", command: "hermes", versionArg: "--version", install: "pip install hermes-agent  (then run `hermes setup`)" },
  { type: "cursor", label: "Cursor (local)", command: "cursor", versionArg: "--version", install: "Install the Cursor desktop app from https://cursor.sh and ensure `cursor` is on PATH (Cursor → 'Install cursor command' from the Command Palette)" },
  { type: "gemini_local", label: "Gemini (local)", command: "gemini", versionArg: "--version", install: "Install Gemini CLI per Google's docs and ensure it's on PATH" },
  { type: "opencode_local", label: "OpenCode (local)", command: "opencode", versionArg: "--version", install: "Install OpenCode from https://opencode.ai" },
  { type: "pi_local", label: "Pi (local)", command: "pi", versionArg: "--version", install: "Install Pi CLI per its docs and ensure it's on PATH" },
  { type: "acpx_local", label: "ACPX (local)", command: "acpx", versionArg: "--version", install: "Install the ACPX CLI per its docs" },
  { type: "openclaw_gateway", label: "OpenClaw (gateway)", manual: true, install: "Configure the gateway URL when you hire your first agent in the dashboard." },
  { type: "process", label: "Generic process adapter", manual: true, install: "Configure the process command when you hire your first agent." },
  { type: "http", label: "Generic HTTP adapter", manual: true, install: "Configure the HTTP endpoint when you hire your first agent." },
];

const PROBE_TIMEOUT_MS = 4000;

export function checkAdapterBinary(spec: AdapterCheckSpec): AdapterCheckResult {
  if (spec.manual || !spec.command) {
    return { status: "manual", ok: true, detail: spec.install };
  }
  const probe = spawnSync(spec.command, [spec.versionArg ?? "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROBE_TIMEOUT_MS,
  });
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      status: "missing",
      ok: false,
      detail: `\`${spec.command}\` not found on PATH`,
      fix: spec.install,
    };
  }
  if (probe.status !== 0) {
    const stderr = (probe.stderr ?? "").trim().split("\n")[0] ?? "";
    return {
      status: "errored",
      ok: false,
      detail: `\`${spec.command} ${spec.versionArg ?? "--version"}\` exited ${probe.status ?? "?"}${stderr ? ` — ${stderr}` : ""}`,
      fix: spec.install,
    };
  }
  const version = (probe.stdout ?? "").trim().split("\n")[0] ?? "";
  return { status: "configured", ok: true, detail: version || "ok" };
}

export function findAdapterCheck(type: string): AdapterCheckSpec | null {
  return ADAPTER_CHECKS.find((spec) => spec.type === type) ?? null;
}
