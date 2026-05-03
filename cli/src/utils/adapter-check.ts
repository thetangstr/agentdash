// AgentDash: lightweight adapter probe used by `agentdash setup`.
// Three layers, fastest first:
//   1. Binary check    — `<command> --version` exits 0?    (~1s)
//   2. Env-hint check  — does the shell have an API key for this adapter?
//      (no probe, just `process.env.<KEY>`; ~0s)
//   3. End-to-end hello probe — actually call the model and look for the
//      word "hello" in the response (opt-in via setup wizard; ~30s).
//
// We deliberately do NOT import server-side adapter packages (claude-local,
// codex-local, …) — those pull in adapter-utils + plugin-sdk and balloon
// the cli bundle. The wizard's job is to give the user fast confidence,
// not to replicate the full adapter test suite.
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
  /** Env vars the adapter typically reads (priority order — the first
   *  one that's set is enough). Empty array → no env-based auth (e.g.
   *  Cursor signs in via the desktop app, Hermes uses its own config).
   *  Undefined → we don't know; skip the env hint. */
  envHints?: string[];
  /** Optional end-to-end "hello" probe. Spawns the binary with these
   *  args, optionally pipes stdin, and looks for `expectInOutput` in
   *  stdout. Treat success as "the adapter can actually talk to the
   *  model right now". */
  probe?: AdapterProbeSpec;
}

