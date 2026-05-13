// AgentDash: frictionless first-run wizard. Closes GH #94 + the cleanup
// the user asked for after #96 ("we need a frictionless way for user to
// get started").
//
// The default `agentdash setup` flow is one step:
//
//   1. Pick an adapter — verify its binary is on PATH, env hints,
//      optional hello probe; if missing, print the install command.
//
// The founding user's email used to be a second prompt here. We dropped
// it — the email/password are collected by Better Auth's sign-up screen
// when the user lands on the dashboard. That keeps personal info out of
// the CLI and gives us a real auth account from the start.
//
// Everything else uses safe defaults — embedded Postgres, local-disk
// storage, local-encrypted secrets, info logging. Bind mode auto-detects
// Tailscale: if Tailscale is running on the host we pick `tailnet`
// (which forces authenticated mode); otherwise we fall back to
// `loopback` (local_trusted, no auth, single user).
//
// Subcommands kept for re-running a single step later:
//   setup server     — switch bind mode (loopback / lan / tailnet)
//   setup bootstrap  — re-issue the CEO invite for authenticated mode
//   setup adapter    — pick + verify a different adapter
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  AGENT_ADAPTER_TYPES,
  inferBindModeFromHost,
  type AgentAdapterType,
  type BindMode,
} from "@paperclipai/shared";
import { SKILL_MD_FULL } from "@paperclipai/shared/deep-interview-skill";
import { configExists, readConfig, resolveConfigPath, writeConfig } from "../config/store.js";
import { buildPresetServerConfig, detectTailnetBindHost, detectLanBindHost } from "../config/server-bind.js";
import { bootstrapCeoInvite } from "./auth-bootstrap-ceo.js";
import { mergePaperclipEnvEntries, resolvePaperclipEnvFile, ensureAgentJwtSecret } from "../config/env.js";
import { openUrlInBrowser } from "../utils/open-url.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import {
  ADAPTER_CHECKS,
  checkAdapterBinary,
  checkAdapterEnvHints,
  findAdapterCheck,
  probeAdapter,
  type AdapterCheckSpec,
} from "../utils/adapter-check.js";
import { defaultStorageConfig } from "../prompts/storage.js";
import { defaultSecretsConfig } from "../prompts/secrets.js";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";
import type { PaperclipConfig } from "../config/schema.js";

interface CommonOpts {
  config?: string;
  yes?: boolean;
}

interface ServerOpts extends CommonOpts {
  bind?: BindMode;
  port?: number;
}

interface BootstrapOpts extends CommonOpts {
  open?: boolean;
  force?: boolean;
  expiresHours?: number;
  baseUrl?: string;
}

interface AdapterOpts extends CommonOpts {
  type?: string;
}

interface SetupAllOpts extends CommonOpts {
  /** @deprecated kept for back-compat with old `agentdash setup --email`
   *  invocations; the wizard no longer collects an email — sign-up
   *  happens in the Better Auth flow on the dashboard. */
  email?: string;
  adapter?: string;
}

// ---------- safe-defaults config builder ----------

/**
 * Build a minimal, valid PaperclipConfig from scratch — used when the user
 * runs `agentdash setup` on a fresh machine with no prior config. Mirrors
 * what `agentdash onboard` produces in quickstart-loopback mode but skips
 * every prompt.
 */
