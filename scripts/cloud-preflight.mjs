#!/usr/bin/env node
// AgentDash Cloud go-live preflight (G5). Asserts the environment is safe for a
// public, internet-facing managed deployment before you hand out the URL.
//
//   node scripts/cloud-preflight.mjs           # checks process.env, exits 1 on errors
//
// Pure `cloudPreflight(env)` is exported for unit testing.

const DEV_BYPASSES = [
  "AGENTDASH_BILLING_DISABLED",
  "AGENTDASH_RATE_LIMIT_DISABLED",
  "AGENTDASH_ALLOW_MULTI_COMPANY",
  "AGENTDASH_ADAPTER_ENV_BYPASS",
  "AGENTDASH_REQUIRE_CORP_EMAIL", // not a bypass, but must be a deliberate choice — see note below
  "PAPERCLIP_E2E_SKIP_LLM",
];

// Adapters that need a server-side key to produce real (non-stub) replies.
const LLM_KEY_BY_ADAPTER = {
  claude_api: "ANTHROPIC_API_KEY",
  minimax: "MINIMAX_API_KEY",
  openai_compat: "OPENAI_COMPAT_API_KEY",
};

export function cloudPreflight(env = process.env) {
  const errors = [];
  const warnings = [];
  const get = (k) => (env[k] ?? "").trim();

  if ((env.AGENTDASH_DEPLOYMENT_KIND ?? "cloud").trim() === "on_prem") {
    warnings.push(
      "AGENTDASH_DEPLOYMENT_KIND=on_prem — this is the cloud preflight; use the on-prem guide instead.",
    );
  }

  if (get("PAPERCLIP_DEPLOYMENT_MODE") !== "authenticated") {
    errors.push("PAPERCLIP_DEPLOYMENT_MODE must be 'authenticated' for public cloud.");
  }
  if (get("PAPERCLIP_DEPLOYMENT_EXPOSURE") !== "public") {
    warnings.push("PAPERCLIP_DEPLOYMENT_EXPOSURE is not 'public' — set it for an internet-facing deploy.");
  }

  const secret = get("BETTER_AUTH_SECRET");
  if (!secret) {
    errors.push("BETTER_AUTH_SECRET is required.");
  } else if (secret.length < 32 || secret === "paperclip-dev-secret") {
    errors.push("BETTER_AUTH_SECRET is weak/dev-default — use `openssl rand -hex 32`.");
  }

  if (!get("DATABASE_URL")) {
    errors.push("DATABASE_URL is required (embedded Postgres is dev-only).");
  }

  if (!/^https:\/\//.test(get("PAPERCLIP_AUTH_PUBLIC_BASE_URL"))) {
    errors.push("PAPERCLIP_AUTH_PUBLIC_BASE_URL must be an https:// URL.");
  }

  // LLM must be wired so the CoS never returns stub replies.
  const adapter = get("AGENTDASH_DEFAULT_ADAPTER") || "claude_api";
  const keyVar = LLM_KEY_BY_ADAPTER[adapter];
  if (keyVar) {
    if (!get(keyVar)) {
      errors.push(`LLM adapter '${adapter}' selected but ${keyVar} is unset — CoS would return stub replies.`);
    }
  } else {
    warnings.push(`LLM adapter '${adapter}' has no first-class cloud key check; confirm it returns real replies.`);
  }

  // Dangerous dev bypasses must not be on in public cloud.
  for (const b of DEV_BYPASSES) {
    if (b === "AGENTDASH_REQUIRE_CORP_EMAIL") continue; // informational only
    if (get(b) === "true") {
      errors.push(`${b}=true is a dev bypass and must be unset in public cloud.`);
    }
  }

  // Billing sanity for the usage-based Cloud SKU.
  if (!get("STRIPE_SECRET_KEY")) {
    warnings.push("STRIPE_SECRET_KEY unset — tier caps are bypassed and usage billing cannot charge.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

function main() {
  const result = cloudPreflight(process.env);
  for (const w of result.warnings) console.warn(`⚠️  ${w}`);
  for (const e of result.errors) console.error(`❌ ${e}`);
  if (result.ok) {
    console.log(`✅ Cloud preflight passed${result.warnings.length ? ` (${result.warnings.length} warning(s))` : ""}.`);
    process.exit(0);
  } else {
    console.error(`\nCloud preflight FAILED: ${result.errors.length} error(s).`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
