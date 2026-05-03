// AgentDash: first-run wizard. Closes GH #94.
//
// `agentdash setup` is the canonical first-run path. It orchestrates three
// focused subcommands:
//
//   setup server     — Tailscale-aware bind mode + allowed hostnames
//   setup bootstrap  — generate the CEO invite and open it in the browser
//   setup adapter    — pick + install an initial agent adapter
//
// Plain `agentdash setup` runs all three in order. Each subcommand is also
// runnable on its own so a user can revisit a step later (e.g. add an
// adapter after the server is up).
//
// Design notes:
// - The server step is a SLIM alternative to `agentdash onboard` for users
//   who only need bind/host config. Power users still have `onboard` for
//   database/LLM/storage prompts.
// - The bootstrap step calls `bootstrapCeoInvite()` directly (which now
//   returns the invite URL) and opens it in the browser unless --no-open.
// - The adapter step doesn't actually install adapter packages globally
//   (paperclip core's responsibility) — it prints the canonical install
//   command for the chosen adapter so the user knows what to run.
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
import { openUrlInBrowser } from "../utils/open-url.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
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
  bind?: BindMode;
  port?: number;
  open?: boolean;
  skipAdapter?: boolean;
  skipBootstrap?: boolean;
}

const ADAPTER_CHOICES: Array<{ value: AgentAdapterType; label: string; install?: string }> = [
  { value: "claude_local", label: "Claude Code (local)", install: "npm install -g @anthropic-ai/claude-code" },
  { value: "codex_local", label: "Codex (local)", install: "npm install -g @openai/codex" },
  { value: "cursor", label: "Cursor (local)" },
  { value: "gemini_local", label: "Gemini (local)" },
  { value: "opencode_local", label: "OpenCode (local)" },
  { value: "pi_local", label: "Pi (local)" },
  { value: "acpx_local", label: "ACPX (local)" },
  { value: "openclaw_gateway", label: "OpenClaw (gateway)" },
  { value: "process", label: "Generic process adapter" },
  { value: "http", label: "Generic HTTP adapter" },
];

// ---------- setup server ----------

export async function setupServer(opts: ServerOpts): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  if (!configExists(configPath)) {
    p.log.error(`No config found at ${pc.dim(configPath)}.`);
    p.log.message(`Run ${pc.cyan("agentdash onboard")} first to create the base config (database, LLM, storage), then come back to ${pc.cyan("agentdash setup")}.`);
    return;
  }
  const existing = readConfig(configPath);
  if (!existing) {
    p.log.error(`Config at ${pc.dim(configPath)} could not be parsed.`);
    return;
  }

  if (!opts.yes) printPaperclipCliBanner();
  p.log.info(pc.cyan("Server reachability"));

  const detectedTailnet = detectTailnetBindHost();
  const detectedBind: BindMode = opts.bind
    ?? (detectedTailnet ? "tailnet" : (existing.server.bind ?? inferBindModeFromHost(existing.server.host)));

  let bind: BindMode;
  if (opts.yes || opts.bind) {
    bind = detectedBind;
    p.log.info(`Using bind mode ${pc.cyan(bind)}${detectedTailnet ? ` (Tailscale detected at ${pc.dim(detectedTailnet)})` : ""}`);
  } else {
    const choices: Array<{ value: BindMode; label: string; hint?: string }> = [
      { value: "loopback", label: "loopback (localhost only)", hint: "Single-machine dev. local_trusted mode — no auth." },
      { value: "lan", label: "lan (any IP)", hint: "Reachable from your LAN. Authenticated mode." },
      { value: "tailnet", label: "tailnet (Tailscale)", hint: detectedTailnet ? `Detected: ${detectedTailnet}` : "No Tailscale detected — falls back to loopback at runtime." },
    ];
    const picked = await p.select({
      message: "How should the server be reachable?",
      options: choices,
      initialValue: detectedBind === "custom" ? "loopback" : detectedBind,
    });
    if (p.isCancel(picked)) {
      p.cancel("Setup cancelled.");
      return;
    }
    bind = picked as BindMode;
  }

  if (bind === "custom") {
    p.log.warn("Custom bind hosts aren't supported by `setup server` — use `agentdash onboard` for advanced server config.");
    return;
  }

  const port = opts.port ?? existing.server.port ?? 3100;
  const allowedHostnames = collectAllowedHostnames(existing, detectedTailnet, bind);

  const { server, auth } = buildPresetServerConfig(bind, {
    port,
    allowedHostnames,
    serveUi: existing.server.serveUi ?? true,
  });

  const next: PaperclipConfig = { ...existing, server, auth };
  writeConfig(next, configPath);
  p.log.success(`Wrote server config to ${pc.dim(configPath)}`);
  p.log.message(`Bind: ${pc.cyan(bind)}  Host: ${pc.cyan(server.host)}  Port: ${pc.cyan(String(server.port))}`);
  if (allowedHostnames.length > 0) {
    p.log.message(`Allowed hostnames: ${pc.dim(allowedHostnames.join(", "))}`);
  }
}

