// AgentDash: read only this session's usage on its operator-pinned SSH target.
// No server-home lookup, credentials, provider calls, or local ledger fallback.
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { buildSshSpawnTarget, runSshCommand } from "@paperclipai/adapter-utils/ssh";
import { hermesProfileFromArgv } from "./hermes-profile-args.js";
import { summarizeHermesUsageRows, type HermesSessionUsageRead, type HermesUsageRow } from "./hermes-usage.js";

const MAX_OUTPUT = 128 * 1024;
// Python's standard-library SQLite is available with Hermes. An absent Python
// or a nonstandard launcher leaves spend unknown; never run a compatibility probe.
const READ_USAGE = String.raw`
# AGENTDASH_HERMES_USAGE_READ
import base64, json, os, pathlib, re, shutil, sqlite3, sys
p = json.loads(base64.b64decode(sys.argv[1]))
session = p["sessionId"]
result = {"sessionId": session, "status": "unmetered_no_ledger"}
try:
    for key, value in p["env"].items():
        os.environ[key] = value
    command = shutil.which(p["command"])
    if not command:
        raise ValueError("unknown launcher")
    with pathlib.Path(command).open() as launcher:
        text = launcher.read(16385)
    # Only the ordinary Python console entry point is attributable. A wrapper
    # can change HOME/profile/PATH arbitrarily; do not guess its ledger.
    if len(text) > 16384 or not re.match(r"^#![^\n]*python", text):
        raise ValueError("unknown launcher")
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    allowed = [r"import (sys|re)", r"from hermes_cli.main import main", r"if __name__ == ['\"]__main__['\"]:", r"sys\.exit\(main\(\)\)", r"main\(\)"]
    argv_cleanup = {
        "if sys.argv[0].endswith('-script.pyw'):",
        "elif sys.argv[0].endswith('.exe'):",
        "sys.argv[0] = sys.argv[0][:-11]",
        "sys.argv[0] = sys.argv[0][:-4]",
        "sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])",
    }
    if "from hermes_cli.main import main" not in lines or any(line not in argv_cleanup and not any(re.fullmatch(pattern, line) for pattern in allowed) for line in lines):
        raise ValueError("unknown launcher")
    native = pathlib.Path(os.environ["HOME"]) / ".hermes"
    raw_home = os.environ.get("HERMES_HOME")
    home = pathlib.Path(raw_home).expanduser().resolve() if raw_home else native
    root = home.parent.parent if home.parent.name == "profiles" else home
    profile = p["profile"]
    if profile:
        home = root if profile == "default" else root / "profiles" / profile
    elif home.parent.name != "profiles":
        # A sticky profile may have changed since launch. Without an explicit
        # profile/home, attribution cannot be established; report unknown.
        active_root = native if home == native or native in home.parents else root
        active = active_root / "active_profile"
        if active.exists() and active.open().read(128).strip() not in ("", "default"):
            raise ValueError("unattributed active profile")
    dbpath = home / "state.db"
    db = sqlite3.connect(dbpath.as_uri() + "?mode=ro", uri=True, timeout=1)
    db.execute("PRAGMA query_only = ON")
    db.row_factory = sqlite3.Row
    columns = "model,billing_provider,api_call_count,input_tokens,output_tokens,cache_read_tokens,estimated_cost_usd,actual_cost_usd"
    rows = [dict(row) for row in db.execute("SELECT " + columns + " FROM session_model_usage WHERE session_id = ? LIMIT 257", (session,))]
    if len(rows) > 256:
        raise ValueError("too many usage rows")
    tools = None
    try:
        row = db.execute("SELECT tool_call_count FROM sessions WHERE id = ?", (session,)).fetchone()
        tools = row[0] if row else None
    except sqlite3.Error:
        pass
    db.close()
    result.update(status="metered" if rows else "unmetered_no_session", dbPath=str(dbpath), profile=profile, rows=rows, toolCalls=tools)
except Exception:
    pass
out = json.dumps(result, allow_nan=False, separators=(",", ":"))
print(out if len(out.encode()) <= 131072 else json.dumps({"sessionId": session, "status": "unmetered_no_ledger"}))
`;