export interface AdapterProbeSpec {
  args: string[];
  /** Stdin to pipe — needed for adapters like claude that read prompts
   *  from stdin in `--print -` mode. */
  stdin?: string;
  /** Case-insensitive substring we expect in stdout when the model
   *  responds. Defaults to "hello" — every probe asks the model to
   *  reply with that word. */
  expectInOutput?: string;
  /** Hard timeout. Defaults to 45s (matches the in-server test.ts). */
  timeoutMs?: number;
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

export interface AdapterEnvHintResult {
  /** "ok"      — at least one env hint is set OR no envHints declared.
   *  "missing" — envHints declared but none of them are set.
   *  "skipped" — envHints undefined (we don't know what to look for). */
  status: "ok" | "missing" | "skipped";
  /** Which env var was found set, when status="ok" with hints. */
  found?: string;
  /** All hints, joined with " or " — for the missing-hint copy. */
  expected?: string;
}

export interface AdapterProbeResult {
  /** "passed"      — exit 0 AND `expectInOutput` substring present.
   *  "unexpected"  — exit 0 but expected substring not in output.
   *  "auth"        — output suggests the binary needs login (we look for
   *                  common phrases like "log in", "authenticate"). The
   *                  user may need to run `claude login` first.
   *  "errored"     — non-zero exit code; details captured.
   *  "timed_out"   — the probe blew the timeout. */
  status: "passed" | "unexpected" | "auth" | "errored" | "timed_out";
  detail?: string;
  durationMs: number;
}

export const ADAPTER_CHECKS: AdapterCheckSpec[] = [
  {
    type: "claude_local",
    label: "Claude Code (local)",
    command: "claude",
    versionArg: "--version",
    install: "npm install -g @anthropic-ai/claude-code",
    envHints: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    // Mirrors the in-server probe at packages/adapters/claude-local/src/server/test.ts:191.
    // We strip --output-format stream-json so we get plain text we can grep
    // for "hello" without parsing the streaming envelope.
    probe: {
      args: ["--print", "-", "--dangerously-skip-permissions"],
      stdin: "Reply with just the word hello.",
      expectInOutput: "hello",
      timeoutMs: 45_000,
    },
  },
  {
    type: "codex_local",
    label: "Codex (local)",
    command: "codex",
    versionArg: "--version",
    install: "npm install -g @openai/codex",
    envHints: ["OPENAI_API_KEY"],
    // No probe yet — codex's non-interactive mode hasn't been verified
    // against the wizard. Add when we confirm the flag set.
  },
  {
    type: "hermes_local",
    label: "Hermes Agent (local)",
    command: "hermes",
    versionArg: "--version",
    install: "pip install hermes-agent  (then run `hermes setup`)",
    envHints: [], // Hermes manages its own credentials via `hermes setup`.
  },
  {
    type: "cursor",
    label: "Cursor (local)",
    command: "cursor",
    versionArg: "--version",
    install: "Install the Cursor desktop app from https://cursor.sh and ensure `cursor` is on PATH (Cursor → 'Install cursor command' from the Command Palette)",
    envHints: [], // Cursor signs in via the desktop app.
  },
  {
    type: "gemini_local",
    label: "Gemini (local)",
    command: "gemini",
    versionArg: "--version",
    install: "Install Gemini CLI per Google's docs and ensure it's on PATH",
    envHints: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  {
    type: "opencode_local",
    label: "OpenCode (local)",
    command: "opencode",
    versionArg: "--version",
    install: "Install OpenCode from https://opencode.ai",
    envHints: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  },
  {
    type: "pi_local",
    label: "Pi (local)",
    command: "pi",
    versionArg: "--version",
    install: "Install Pi CLI per its docs and ensure it's on PATH",
  },
  {
    type: "acpx_local",
    label: "ACPX (local)",
    command: "acpx",
    versionArg: "--version",
    install: "Install the ACPX CLI per its docs",
    envHints: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  },
  { type: "openclaw_gateway", label: "OpenClaw (gateway)", manual: true, install: "Configure the gateway URL when you hire your first agent in the dashboard." },
  { type: "process", label: "Generic process adapter", manual: true, install: "Configure the process command when you hire your first agent." },
  { type: "http", label: "Generic HTTP adapter", manual: true, install: "Configure the HTTP endpoint when you hire your first agent." },
];

const VERSION_PROBE_TIMEOUT_MS = 4000;

export function checkAdapterBinary(spec: AdapterCheckSpec): AdapterCheckResult {
  if (spec.manual || !spec.command) {
    return { status: "manual", ok: true, detail: spec.install };
  }
  const probe = spawnSync(spec.command, [spec.versionArg ?? "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: VERSION_PROBE_TIMEOUT_MS,
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

/**
 * Check whether the user's shell has an API key the adapter can use.
 * Pure read — no spawn, no network. Returns "ok" if any of `envHints`
 * is set to a non-empty string, "missing" if all hints are unset, and
 * "skipped" when the adapter declares no hints (e.g. Cursor / Hermes).
 */
export function checkAdapterEnvHints(spec: AdapterCheckSpec): AdapterEnvHintResult {
  if (!spec.envHints) return { status: "skipped" };
  if (spec.envHints.length === 0) return { status: "skipped" };
  for (const key of spec.envHints) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return { status: "ok", found: key };
    }
  }
  return {
    status: "missing",
    expected: spec.envHints.join(" or "),
  };
}

const AUTH_HINT_RE = /\b(log in|sign in|authenticate|unauthorized|api key|credentials?)\b/i;

/**
 * Run the adapter's hello probe. Spawns the configured binary with the
 * probe's args + stdin, watches for the expected substring in stdout,
 * and tries to detect auth-related failures so we can suggest
 * `<adapter> login` rather than just printing the raw stderr.
 */
export function probeAdapter(spec: AdapterCheckSpec): AdapterProbeResult {
  if (!spec.probe || !spec.command) {
    return { status: "errored", detail: "no probe configured", durationMs: 0 };
  }
  const expect = (spec.probe.expectInOutput ?? "hello").toLowerCase();
  const timeoutMs = spec.probe.timeoutMs ?? 45_000;

  const start = Date.now();
  const result = spawnSync(spec.command, spec.probe.args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    input: spec.probe.stdin ?? "",
  });
  const durationMs = Date.now() - start;

  // Node sets `signal` to "SIGTERM" when killed by timeout (or by the
  // platform's default signal). Use that AND the elapsed time to detect.
  if (result.signal && durationMs >= timeoutMs - 500) {
    return { status: "timed_out", detail: `exceeded ${timeoutMs}ms`, durationMs };
  }

  const stdout = (result.stdout ?? "").toString();
  const stderr = (result.stderr ?? "").toString();
  const combined = `${stdout}\n${stderr}`;

  if ((result.status ?? 1) !== 0) {
    if (AUTH_HINT_RE.test(combined)) {
      return {
        status: "auth",
        detail: firstNonEmptyLine(combined) || "binary suggests login is required",
        durationMs,
      };
    }
    return {
      status: "errored",
      detail: firstNonEmptyLine(stderr || stdout) || `exited ${result.status ?? "?"}`,
      durationMs,
    };
  }

  if (stdout.toLowerCase().includes(expect)) {
    return { status: "passed", detail: firstNonEmptyLine(stdout), durationMs };
  }
  return {
    status: "unexpected",
    detail: `did not see "${expect}" in response — ${firstNonEmptyLine(stdout) || "empty output"}`,
    durationMs,
  };
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  ).slice(0, 240);
}

export function findAdapterCheck(type: string): AdapterCheckSpec | null {
  return ADAPTER_CHECKS.find((spec) => spec.type === type) ?? null;
}