function buildDefaultConfig(preferredBind?: "loopback" | "lan" | "tailnet"): PaperclipConfig {
  const instanceId = resolvePaperclipInstanceId();
  // Auto-detect Tailscale at config-write time. If Tailscale is running
  // we want the install to "just work" over the tailnet hostname out of
  // the box (auth-protected, MagicDNS-friendly). If not, fall back to
  // loopback (single-user local_trusted, no auth UI). Either way the
  // runtime fallback in server/src/config.ts (PR #116) safely degrades
  // tailnet → loopback if Tailscale stops running between sessions.
  const tailnetHost = detectTailnetBindHost();
  const lanHost = detectLanBindHost();

  // Determine bind mode: tailnet > lan > loopback (in priority order)
  // unless user explicitly chose one via preferredBind.
  let bind: "loopback" | "lan" | "tailnet";
  if (preferredBind) {
    bind = preferredBind;
  } else if (tailnetHost) {
    bind = "tailnet";
  } else if (lanHost) {
    // No Tailscale, but there is a LAN address — use loopback by default
    // for safety (local_trusted mode). User can re-run `agentdash setup server`
    // to switch to lan if they want network access.
    bind = "loopback";
  } else {
    bind = "loopback";
  }

  const allowedHostnames = ["localhost", "127.0.0.1"];
  if (tailnetHost) allowedHostnames.push(tailnetHost);
  if (lanHost) allowedHostnames.push(lanHost);
  const { server, auth } = buildPresetServerConfig(bind, {
    port: 3100,
    allowedHostnames,
    serveUi: true,
  });
  return {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "onboard",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: resolveDefaultEmbeddedPostgresDir(instanceId),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 7,
        dir: resolveDefaultBackupDir(instanceId),
      },
    },
    logging: {
      mode: "file",
      logDir: resolveDefaultLogsDir(instanceId),
    },
    server,
    telemetry: { enabled: true },
    auth,
    storage: defaultStorageConfig(),
    secrets: defaultSecretsConfig(),
  };
}

// ---------- step 1: pick + verify adapter ----------

interface AdapterPickResult {
  type: AgentAdapterType;
  ok: boolean;
  detail?: string;
  fix?: string;
}

async function pickAndVerifyAdapter(opts: { yes?: boolean; preselected?: string }): Promise<AdapterPickResult | null> {
  let selected: AgentAdapterType;

  if (opts.preselected) {
    if (!AGENT_ADAPTER_TYPES.includes(opts.preselected as (typeof AGENT_ADAPTER_TYPES)[number])) {
      p.log.error(`Unknown adapter type ${pc.cyan(opts.preselected)}. Known: ${AGENT_ADAPTER_TYPES.join(", ")}`);
      return null;
    }
    selected = opts.preselected as AgentAdapterType;
    p.log.info(`Adapter: ${pc.cyan(selected)}`);
  } else if (opts.yes) {
    // Default to claude_local in non-interactive mode — it's the most common
    // first-time pick. The user can change later in the dashboard.
    selected = "claude_local";
    p.log.info(`Adapter: ${pc.cyan(selected)} (default in --yes mode)`);
  } else {
    const picked = await p.select({
      message: "Pick the adapter for your first agent:",
      options: ADAPTER_CHECKS.map((spec) => ({
        value: spec.type,
        label: spec.label,
        hint: spec.command ? pc.dim(`runs \`${spec.command}\``) : pc.dim("configured later"),
      })),
      initialValue: "claude_local",
    });
    if (p.isCancel(picked)) {
      p.cancel("Setup cancelled.");
      return null;
    }
    selected = picked as AgentAdapterType;
  }

  const spec = findAdapterCheck(selected);
  if (!spec) {
    return { type: selected, ok: true };
  }

  const result = checkAdapterBinary(spec);
  switch (result.status) {
    case "configured": {
      p.log.success(`${spec.label} ready  ${pc.dim(`(${result.detail})`)}`);
      // Binary works — now check env auth and optionally run a hello probe.
      // Both paths print their own inline warnings if anything's off; we
      // deliberately do NOT propagate env-hint or probe failures into
      // `ok`, because the existing outro copy ("X isn't installed yet")
      // is specifically about a missing binary. Auth/probe issues get
      // their own targeted hints at the moment they happen.
      await runPostBinaryChecks(spec, { yes: opts.yes });
      return { type: selected, ok: true, detail: result.detail };
    }
    case "manual":
      p.log.info(`${spec.label} — ${pc.dim(result.detail ?? "configure when you hire your first agent")}`);
      return { type: selected, ok: true, detail: result.detail };
    case "missing":
    case "errored":
      p.log.warn(`${spec.label} not ready: ${result.detail}`);
      if (result.fix) {
        p.log.message(`  ${pc.cyan("Fix:")} ${result.fix}`);
      }
      p.log.message(pc.dim("  You can keep going and install it later — agents using this adapter will fail to run until then."));
      return { type: selected, ok: false, detail: result.detail, fix: result.fix };
  }
}

