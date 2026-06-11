#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

function nowIso() {
  return new Date().toISOString();
}

export function normalizeBaseUrl(value) {
  if (!value || typeof value !== "string") throw new Error("--base-url is required");
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function buildHarnessSmokePlan(input = {}) {
  if (!input.companyId || typeof input.companyId !== "string") {
    throw new Error("--company-id is required");
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const companyId = input.companyId;
  const adapters = Array.isArray(input.adapters) ? input.adapters.filter(Boolean) : [];
  const agentIds = Array.isArray(input.agentIds) ? input.agentIds.filter(Boolean) : [];
  return {
    baseUrl,
    companyId,
    adapters,
    agentIds,
    allowWarn: Boolean(input.allowWarn),
    dryRun: Boolean(input.dryRun),
    agentsUrl: `${baseUrl}/api/companies/${encodeURIComponent(companyId)}/agents`,
    testEnvironmentUrl: (adapterType) =>
      `${baseUrl}/api/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(adapterType)}/test-environment`,
  };
}

function cookieHeaderFromJar(content) {
  const cookies = [];
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("\t");
    if (parts.length >= 7) {
      const name = parts[5];
      const value = parts.slice(6).join("\t");
      if (name && value) cookies.push(`${name}=${value}`);
      continue;
    }
    for (const part of trimmed.split(/;\s*/)) {
      const index = part.indexOf("=");
      if (index > 0) cookies.push(`${part.slice(0, index)}=${part.slice(index + 1)}`);
    }
  }
  return cookies.join("; ");
}

function buildHeaders(input = {}) {
  const headers = { Accept: "application/json" };
  const cookie = input.cookie
    ?? process.env.AGENTDASH_SMOKE_COOKIE
    ?? (input.cookieJar ? cookieHeaderFromJar(readFileSync(input.cookieJar, "utf8")) : null);
  if (cookie) headers.Cookie = cookie;
  if (input.bearerToken ?? process.env.AGENTDASH_SMOKE_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${input.bearerToken ?? process.env.AGENTDASH_SMOKE_BEARER_TOKEN}`;
  }
  return headers;
}

export function buildBrowserMutationHeaders(plan, headers = {}) {
  return {
    ...headers,
    Origin: plan.baseUrl,
    Referer: `${plan.baseUrl}/`,
  };
}

function isLaunchRelevantAgent(agent) {
  return agent
    && typeof agent === "object"
    && agent.status !== "terminated"
    && agent.status !== "pending_approval";
}

export function selectSmokeAgents(agents, filters = {}) {
  const adapterSet = new Set(filters.adapters ?? []);
  const agentIdSet = new Set(filters.agentIds ?? []);
  return (Array.isArray(agents) ? agents : [])
    .filter(isLaunchRelevantAgent)
    .filter((agent) => adapterSet.size === 0 || adapterSet.has(agent.adapterType))
    .filter((agent) => agentIdSet.size === 0 || agentIdSet.has(agent.id))
    .map((agent) => ({
      id: String(agent.id),
      name: String(agent.name ?? agent.id),
      adapterType: String(agent.adapterType),
      adapterConfig: agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
        ? agent.adapterConfig
        : {},
      defaultEnvironmentId: typeof agent.defaultEnvironmentId === "string" ? agent.defaultEnvironmentId : null,
    }));
}

export function summarizeSmokeResults(results, options = {}) {
  const summary = results.reduce(
    (next, result) => {
      if (result.status === "pass") next.pass += 1;
      else if (result.status === "warn") next.warn += 1;
      else next.fail += 1;
      return next;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
  return {
    ok: summary.fail === 0 && (options.allowWarn || summary.warn === 0),
    summary,
  };
}

export function applyLaunchHarnessRequirements(result) {
  if (result?.adapterType !== "codex_local") return result;
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const hasControlPlaneReachability = checks.some(
    (check) => check?.code === "codex_control_plane_api_reachable" && check?.level === "info",
  );
  if (hasControlPlaneReachability) return { ...result, checks };
  return {
    ...result,
    status: "fail",
    checks: [
      ...checks,
      {
        code: "codex_control_plane_api_check_missing",
        level: "error",
        message: "codex_local launch smoke requires codex_control_plane_api_reachable evidence",
        hint: "Run saved-agent preflight after configuring PAPERCLIP_API_URL/trusted-local bypass or a callback bridge.",
      },
    ],
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON from ${url}; received: ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
  return body;
}

export async function runHarnessSmoke(input = {}) {
  const plan = buildHarnessSmokePlan(input);
  const headers = buildHeaders(input);
  const agents = selectSmokeAgents(
    await fetchJson(plan.agentsUrl, { headers }),
    { adapters: plan.adapters, agentIds: plan.agentIds },
  );

  const results = [];
  for (const agent of agents) {
    if (plan.dryRun) {
      results.push({
        agentId: agent.id,
        agentName: agent.name,
        adapterType: agent.adapterType,
        status: "pass",
        checks: [{ code: "dry_run", level: "info", message: "Probe not executed" }],
      });
      continue;
    }

    try {
      const result = await fetchJson(plan.testEnvironmentUrl(agent.adapterType), {
        method: "POST",
        headers: {
          ...buildBrowserMutationHeaders(plan, headers),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          adapterConfig: agent.adapterConfig,
          environmentId: agent.defaultEnvironmentId,
        }),
      });
      results.push(applyLaunchHarnessRequirements({
        agentId: agent.id,
        agentName: agent.name,
        adapterType: agent.adapterType,
        status: result?.status === "pass" || result?.status === "warn" ? result.status : "fail",
        checks: Array.isArray(result?.checks) ? result.checks : [],
      }));
    } catch (error) {
      results.push({
        agentId: agent.id,
        agentName: agent.name,
        adapterType: agent.adapterType,
        status: "fail",
        checks: [
          {
            code: "probe_failed",
            level: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }

  const { ok, summary } = summarizeSmokeResults(results, { allowWarn: plan.allowWarn });
  return {
    ok,
    generatedAt: nowIso(),
    baseUrl: plan.baseUrl,
    companyId: plan.companyId,
    dryRun: plan.dryRun,
    allowWarn: plan.allowWarn,
    selectedAgents: agents.length,
    summary,
    results,
  };
}

function printHuman(result) {
  console.log(`Agent harness smoke for ${result.companyId} at ${result.baseUrl}`);
  for (const row of result.results) {
    const firstProblem = row.checks.find((check) => check.level === "error" || check.level === "warn");
    console.log([
      row.status.toUpperCase(),
      row.adapterType,
      row.agentName,
      firstProblem?.message ?? `${row.checks.length} checks`,
    ].join("\t"));
  }
  console.log(`Summary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail`);
}

function printHelp() {
  console.log(`Usage:
  scripts/agent-harness-smoke.sh --base-url <url> --company-id <id> [options]

Options:
  --base-url <url>          Required private AgentDash URL.
  --company-id <id>         Required company id to smoke.
  --adapter <type>          Adapter filter; repeatable.
  --agent-id <id>           Agent filter; repeatable.
  --cookie <cookie>         Cookie header for authenticated private installs. Can also use AGENTDASH_SMOKE_COOKIE.
  --cookie-jar <path>       Netscape/raw cookie jar for authenticated private installs.
  --bearer-token <token>    Bearer token. Can also use AGENTDASH_SMOKE_BEARER_TOKEN.
  --allow-warn              Treat adapter test warnings as non-failing.
  --dry-run                 Select agents and print the plan without executing probes.
  --json                    Print JSON instead of human text.
  --help                    Show help.

Launch invariant:
  codex_local agents must return codex_control_plane_api_reachable. Configure
  PAPERCLIP_API_URL plus trusted-local bypass or a callback bridge before handoff.
`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      "company-id": { type: "string" },
      adapter: { type: "string", multiple: true },
      "agent-id": { type: "string", multiple: true },
      cookie: { type: "string" },
      "cookie-jar": { type: "string" },
      "bearer-token": { type: "string" },
      "allow-warn": { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    printHelp();
    return;
  }
  const result = await runHarnessSmoke({
    baseUrl: values["base-url"],
    companyId: values["company-id"],
    adapters: values.adapter ?? [],
    agentIds: values["agent-id"] ?? [],
    cookie: values.cookie,
    cookieJar: values["cookie-jar"],
    bearerToken: values["bearer-token"],
    allowWarn: values["allow-warn"],
    dryRun: values["dry-run"],
  });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[agent-harness-smoke] ${error.message}`);
    process.exitCode = 1;
  });
}