const empty = (status: HermesSessionUsageRead["status"]): HermesSessionUsageRead => ({ usage: null, status, dbPath: null, ledger: null });
const numericFields = ["api_call_count", "input_tokens", "output_tokens", "cache_read_tokens", "estimated_cost_usd", "actual_cost_usd"] as const;

export async function readRemoteHermesSessionUsage(
  sessionId: string | null | undefined,
  target: AdapterSshExecutionTarget,
  adapterConfig: Record<string, unknown>,
): Promise<HermesSessionUsageRead> {
  if (!sessionId?.trim()) return empty("unmetered_no_session");
  if (sessionId.length > 4096) return empty("unmetered_no_ledger");
  const configEnv = adapterConfig.env && typeof adapterConfig.env === "object" ? adapterConfig.env as Record<string, unknown> : {};
  // Only location inputs, never run tokens or provider credentials. They are
  // data for the reader, and use the same login-shell context as the launch.
  const env: Record<string, string> = {};
  for (const key of ["HOME", "HERMES_HOME", "PATH"]) {
    if (typeof configEnv[key] === "string") env[key] = configEnv[key];
  }
  const command = typeof adapterConfig.hermesCommand === "string" ? adapterConfig.hermesCommand : "hermes";
  const profile = hermesProfileFromArgv(adapterConfig.extraArgs);
  const payload = Buffer.from(JSON.stringify({ sessionId, command, profile, env })).toString("base64");
  try {
    const invocation = await buildSshSpawnTarget({ spec: target.spec, command: "python3", args: ["-c", READ_USAGE, payload], env: {} });
    let stdout: string;
    try {
      ({ stdout } = await runSshCommand(target.spec, invocation.args.at(-1)!, { timeoutMs: 10_000, maxBuffer: MAX_OUTPUT }));
    } finally {
      await invocation.cleanup();
    }
    if (Buffer.byteLength(stdout) > MAX_OUTPUT) return empty("unmetered_no_ledger");
    const data = JSON.parse(stdout);
    if (!data || data.sessionId !== sessionId) return empty("unmetered_no_ledger");
    if (data.status === "unmetered_no_ledger") return empty("unmetered_no_ledger");
    if (!["metered", "unmetered_no_session"].includes(data.status) || typeof data.dbPath !== "string" || !data.dbPath.startsWith("/") || data.dbPath.length > 4096 || !Array.isArray(data.rows) || data.rows.length > 256) return empty("unmetered_no_ledger");
    for (const row of data.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return empty("unmetered_no_ledger");
      for (const field of numericFields) {
        if (row[field] !== null && (typeof row[field] !== "number" || !Number.isFinite(row[field]) || row[field] < 0)) return empty("unmetered_no_ledger");
      }
      for (const field of ["model", "billing_provider"]) {
        if (row[field] !== null && (typeof row[field] !== "string" || row[field].length > 512)) return empty("unmetered_no_ledger");
      }
    }
    if (data.toolCalls !== null && data.toolCalls !== undefined && (!Number.isSafeInteger(data.toolCalls) || data.toolCalls < 0)) return empty("unmetered_no_ledger");
    if (data.profile !== null && data.profile !== profile) return empty("unmetered_no_ledger");
    if (data.status === "unmetered_no_session" && data.rows.length > 0) return empty("unmetered_no_ledger");
    const usage = summarizeHermesUsageRows(data.rows as HermesUsageRow[]);
    if (usage && [usage.usage.inputTokens, usage.usage.outputTokens, usage.usage.cachedInputTokens ?? 0, usage.apiCalls, usage.costUsd ?? 0].some(value => !Number.isFinite(value))) return empty("unmetered_no_ledger");
    if (usage) usage.toolCalls = data.toolCalls ?? null;
    return {
      usage, status: usage ? "metered" : "unmetered_no_session", dbPath: data.dbPath,
      ledger: { path: data.dbPath, source: "remote_session_ledger", certainty: "certain", profile: data.profile ?? null },
    };
  } catch {
    return empty("unmetered_no_ledger");
  }
}