/**
 * After the version probe passes, do the deeper checks:
 *   1. Read env hints (no spawn) — warn if no API key is set in the shell.
 *   2. If a hello probe is configured and we're interactive, offer to
 *      run it. The probe actually calls the model and is the strongest
 *      signal that the adapter is wired up correctly. Default = no,
 *      since 30-45s of "did this thing hang?" can scare a non-tech
 *      first-run user; we surface it as a clear opt-in instead of an
 *      automatic step.
 *
 * Returns void: every step prints its own inline warning, so there's
 * nothing to bubble up. The wizard's outro caveat ("X isn't installed
 * yet") is reserved for binary-level failures; auth/probe issues are
 * communicated where they happen.
 */
async function runPostBinaryChecks(spec: AdapterCheckSpec, opts: { yes?: boolean }): Promise<void> {
  // ---- env-hint check ----
  const envHint = checkAdapterEnvHints(spec);
  if (envHint.status === "ok" && envHint.found) {
    p.log.success(`${pc.cyan(envHint.found)} found in your shell — auth looks ready.`);
  } else if (envHint.status === "missing") {
    p.log.warn(`No ${envHint.expected} in your shell — model calls will fail until you set one.`);
    p.log.message(pc.dim(`  Fix once: ${pc.cyan(`export ${(spec.envHints?.[0] ?? "API_KEY")}=…`)} in your shell rc, then re-run \`agentdash setup\`.`));
  }
  // status === "skipped" → adapter handles its own auth (Cursor / Hermes / etc.); no print.

  // ---- optional hello probe ----
  if (!spec.probe || !spec.command) return;
  const interactive = !opts.yes && process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive) return;

  const runProbe = await p.confirm({
    message: `Run a quick test prompt against ${spec.label}? (~30s; calls the model with "say hello" to verify auth + network)`,
    initialValue: false,
  });
  if (p.isCancel(runProbe) || runProbe !== true) return;

  const spinner = p.spinner();
  spinner.start(`Asking ${spec.label} to say hello…`);
  const probe = probeAdapter(spec);
  switch (probe.status) {
    case "passed":
      spinner.stop(`${spec.label} responded ${pc.dim(`(${formatDuration(probe.durationMs)})`)} — wired up correctly.`);
      break;
    case "unexpected":
      spinner.stop(`${spec.label} responded but the reply didn't include "hello" ${pc.dim(`(${formatDuration(probe.durationMs)})`)}`);
      if (probe.detail) p.log.message(pc.dim(`  Got: ${probe.detail}`));
      break;
    case "auth":
      spinner.stop(`${spec.label} needs login — auth not configured.`);
      if (probe.detail) p.log.message(pc.dim(`  ${probe.detail}`));
      p.log.message(`  ${pc.cyan("Try:")} \`${spec.command} login\` (or set ${spec.envHints?.[0] ?? "the API key env var"})`);
      break;
    case "errored":
      spinner.stop(`${spec.label} probe failed ${pc.dim(`(${formatDuration(probe.durationMs)})`)}`);
      if (probe.detail) p.log.message(pc.dim(`  ${probe.detail}`));
      break;
    case "timed_out":
      spinner.stop(`${spec.label} probe timed out ${pc.dim(`(${formatDuration(probe.durationMs)})`)}`);
      p.log.message(pc.dim(`  Network or model is slow. The adapter may still work — try hiring an agent in the dashboard.`));
      break;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Map each adapter type to the per-adapter skills directory where the
// deep-interview SKILL.md should be installed.  Adapters with no skills
// directory concept are omitted (pi_local, http, openclaw_gateway, process).
const ADAPTER_SKILLS_DIRS: Record<string, string | undefined> = {
  claude_local: `${os.homedir()}/.claude/skills/deep-interview`,
  claude_api: `${os.homedir()}/.claude/skills/deep-interview`,
  hermes_local: `${os.homedir()}/.hermes/skills/deep-interview`,
  codex_local: `${process.env.CODEX_HOME ?? `${os.homedir()}/.codex`}/skills/deep-interview`,
  gemini_local: `${os.homedir()}/.gemini/skills/deep-interview`,
  opencode_local: `${os.homedir()}/.opencode/skills/deep-interview`,
  acpx_local: `${os.homedir()}/.acpx/skills/deep-interview`,
  cursor: `${os.homedir()}/.cursor/skills/deep-interview`,
};

/**
 * Installs the deep-interview SKILL.md from the bundled source
 * (`@paperclipai/shared/deep-interview-skill`) into the per-adapter skills
 * directory.  Idempotent — skips write if the file already contains the same
 * content.  Logs a clack-style success/warn message.
 */
async function installDeepInterviewSkill(adapterType: string): Promise<void> {
  const skillsDir = ADAPTER_SKILLS_DIRS[adapterType];
  if (!skillsDir) return; // adapter has no skills directory concept

  const destPath = path.join(skillsDir, "SKILL.md");
  const destDir = skillsDir;

  // Idempotent: skip if file already exists with identical content
  let existingContent: string | undefined;
  try {
    existingContent = await fs.promises.readFile(destPath, "utf-8");
  } catch {
    // File does not exist yet — we will create it
  }

  if (existingContent === SKILL_MD_FULL) {
    p.log.message(pc.dim(`  deep-interview SKILL.md already installed in ${destDir}`));
    return;
  }

  await fs.promises.mkdir(destDir, { recursive: true });
  await fs.promises.writeFile(destPath, SKILL_MD_FULL, "utf-8");
  p.log.success(`Installed deep-interview skill to ${pc.dim(destDir)}`);
}

// ---------- top-level orchestrator ----------

export async function setup(opts: SetupAllOpts): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.cyan("AgentDash setup"));

  const configPath = resolveConfigPath(opts.config);
  const hadConfig = configExists(configPath);

  // Detect available network interfaces for bind-mode decision
  const tailnetHost = detectTailnetBindHost();
  const lanHost = detectLanBindHost();
  const hasLan = !!lanHost;

  let preferredBind: "loopback" | "lan" | "tailnet" | undefined;
  if (!hadConfig && !opts.yes && hasLan && !tailnetHost) {
    // Non-Tailscale machine with a LAN interface — ask the user if they want
    // network access (lan) or local-only (loopback).
    const picked = await p.select({
      message: "How should the server be accessible?",
      options: [
        {
          value: "loopback",
          label: "Local only",
          hint: pc.dim("Only accessible from this machine (127.0.0.1)"),
        },
        {
          value: "lan",
          label: "Network",
          hint: pc.dim(`Accessible from other machines on your LAN (${lanHost})`),
        },
      ],
      initialValue: "loopback",
    });
    if (p.isCancel(picked)) {
      p.cancel("Setup cancelled.");
      return;
    }
    preferredBind = picked as "loopback" | "lan";
  }

  if (!hadConfig) {
    const fresh = buildDefaultConfig(preferredBind);
    writeConfig(fresh, configPath);
    const bindLabel =
      fresh.server.bind === "tailnet"
        ? `tailnet (${fresh.server.host})`
        : fresh.server.bind === "lan"
          ? `lan (${fresh.server.host})`
          : "loopback (127.0.0.1)";
    p.log.info(`Wrote a fresh config at ${pc.dim(configPath)} — bind=${pc.cyan(bindLabel)}, embedded Postgres, local storage.`);
  }

  // Step 1 — adapter (binary check, env-hint check, optional hello probe).
  const adapter = await pickAndVerifyAdapter({ yes: opts.yes, preselected: opts.adapter });
  if (!adapter) return;

  // Back-compat: if --email was passed, save it as a hint for local_trusted
  // mode bootstrap. We no longer prompt for it.
  const envPath = resolvePaperclipEnvFile(opts.config);
  const envEntries: Record<string, string> = { AGENTDASH_DEFAULT_ADAPTER: adapter.type };
  if (opts.email) envEntries.AGENTDASH_BOOTSTRAP_EMAIL = opts.email;
  mergePaperclipEnvEntries(envEntries, envPath);
  ensureAgentJwtSecret(opts.config);
  p.log.success(`Saved adapter preference to ${pc.dim(envPath)}`);

  // Install deep-interview SKILL.md into the per-adapter skills directory.
  await installDeepInterviewSkill(adapter.type);

  // Surface adapter caveats inside the @clack box so they aren't drowned
  // out by a 30-line dev-server boot log if the user accepts the start
  // prompt below.
  if (!adapter.ok) {
    p.log.warn(`${adapter.type} isn't installed yet — agents using it will fail until you fix it.`);
    if (adapter.fix) p.log.message(`${pc.cyan("Fix:")} ${adapter.fix}`);
  }

  // Offer to start the server right now so the user lands in CoS chat
  // without needing to remember `pnpm dev`. Skip in --yes mode (CI) and
  // when stdin/stdout aren't a TTY (curl|bash piped, no way to confirm).
  // Skip too if we can't find a workspace root — we don't want to spawn
  // pnpm dev from a published-package install where no workspace exists
  // on disk.
  const workspaceRoot = findWorkspaceRoot();
  const canStartDev = workspaceRoot !== null;
  const interactive = !opts.yes && process.stdin.isTTY && process.stdout.isTTY;

  const cosUrl = resolveCosUrl(opts.config);

  if (canStartDev && interactive) {
    const startNow = await p.confirm({
      message: `Start setting up the agents now? (this runs \`pnpm dev\` and opens your Chief of Staff at ${cosUrl})`,
      initialValue: true,
    });
    if (!p.isCancel(startNow) && startNow === true) {
      p.outro(pc.green(`Starting AgentDash — your browser will open at ${cosUrl} when the server is ready. Ctrl-C to stop.`));
      // Fire-and-forget: poll /api/health until the server is up, then
      // openUrlInBrowser. We deliberately don't `await` this — we want
      // runDevServer below to take over stdio immediately so the user
      // sees the boot log. The opener prints its own success/timeout
      // line that interleaves naturally with Vite's output.
      void waitForServerThenOpen(cosUrl);
      await runDevServer(workspaceRoot!);
      return;
    }
  }

  // User declined OR we can't auto-start — print the manual hint.
  p.outro(pc.green("Setup complete."));
  console.log("");
  console.log(pc.bold("Next:"));
  if (canStartDev) {
    console.log(`  ${pc.cyan(`cd ${workspaceRoot}`)} && ${pc.cyan("pnpm dev")}`);
  } else {
    console.log(`  ${pc.cyan("pnpm dev")} ${pc.dim("(from your AgentDash workspace)")}`);
  }
  console.log(`  Open ${pc.cyan(cosUrl)} — your Chief of Staff is ready.`);
}