function collectAllowedHostnames(existing: PaperclipConfig, tailnet: string | undefined, bind: BindMode): string[] {
  const set = new Set<string>(existing.server.allowedHostnames ?? []);
  set.add("localhost");
  set.add("127.0.0.1");
  if (tailnet && bind === "tailnet") set.add(tailnet);
  return Array.from(set);
}

// ---------- setup bootstrap ----------

export async function setupBootstrap(opts: BootstrapOpts): Promise<void> {
  if (!opts.yes) {
    printPaperclipCliBanner();
    p.log.info(pc.cyan("Bootstrap CEO invite"));
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
    if (opened) {
      p.log.message(pc.dim("Opened the invite URL in your browser."));
    } else {
      p.log.warn("Could not auto-open the URL — copy/paste it from above.");
    }
  } else {
    p.log.message(pc.dim("Skipping browser auto-open (--no-open)."));
  }
}

// ---------- setup adapter ----------

export async function setupAdapter(opts: AdapterOpts): Promise<void> {
  if (!opts.yes) {
    printPaperclipCliBanner();
    p.log.info(pc.cyan("Adapter selection"));
  }

  let adapter: AgentAdapterType | "skip";
  if (opts.type) {
    if (!AGENT_ADAPTER_TYPES.includes(opts.type as (typeof AGENT_ADAPTER_TYPES)[number])) {
      p.log.error(`Unknown adapter type ${pc.cyan(opts.type)}. Known: ${AGENT_ADAPTER_TYPES.join(", ")}`);
      return;
    }
    adapter = opts.type as AgentAdapterType;
  } else if (opts.yes) {
    p.log.info("Skipping adapter selection in --yes mode. Run `agentdash setup adapter` interactively to pick one.");
    return;
  } else {
    const picked = await p.select({
      message: "Pick an initial adapter to use for your first agent:",
      options: [
        { value: "skip" as const, label: "Skip — pick later from the dashboard" },
        ...ADAPTER_CHOICES.map((c) => ({ value: c.value, label: c.label, hint: c.install })),
      ],
      initialValue: "skip" as const,
    });
    if (p.isCancel(picked)) {
      p.cancel("Setup cancelled.");
      return;
    }
    adapter = picked as AgentAdapterType | "skip";
  }

  if (adapter === "skip") {
    p.log.message(pc.dim("Skipped. You can hire an agent and pick its adapter from the dashboard."));
    return;
  }

  const choice = ADAPTER_CHOICES.find((c) => c.value === adapter);
  p.log.success(`Selected ${pc.cyan(choice?.label ?? adapter)}.`);
  if (choice?.install) {
    p.log.message(`Install the adapter binary if you haven't:`);
    p.log.message(`  ${pc.cyan(choice.install)}`);
  }
  p.log.message(`When you hire your first agent in the dashboard, set ${pc.cyan("adapterType")} to ${pc.cyan(adapter)}.`);
}

// ---------- setup (orchestrator) ----------

export async function setup(opts: SetupAllOpts): Promise<void> {
  printPaperclipCliBanner();
  p.log.info(pc.cyan("First-run setup"));

  // 1. Server
  await setupServer({ config: opts.config, yes: opts.yes, bind: opts.bind, port: opts.port });

  // 2. Bootstrap (only meaningful when server is in authenticated mode)
  if (!opts.skipBootstrap) {
    const cfg = readConfig(resolveConfigPath(opts.config));
    if (cfg?.server.deploymentMode === "authenticated") {
      await setupBootstrap({ config: opts.config, yes: opts.yes, open: opts.open });
    } else {
      p.log.info(pc.dim("Skipping bootstrap step — local_trusted mode doesn't need a CEO invite."));
    }
  }

  // 3. Adapter
  if (!opts.skipAdapter) {
    await setupAdapter({ config: opts.config, yes: opts.yes });
  }

  p.log.success("Setup complete.");
  p.log.message(`Next: ${pc.cyan("pnpm dev")} (or ${pc.cyan("agentdash run")}) to start the server.`);
}
