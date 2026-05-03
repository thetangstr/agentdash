// AgentDash: frictionless first-run wizard. Closes GH #94 + the cleanup
// the user asked for after #96 ("we need a frictionless way for user to
// get started").
//
// The default `agentdash setup` flow is two steps, period:
//
//   1. Pick an adapter — verify its binary is on PATH; if not, print the
//      install command and the line that failed.
//   2. Ask for the founding user's email — used as
//      AGENTDASH_BOOTSTRAP_EMAIL so the workspace name + emailDomain
//      derive cleanly on first boot.
//
// Everything else uses safe defaults — embedded Postgres, local-disk
// storage, local-encrypted secrets, loopback bind, local_trusted mode,
// info logging. If the user wants to tune any of those, the existing
// `agentdash onboard` (the older paperclip-inherited wizard) and the
// per-section subcommands below stay around as escape hatches.
//
// Subcommands kept for re-running a single step later:
//   setup server     — switch bind mode (loopback / lan / tailnet)
//   setup bootstrap  — re-issue the CEO invite for authenticated mode
//   setup adapter    — pick + verify a different adapter
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  AGENT_ADAPTER_TYPES,
  inferBindModeFromHost,
  type AgentAdapterType,
  type BindMode,
} from "@paperclipai/shared";
import { configExists, readConfig, resolveConfigPath, writeConfig } from "../config/store.js";
import { buildPresetServerConfig, detectTailnetBindHost } from "../config/server-bind.js";
import { bootstrapCeoInvite } from "./auth-bootstrap-ceo.js";
import { mergePaperclipEnvEntries, resolvePaperclipEnvFile, ensureAgentJwtSecret } from "../config/env.js";
import { openUrlInBrowser } from "../utils/open-url.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import { ADAPTER_CHECKS, checkAdapterBinary, findAdapterCheck } from "../utils/adapter-check.js";
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
  email?: string;
  adapter?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- safe-defaults config builder ----------

/**
 * Build a minimal, valid PaperclipConfig from scratch — used when the user
 * runs `agentdash setup` on a fresh machine with no prior config. Mirrors
 * what `agentdash onboard` produces in quickstart-loopback mode but skips
 * every prompt.
 */
function buildDefaultConfig(): PaperclipConfig {
  const instanceId = resolvePaperclipInstanceId();
  const { server, auth } = buildPresetServerConfig("loopback", {
    port: 3100,
    allowedHostnames: ["localhost", "127.0.0.1"],
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
    case "configured":
      p.log.success(`${spec.label} ready  ${pc.dim(`(${result.detail})`)}`);
      return { type: selected, ok: true, detail: result.detail };
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

// ---------- step 2: get founding user's email ----------

async function getFounderEmail(opts: { yes?: boolean; email?: string }): Promise<string | null> {
  if (opts.email) {
    if (!EMAIL_RE.test(opts.email)) {
      p.log.error(`${pc.cyan(opts.email)} doesn't look like a valid email.`);
      return null;
    }
    p.log.info(`Founding user: ${pc.cyan(opts.email)}`);
    return opts.email;
  }
  if (opts.yes) {
    p.log.error("Refusing to run --yes without --email — the founding user's email is required.");
    return null;
  }
  const value = await p.text({
    message: "Your email (used as the founding user / company owner):",
    placeholder: "you@yourdomain.com",
    validate: (v) => (EMAIL_RE.test(v.trim()) ? undefined : "Please enter a valid email."),
  });
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    return null;
  }
  return value.trim();
}

// ---------- top-level orchestrator ----------

export async function setup(opts: SetupAllOpts): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.cyan("AgentDash setup"));

  const configPath = resolveConfigPath(opts.config);
  const hadConfig = configExists(configPath);
  if (!hadConfig) {
    const fresh = buildDefaultConfig();
    writeConfig(fresh, configPath);
    p.log.info(`Wrote a fresh config at ${pc.dim(configPath)} with safe defaults (loopback, embedded Postgres, local storage).`);
  }

  // Step 1 — adapter
  const adapter = await pickAndVerifyAdapter({ yes: opts.yes, preselected: opts.adapter });
  if (!adapter) return;

  // Step 2 — email
  const email = await getFounderEmail({ yes: opts.yes, email: opts.email });
  if (!email) return;

  // Persist email + JWT secret
  const envPath = resolvePaperclipEnvFile(opts.config);
  mergePaperclipEnvEntries(
    {
      AGENTDASH_BOOTSTRAP_EMAIL: email,
      AGENTDASH_DEFAULT_ADAPTER: adapter.type,
    },
    envPath,
  );
  ensureAgentJwtSecret(opts.config);
  p.log.success(`Saved founding-user email and adapter preference to ${pc.dim(envPath)}`);

  // Done — print next steps
  p.outro(pc.green("Setup complete."));
  console.log("");
  console.log(pc.bold("Next:"));
  console.log(`  ${pc.cyan("pnpm dev")}`);
  console.log(`  Open ${pc.cyan("http://localhost:3100/cos")} — your Chief of Staff is ready.`);
  if (!adapter.ok) {
    console.log("");
    console.log(pc.yellow(`  ⚠  ${adapter.type} isn't installed yet — agents using it will fail until you fix it.`));
    if (adapter.fix) console.log(`    ${pc.cyan("Fix:")} ${adapter.fix}`);
  }
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