// ---------- helpers for the optional "start now" prompt ----------

/**
 * Locate the AgentDash *workspace root* — the monorepo top-level that has
 * `pnpm-workspace.yaml` next to a `dev` script. We deliberately do NOT
 * accept any directory with a "dev" script: `cli/package.json` has its
 * own `dev` (which just runs the CLI itself), and pointing the user
 * there would loop instead of starting the server.
 *
 * Search order:
 *   1. walk up from cwd (the bin/agentdash wrapper cd's to repo root,
 *      but `pnpm exec tsx` from inside cli/ leaves cwd at cli/)
 *   2. walk up from this file's location (handles dev mode where
 *      setup.ts lives at <repo>/cli/src/commands/setup.ts)
 *
 * Returns null when neither path is a workspace root. We then fall back
 * to a manual hint instead of risking a misleading auto-start.
 */
function findWorkspaceRoot(): string | null {
  const isWorkspaceRoot = (dir: string): boolean => {
    if (!fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return false;
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) return false;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
      return typeof pkg.scripts?.dev === "string";
    } catch {
      return false;
    }
  };

  // Walk up from `start` looking for the first workspace root. Stops at
  // the filesystem root. Returns null if none found.
  const walkUp = (start: string): string | null => {
    let dir = path.resolve(start);
    while (true) {
      if (isWorkspaceRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };

  const fromCwd = walkUp(process.cwd());
  if (fromCwd) return fromCwd;

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fromSource = walkUp(here);
    if (fromSource) return fromSource;
  } catch {
    // import.meta.url not available in some bundle modes — ignore.
  }

  return null;
}

/**
 * Spawn `pnpm dev` and inherit stdio so the user sees the boot log and
 * can Ctrl-C to stop. Resolves when the child exits — control returns to
 * setup() and then back to the bootstrap script (which suppresses its own
 * post-setup banner in the interactive branch — see scripts/bootstrap.sh).
 */
async function runDevServer(cwd: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["dev"], {
      cwd,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (err) => {
      p.log.error(`Failed to start the dev server: ${err.message}`);
      console.log(`  Try running ${pc.cyan("pnpm dev")} manually from ${pc.dim(cwd)}.`);
      resolve();
    });
    child.on("close", () => resolve());
  });
}

/**
 * Compute the URL the user should land on after the dev server boots:
 *
 *   - `local_trusted`: `/cos` — no auth, single user, drops them
 *     straight into the Chief of Staff conversation.
 *   - `authenticated`: `/?mode=sign_up` — Better Auth's combined
 *     sign-up/sign-in screen; the `?mode=sign_up` query param tells
 *     ui/src/pages/Auth.tsx to default the form to "Create account".
 *
 * Honors whatever port we wrote to config (defaults to 3100). We use
 * `localhost` rather than the bind host so the URL works even when the
 * user is on the same machine as the server but Tailscale isn't
 * currently routing.
 */
function resolveCosUrl(configOpt?: string): string {
  let port = 3100;
  let isAuthenticated = false;
  try {
    const cfg = readConfig(resolveConfigPath(configOpt));
    port = cfg?.server?.port ?? 3100;
    isAuthenticated = cfg?.server?.deploymentMode === "authenticated";
  } catch {
    // Fall through with defaults — better than blowing up the wizard.
  }
  return isAuthenticated
    ? `http://localhost:${port}/?mode=sign_up`
    : `http://localhost:${port}/cos`;
}

/**
 * Poll the dev server's health endpoint and open the user's browser as
 * soon as it's responding. Runs in the background while `pnpm dev`
 * inherits stdio, so the user sees the Vite boot log AND lands in CoS
 * chat without typing anything else.
 *
 * We deliberately swallow all errors — this is a UX nicety, not a
 * correctness path. If we can't open the browser (no DISPLAY, no
 * `open`/`xdg-open` binary, sandboxed CI, etc.) the user still has the
 * URL printed in the outro and can paste it manually.
 */
async function waitForServerThenOpen(cosUrl: string): Promise<void> {
  const healthUrl = cosUrl.replace(/\/cos\/?$/, "/api/health");
  const deadline = Date.now() + 90_000;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        // Newline so our message doesn't smash into Vite's last log line.
        console.log("");
        console.log(pc.cyan(`→ Opening ${cosUrl} in your browser…`));
        console.log("");
        try {
          openUrlInBrowser(cosUrl);
        } catch {
          // openUrlInBrowser already prints its own fallback hint.
        }
        return;
      }
    } catch {
      // Server not up yet — keep polling.
    }
    await sleep(500);
  }
  console.log("");
  console.log(pc.yellow(`! Server didn't respond within 90s — open ${cosUrl} manually once you see "Server listening".`));
  console.log("");
}

// ---------- subcommands (escape hatches for re-running a step) ----------

export async function setupAdapter(opts: AdapterOpts): Promise<void> {
  if (!opts.yes) {
    printPaperclipCliBanner();
    p.intro(pc.cyan("Re-pick adapter"));
  }
  const result = await pickAndVerifyAdapter({ yes: opts.yes, preselected: opts.type });
  if (!result) return;
  // Persist the chosen adapter type so the dashboard can default to it.
  mergePaperclipEnvEntries({ AGENTDASH_DEFAULT_ADAPTER: result.type }, resolvePaperclipEnvFile(opts.config));
  if (!opts.yes) p.outro(pc.green("Done."));
}

export async function setupServer(opts: ServerOpts): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  if (!configExists(configPath)) {
    p.log.error(`No config at ${pc.dim(configPath)}. Run ${pc.cyan("agentdash setup")} first.`);
    return;
  }
  const existing = readConfig(configPath);
  if (!existing) {
    p.log.error(`Config at ${pc.dim(configPath)} couldn't be parsed.`);
    return;
  }

  if (!opts.yes) {
    printPaperclipCliBanner();
    p.intro(pc.cyan("Server reachability"));
  }

  const detectedTailnet = detectTailnetBindHost();
  const detectedBind: BindMode = opts.bind
    ?? (detectedTailnet ? "tailnet" : (existing.server.bind ?? inferBindModeFromHost(existing.server.host)));

  let bind: BindMode;
  if (opts.yes || opts.bind) {
    bind = detectedBind;
    p.log.info(`Bind: ${pc.cyan(bind)}${detectedTailnet ? ` ${pc.dim(`(Tailscale at ${detectedTailnet})`)}` : ""}`);
  } else {
    const picked = await p.select({
      message: "How should the server be reachable?",
      options: [
        { value: "loopback", label: "loopback (localhost only)", hint: "Single-machine, no auth." },
        { value: "lan", label: "lan (any IP)", hint: "Reachable from your LAN." },
        { value: "tailnet", label: "tailnet (Tailscale)", hint: detectedTailnet ? `Detected: ${detectedTailnet}` : "Falls back to loopback if no Tailscale." },
      ],
      initialValue: detectedBind === "custom" ? "loopback" : detectedBind,
    });
    if (p.isCancel(picked)) {
      p.cancel("Setup cancelled.");
      return;
    }
    bind = picked as BindMode;
  }

  if (bind === "custom") {
    p.log.warn("Custom hosts: use `agentdash onboard` for advanced server config.");
    return;
  }

  const port = opts.port ?? existing.server.port ?? 3100;
  const allowedHostnames = collectAllowedHostnames(existing, detectedTailnet, bind);
  const { server, auth } = buildPresetServerConfig(bind, {
    port,
    allowedHostnames,
    serveUi: existing.server.serveUi ?? true,
  });
  writeConfig({ ...existing, server, auth }, configPath);
  p.log.success(`Server: bind=${pc.cyan(bind)} host=${pc.cyan(server.host)} port=${pc.cyan(String(server.port))}`);
}

function collectAllowedHostnames(existing: PaperclipConfig, tailnet: string | undefined, bind: BindMode): string[] {
  const set = new Set<string>(existing.server.allowedHostnames ?? []);
  set.add("localhost");
  set.add("127.0.0.1");
  if (tailnet && bind === "tailnet") set.add(tailnet);
  return Array.from(set);
}

export async function setupBootstrap(opts: BootstrapOpts): Promise<void> {
  if (!opts.yes) {
    printPaperclipCliBanner();
    p.intro(pc.cyan("Bootstrap CEO invite"));
  }
  const result = await bootstrapCeoInvite({
    config: opts.config,
    force: opts.force,
    expiresHours: opts.expiresHours,
    baseUrl: opts.baseUrl,
  });
  if (result.status !== "created" || !result.inviteUrl) return;
  const shouldOpen = opts.open ?? true;
  if (shouldOpen) {
    const opened = openUrlInBrowser(result.inviteUrl);
    if (opened) p.log.message(pc.dim("Opened in your browser."));
    else p.log.warn("Couldn't auto-open — copy/paste the URL above.");
  }
}
